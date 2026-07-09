use std::path::PathBuf;
use std::sync::mpsc as std_mpsc;
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc as tokio_mpsc;

use crate::audio::capture::AudioCapture;
use crate::engineer::query_publisher::publish_query;
use crate::state::AppState;
use crate::stt::{is_speech, WhisperStt};

fn model_path() -> PathBuf {
    std::env::var("WHISPER_MODEL_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("models/ggml-base.en.bin"))
}

/// Wire the push-to-talk pipeline: capture (gated by `ptt_rx`) → local Whisper STT
/// on a dedicated thread that owns the model → publish EngineerQuery. Degrades
/// gracefully — a missing model or capture failure disables PTT with a logged
/// warning and never crashes the app (FR-005). Must be called inside the tokio
/// runtime (AudioCapture spawns a task).
pub fn spawn_ptt_pipeline(
    app_handle: AppHandle,
    redis_url: String,
    ptt_rx: tokio_mpsc::Receiver<bool>,
) {
    // The input device follows the watch channel (T012): a selection in the
    // Audio tab rebuilds the capture stream live, no restart.
    let input_rx = app_handle
        .state::<AppState>()
        .audio_input_watch_tx
        .subscribe();

    // Capture pushes each released clip to the STT worker over a std channel, which
    // keeps the WhisperContext on one thread (no Send-across-await requirement).
    let (audio_tx, audio_rx) = std_mpsc::channel::<(Vec<f32>, u32)>();

    let capture = AudioCapture::new(input_rx);
    let on_audio = move |samples: Vec<f32>, rate: u32| {
        let _ = audio_tx.send((samples, rate));
    };
    if let Err(e) = capture.start(app_handle.clone(), ptt_rx, on_audio) {
        tracing::error!(error = %e, "[stt] failed to start audio capture — PTT disabled");
        return;
    }

    let path = model_path();
    // M10 T028/C3: publish the Whisper load outcome for the Debug tab's
    // tri-state (loading → Ready | Load failed).
    let whisper_debug = app_handle.state::<AppState>().debug.clone();
    std::thread::spawn(move || {
        use crate::telemetry::debug_snapshot::{WHISPER_FAILED, WHISPER_READY};
        let stt = match WhisperStt::load(&path) {
            Ok(s) => s,
            Err(e) => {
                whisper_debug
                    .whisper_status
                    .store(WHISPER_FAILED, std::sync::atomic::Ordering::Relaxed);
                tracing::error!(error = %e, path = %path.display(), "[stt] whisper model unavailable — STT disabled");
                return;
            }
        };
        whisper_debug
            .whisper_status
            .store(WHISPER_READY, std::sync::atomic::Ordering::Relaxed);
        tracing::info!("[stt] Whisper base.en loaded — PTT ready");
        while let Ok((samples, rate)) = audio_rx.recv() {
            match stt.transcribe(&samples, rate) {
                Ok(t) if is_speech(&t) => {
                    let redis_url = redis_url.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = publish_query(&redis_url, t).await {
                            tracing::error!(error = %e, "[stt] failed to publish PTT query");
                        }
                    });
                }
                Ok(t) => {
                    tracing::info!(reason = "empty-transcription", transcript = %t, "[stt] no speech — not published");
                }
                Err(e) => {
                    tracing::error!(error = %e, reason = "stt-failure", "[stt] transcription failed");
                }
            }
        }
    });
}
