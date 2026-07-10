use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tokio::sync::{mpsc, watch};

/// Minimum interval between `audio:mic-level` emissions — ~10Hz, the FR-005
/// floor. Wall-clock based (T012/A3): an every-Nth-frame throttle undershoots
/// 10Hz at common cpal buffer sizes.
const MIC_LEVEL_INTERVAL_MS: u64 = 100;

#[derive(Debug, Clone, Serialize)]
struct MicLevelPayload {
    level: f32,
}

/// Normalized RMS of one PCM frame, clamped to 0.0–1.0 (f32 samples are
/// already in [-1, 1]).
pub(crate) fn rms_level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mean_sq = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
    mean_sq.sqrt().min(1.0)
}

/// Wall-clock emission throttle for the mic level meter.
pub(crate) struct EmitThrottle {
    last_ms: AtomicU64,
}

impl EmitThrottle {
    pub(crate) fn new() -> Self {
        Self {
            last_ms: AtomicU64::new(0),
        }
    }

    pub(crate) fn should_emit(&self, now_ms: u64) -> bool {
        let last = self.last_ms.load(Ordering::Relaxed);
        if now_ms.saturating_sub(last) >= MIC_LEVEL_INTERVAL_MS {
            self.last_ms.store(now_ms, Ordering::Relaxed);
            true
        } else {
            false
        }
    }
}

fn wall_clock_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// One PCM frame through the capture data path: buffer while the PTT gate is
/// held, and report the (throttled) mic level. Split out so tests can drive it
/// with synthetic frames — no audio hardware or Tauri app required (T016/E3).
///
/// Note (T012/A1): the level is emitted regardless of the PTT gate — the M5
/// stream runs continuously, so the meter indicates device liveness only. It
/// MUST NOT be read as a PTT-state signal (that is T023's indicator).
pub(crate) fn handle_frame(
    data: &[f32],
    recording: &AtomicBool,
    buffer: &Mutex<Vec<f32>>,
    throttle: &EmitThrottle,
    now_ms: u64,
    emit_level: &dyn Fn(f32),
) {
    if recording.load(Ordering::Relaxed) {
        if let Ok(mut buf) = buffer.lock() {
            buf.extend_from_slice(data);
        }
    }
    if throttle.should_emit(now_ms) {
        emit_level(rms_level(data));
    }
}

pub struct AudioCapture {
    device_rx: watch::Receiver<Option<String>>,
}

impl AudioCapture {
    /// `device_rx` carries the selected input device name (None = system
    /// default); `set_audio_device` (T011) sends changes here.
    pub fn new(device_rx: watch::Receiver<Option<String>>) -> Self {
        Self { device_rx }
    }

    /// Start capture. A dedicated OS thread owns the (!Send) cpal stream and
    /// rebuilds it whenever the selected input device changes (T012); the PTT
    /// gate task and the STT hand-off are unchanged from M5. An initial build
    /// failure does NOT kill the pipeline — the thread keeps waiting for the
    /// next device selection, so plugging in / selecting a mic later recovers.
    pub fn start(
        &self,
        app: tauri::AppHandle,
        mut ptt_rx: mpsc::Receiver<bool>, // true = pressed, false = released
        on_audio: impl Fn(Vec<f32>, u32) + Send + 'static,
    ) -> Result<()> {
        let buffer: Arc<Mutex<Vec<f32>>> = Arc::default();
        let recording = Arc::new(AtomicBool::new(false));
        // The sample rate follows the active device across rebuilds; the PTT
        // release reads the current value so STT gets the right rate.
        let sample_rate = Arc::new(AtomicU32::new(48_000));

        {
            let buffer = buffer.clone();
            let recording = recording.clone();
            let sample_rate = sample_rate.clone();
            tokio::spawn(async move {
                while let Some(pressed) = ptt_rx.recv().await {
                    if pressed {
                        buffer.lock().unwrap().clear();
                        recording.store(true, Ordering::Relaxed);
                    } else {
                        recording.store(false, Ordering::Relaxed);
                        let samples = buffer.lock().unwrap().drain(..).collect::<Vec<_>>();
                        if !samples.is_empty() {
                            on_audio(samples, sample_rate.load(Ordering::Relaxed));
                        }
                    }
                }
            });
        }

        // Bridge the tokio watch into a std channel so the stream thread can
        // block on device changes without a runtime.
        let (bridge_tx, bridge_rx) = std::sync::mpsc::channel::<Option<String>>();
        let initial = self.device_rx.borrow().clone();
        {
            let mut rx = self.device_rx.clone();
            tokio::spawn(async move {
                while rx.changed().await.is_ok() {
                    let name = rx.borrow().clone();
                    if bridge_tx.send(name).is_err() {
                        break;
                    }
                }
            });
        }

        std::thread::spawn(move || {
            let throttle = Arc::new(EmitThrottle::new());
            let mut current = initial;
            loop {
                // Held for the lifetime of one device selection; dropped (which
                // stops capture AND mic-level emission) before each rebuild.
                let stream = match build_input_stream(
                    current.as_deref(),
                    buffer.clone(),
                    recording.clone(),
                    sample_rate.clone(),
                    throttle.clone(),
                    app.clone(),
                ) {
                    Ok(s) => {
                        tracing::info!(device = ?current, "[audio] input stream running");
                        Some(s)
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, device = ?current, "[audio] input stream unavailable — waiting for a device selection");
                        None
                    }
                };
                match bridge_rx.recv() {
                    Ok(next) => {
                        tracing::info!(device = ?next, "[audio] input device changed — reinitializing capture stream");
                        drop(stream);
                        current = next;
                    }
                    Err(_) => break, // watch bridge gone — app shutting down
                }
            }
        });

        Ok(())
    }
}

fn build_input_stream(
    device_name: Option<&str>,
    buffer: Arc<Mutex<Vec<f32>>>,
    recording: Arc<AtomicBool>,
    sample_rate: Arc<AtomicU32>,
    throttle: Arc<EmitThrottle>,
    app: tauri::AppHandle,
) -> Result<cpal::Stream> {
    let host = cpal::default_host();
    let device = match device_name {
        Some(name) => host
            .input_devices()?
            .find(|d| d.name().ok().as_deref() == Some(name))
            .ok_or_else(|| anyhow::anyhow!("device not found: {name}"))?,
        None => host
            .default_input_device()
            .ok_or_else(|| anyhow::anyhow!("no default input device"))?,
    };

    let config = device.default_input_config()?;
    sample_rate.store(config.sample_rate().0, Ordering::Relaxed);

    let stream = device.build_input_stream(
        &config.into(),
        move |data: &[f32], _| {
            handle_frame(
                data,
                &recording,
                &buffer,
                &throttle,
                wall_clock_ms(),
                &|level| {
                    let _ = app.emit("audio:mic-level", MicLevelPayload { level });
                },
            );
        },
        |err| tracing::error!("audio capture error: {err}"),
        None,
    )?;
    stream.play()?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rms_level_of_known_amplitude() {
        // A constant-amplitude frame has RMS equal to that amplitude.
        let frame = vec![0.5f32; 480];
        assert!((rms_level(&frame) - 0.5).abs() < 1e-6);
        // Silence → 0; empty → 0 (no NaN).
        assert_eq!(rms_level(&vec![0.0f32; 480]), 0.0);
        assert_eq!(rms_level(&[]), 0.0);
    }

    #[test]
    fn throttle_enforces_100ms_floor() {
        let t = EmitThrottle::new();
        assert!(t.should_emit(1_000)); // first frame always emits
        assert!(!t.should_emit(1_050)); // 50ms later — suppressed
        assert!(t.should_emit(1_100)); // 100ms later — emits (10Hz floor)
        assert!(!t.should_emit(1_199));
        assert!(t.should_emit(1_200));
    }

    /// T016/E3: a synthetic non-silent frame through the capture data path
    /// emits a non-zero `audio:mic-level` value immediately (well within the
    /// 200ms bound) — verified without audio hardware or a Tauri app by
    /// driving `handle_frame` directly, the same function the cpal callback
    /// calls.
    #[test]
    fn synthetic_frame_emits_nonzero_level() {
        let recording = AtomicBool::new(true);
        let buffer = Mutex::new(Vec::new());
        let throttle = EmitThrottle::new();
        let emitted = Mutex::new(Vec::<f32>::new());

        let frame = vec![0.25f32; 512];
        handle_frame(&frame, &recording, &buffer, &throttle, 5_000, &|level| {
            emitted.lock().unwrap().push(level);
        });

        let levels = emitted.lock().unwrap();
        assert_eq!(levels.len(), 1, "one throttled emission expected");
        assert!(
            levels[0] > 0.0,
            "non-silent frame must report a non-zero level"
        );
        // And the PTT gate buffered the samples while recording.
        assert_eq!(buffer.lock().unwrap().len(), 512);
    }

    #[test]
    fn level_emitted_even_when_not_recording() {
        // T012/A1: the meter is device liveness, not PTT state — emission is
        // not gated on the recording flag (and nothing is buffered).
        let recording = AtomicBool::new(false);
        let buffer = Mutex::new(Vec::new());
        let throttle = EmitThrottle::new();
        let emitted = Mutex::new(Vec::<f32>::new());

        handle_frame(
            &vec![0.1f32; 64],
            &recording,
            &buffer,
            &throttle,
            9_000,
            &|level| {
                emitted.lock().unwrap().push(level);
            },
        );

        assert_eq!(emitted.lock().unwrap().len(), 1);
        assert!(buffer.lock().unwrap().is_empty());
    }
}
