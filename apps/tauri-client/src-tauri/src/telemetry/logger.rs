//! M10 US7 (T030/T031): opt-in raw telemetry logging. An isolated async NDJSON
//! writer behind a bounded channel — the real-time path only ever `try_send`s
//! (FR-020: channel-full drops the frame; nothing on the alert path blocks).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use crate::iracing::types::{TelemetryField, TelemetryValue};

pub const CHANNEL_CAPACITY: usize = 1000;
/// US7 scenario 2: toggle-off drains queued frames within 500ms (or ~instantly
/// when the channel is already empty — well under the 100ms bound).
pub const DRAIN_TIMEOUT: Duration = Duration::from_millis(500);

/// data-model.md TelemetryLogFrame — camelCase NDJSON. `lapTimeDelta` is
/// intentionally absent (derived value, debug display only — FR-019/F3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryLogFrame {
    pub ts: u64,
    pub session_id: String,
    pub fuel: f64,
    pub lap_dist_pct: f64,
    pub lap: i32,
    pub speed: f64,
    pub gear: i32,
    pub rpm: f64,
    pub throttle: f64,
    pub brake: f64,
    pub lat_accel: f64,
    pub lon_accel: f64,
}

/// telemetry:log-warning payloads (T032 maps each reason to a distinct banner).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "reason", rename_all = "kebab-case")]
pub enum LogWarning {
    ChannelFull { dropped: u64 },
    DiskFull { detail: String },
    DrainTimeout { frames_discarded: u64 },
}

pub enum LoggerControl {
    Enable { dir: PathBuf },
    Disable,
}

#[derive(Clone)]
pub struct LoggerHandle {
    frame_tx: mpsc::Sender<TelemetryLogFrame>,
    control_tx: mpsc::UnboundedSender<LoggerControl>,
    warn_tx: mpsc::UnboundedSender<LogWarning>,
    dropped: Arc<AtomicU64>,
    capacity: usize,
}

impl LoggerHandle {
    /// FR-020: strictly non-blocking. Channel-full drops the incoming frame,
    /// bumps the dropped counter, and emits a channel-full warning.
    pub fn log_frame(&self, frame: TelemetryLogFrame) {
        if self.frame_tx.try_send(frame).is_err() {
            let dropped = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = self.warn_tx.send(LogWarning::ChannelFull { dropped });
        }
    }

    pub fn set_enabled(&self, enabled: bool, dir: PathBuf) {
        let _ = self.control_tx.send(if enabled {
            LoggerControl::Enable { dir }
        } else {
            LoggerControl::Disable
        });
    }

    /// (occupancy, capacity) — the T030/C1 SC-008 measurement observable.
    pub fn channel_depth(&self) -> (usize, usize) {
        (self.capacity - self.frame_tx.capacity(), self.capacity)
    }
}

/// T031/U2 + C4: validate the log directory at TOGGLE time, distinguishing the
/// two user-facing failure cases (uncreatable vs. exists-but-readonly).
pub fn validate_log_dir(dir: &str) -> Result<PathBuf, String> {
    if dir.is_empty() {
        return Err(
            "cannot create log directory: path unresolved (app data dir unavailable at startup)"
                .into(),
        );
    }
    let path = PathBuf::from(dir);
    std::fs::create_dir_all(&path).map_err(|e| format!("cannot create log directory: {e}"))?;
    // Write-permission probe: create + delete a temp file.
    let probe = path.join(".write-probe");
    match std::fs::write(&probe, b"probe") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            Ok(path)
        }
        Err(e) => Err(format!("log directory is not writable: {e}")),
    }
}

/// U4: sessionId from the SessionNum telemetry variable; "unknown" until the
/// first frame carries it. A2: the log FILE is never renamed once created —
/// `iracing-telemetry-unknown-*.ndjson` is acceptable; frames carry the
/// canonical id.
pub fn frame_from_fields(fields: &[TelemetryField], ts: u64) -> TelemetryLogFrame {
    let num = |name: &str| -> Option<f64> {
        fields
            .iter()
            .find(|f| f.name == name)
            .and_then(|f| match &f.value {
                TelemetryValue::Float(v) => Some(*v as f64),
                TelemetryValue::Double(v) => Some(*v),
                TelemetryValue::Int(v) => Some(*v as f64),
                _ => None,
            })
    };
    TelemetryLogFrame {
        ts,
        session_id: num("SessionNum")
            .map(|v| format!("{}", v as i64))
            .unwrap_or_else(|| "unknown".into()),
        fuel: num("FuelLevel").unwrap_or(0.0),
        lap_dist_pct: num("LapDistPct").unwrap_or(0.0),
        lap: num("Lap").unwrap_or(0.0) as i32,
        speed: num("Speed").unwrap_or(0.0),
        gear: num("Gear").unwrap_or(0.0) as i32,
        rpm: num("RPM").unwrap_or(0.0),
        throttle: num("Throttle").unwrap_or(0.0),
        brake: num("Brake").unwrap_or(0.0),
        lat_accel: num("LatAccel").unwrap_or(0.0),
        lon_accel: num("LongAccel").unwrap_or(0.0),
    }
}

/// `YYYYMMDD-HHmmss` from unix seconds (UTC) — no chrono dependency (plan F4:
/// no new crates). Civil-from-days per Howard Hinnant's algorithm.
pub fn format_timestamp(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let secs_of_day = unix_secs % 86_400;
    let (h, m, s) = (
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    );
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}{month:02}{d:02}-{h:02}{m:02}{s:02}")
}

fn log_file_path(dir: &Path, session_id: &str, unix_secs: u64) -> PathBuf {
    dir.join(format!(
        "iracing-telemetry-{session_id}-{}.ndjson",
        format_timestamp(unix_secs)
    ))
}

struct OpenLog {
    file: tokio::fs::File,
    session_id: String,
}

/// Spawn the isolated writer task. `capacity` is injectable for tests.
pub fn spawn_logger(capacity: usize) -> (LoggerHandle, mpsc::UnboundedReceiver<LogWarning>) {
    let (frame_tx, mut frame_rx) = mpsc::channel::<TelemetryLogFrame>(capacity);
    let (control_tx, mut control_rx) = mpsc::unbounded_channel::<LoggerControl>();
    let (warn_tx, warn_rx) = mpsc::unbounded_channel::<LogWarning>();
    // Sender clone for the in-task depth metric (Receiver has no capacity()).
    let depth_tx = frame_tx.clone();
    let handle = LoggerHandle {
        frame_tx,
        control_tx,
        warn_tx: warn_tx.clone(),
        dropped: Arc::new(AtomicU64::new(0)),
        capacity,
    };

    // tauri::async_runtime, NOT bare tokio::spawn: this function is called
    // synchronously from the setup closure (no tokio context on that thread) —
    // a bare tokio::spawn panics with "there is no reactor running" and killed
    // the app at startup (regression test below).
    tauri::async_runtime::spawn(async move {
        let mut enabled_dir: Option<PathBuf> = None;
        let mut open: Option<OpenLog> = None;
        let mut depth_ticker = tokio::time::interval(Duration::from_secs(1));
        depth_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        async fn write_frame(
            open: &mut Option<OpenLog>,
            enabled_dir: &Option<PathBuf>,
            frame: TelemetryLogFrame,
            warn_tx: &mpsc::UnboundedSender<LogWarning>,
        ) -> bool {
            let Some(dir) = enabled_dir else { return true };
            // New file per session: lazily open, rotate on SessionNum change
            // (only once the id is known — "unknown" never forces a rotation
            // away from a real id file).
            let needs_open = match open {
                None => true,
                Some(o) => o.session_id != frame.session_id && frame.session_id != "unknown",
            };
            if needs_open {
                if let Some(o) = open.take() {
                    let mut f = o.file;
                    let _ = f.flush().await;
                }
                let path = log_file_path(dir, &frame.session_id, frame.ts / 1000);
                match tokio::fs::File::create(&path).await {
                    Ok(file) => {
                        tracing::info!(path = %path.display(), "[telemetry-log] log file opened");
                        *open = Some(OpenLog {
                            file,
                            session_id: frame.session_id.clone(),
                        });
                    }
                    Err(e) => {
                        let _ = warn_tx.send(LogWarning::DiskFull {
                            detail: e.to_string(),
                        });
                        return false; // stop logging (T030 disk-full behavior)
                    }
                }
            }
            if let Some(o) = open.as_mut() {
                let mut line = match serde_json::to_vec(&frame) {
                    Ok(v) => v,
                    Err(_) => return true,
                };
                line.push(b'\n');
                if let Err(e) = o.file.write_all(&line).await {
                    let _ = warn_tx.send(LogWarning::DiskFull {
                        detail: e.to_string(),
                    });
                    return false;
                }
            }
            true
        }

        loop {
            tokio::select! {
                Some(ctrl) = control_rx.recv() => match ctrl {
                    LoggerControl::Enable { dir } => {
                        enabled_dir = Some(dir);
                    }
                    LoggerControl::Disable => {
                        // T031/C3+A3: immediate drain-and-close — flush frames
                        // already enqueued (bounded by DRAIN_TIMEOUT), then
                        // close cleanly. Never waits for session end.
                        let drain = async {
                            while let Ok(frame) = frame_rx.try_recv() {
                                if !write_frame(&mut open, &enabled_dir, frame, &warn_tx).await {
                                    break;
                                }
                            }
                        };
                        if tokio::time::timeout(DRAIN_TIMEOUT, drain).await.is_err() {
                            let mut discarded = 0u64;
                            while frame_rx.try_recv().is_ok() {
                                discarded += 1;
                            }
                            tracing::warn!(
                                event = "telemetry-log-drain-timeout",
                                framesDiscarded = discarded,
                                "drain timeout — discarding queued frames"
                            );
                            let _ = warn_tx.send(LogWarning::DrainTimeout {
                                frames_discarded: discarded,
                            });
                        }
                        if let Some(o) = open.take() {
                            let mut f = o.file;
                            let _ = f.flush().await;
                            let _ = f.sync_all().await;
                        }
                        enabled_dir = None;
                    }
                },
                Some(frame) = frame_rx.recv() => {
                    if enabled_dir.is_some() {
                        if !write_frame(&mut open, &enabled_dir, frame, &warn_tx).await {
                            enabled_dir = None; // disk failure → logging stops
                        }
                    }
                    // Disabled: frames are consumed and discarded so the
                    // channel never backs up while the toggle is off.
                }
                _ = depth_ticker.tick() => {
                    // T030/C1 (SC-008 observable): 1Hz channel-depth metric
                    // while logging is active.
                    if enabled_dir.is_some() {
                        tracing::debug!(
                            event = "telemetry-log-channel-depth",
                            depth = capacity - depth_tx.capacity(),
                            capacity,
                            "logging channel occupancy"
                        );
                    }
                }
            }
        }
    });

    (handle, warn_rx)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(session_id: &str, ts: u64) -> TelemetryLogFrame {
        TelemetryLogFrame {
            ts,
            session_id: session_id.into(),
            fuel: 18.5,
            lap_dist_pct: 0.42,
            lap: 7,
            speed: 51.3,
            gear: 4,
            rpm: 6250.0,
            throttle: 0.83,
            brake: 0.0,
            lat_accel: 1.4,
            lon_accel: -0.2,
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("irc-logger-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Regression (Windows startup crash, 2026-07-09): spawn_logger is called
    /// synchronously from Tauri's setup closure — a plain thread with NO tokio
    /// runtime context. A bare tokio::spawn inside it panics with "there is no
    /// reactor running" and kills the app right after logging init. This test
    /// deliberately has no #[tokio::test] runtime.
    #[test]
    fn spawn_logger_works_outside_a_tokio_runtime() {
        let (handle, _warn_rx) = spawn_logger(4);
        // The handle's non-async surface must also be safe from here.
        handle.log_frame(frame("1", 0));
        let (_depth, capacity) = handle.channel_depth();
        assert_eq!(capacity, 4);
    }

    /// T033: NDJSON round-trip — the frame the analyzer reads equals the frame
    /// the writer serialized (camelCase field names per data-model.md).
    #[test]
    fn frame_ndjson_round_trip() {
        let f = frame("12", 1_700_000_000_000);
        let json = serde_json::to_string(&f).unwrap();
        assert!(json.contains("\"sessionId\":\"12\""));
        assert!(json.contains("\"lapDistPct\""));
        assert!(
            !json.contains("lapTimeDelta"),
            "derived value is not logged (FR-019/F3)"
        );
        let back: TelemetryLogFrame = serde_json::from_str(&json).unwrap();
        assert_eq!(f, back);
    }

    #[test]
    fn timestamp_format_is_civil_utc() {
        // 2026-07-03 14:30:05 UTC (verified: date -u -r 1783089005)
        assert_eq!(format_timestamp(1_783_089_005), "20260703-143005");
        assert_eq!(format_timestamp(0), "19700101-000000");
    }

    /// T033/G4: the two path-validation failures produce their DISTINCT
    /// user-facing messages (T032 renders them differently).
    #[test]
    fn validate_log_dir_error_taxonomy() {
        let err = validate_log_dir("").expect_err("sentinel path must fail");
        assert!(err.starts_with("cannot create log directory:"), "{err}");

        let err =
            validate_log_dir("/dev/null/not-a-dir/child").expect_err("uncreatable path must fail");
        assert!(err.starts_with("cannot create log directory:"), "{err}");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = temp_dir("readonly");
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
            let err = validate_log_dir(dir.to_str().unwrap())
                .expect_err("readonly dir must fail the write probe");
            assert!(err.starts_with("log directory is not writable:"), "{err}");
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// T033: channel-full drops without panic and emits the warning event.
    #[tokio::test]
    async fn channel_full_drops_and_warns() {
        let (handle, mut warn_rx) = spawn_logger(2);
        // Logger is DISABLED but we flood faster than the task drains — with
        // capacity 2, at least one try_send hits a full channel.
        for i in 0..200 {
            handle.log_frame(frame("1", i));
        }
        let warning = tokio::time::timeout(Duration::from_secs(1), warn_rx.recv())
            .await
            .expect("a channel-full warning must arrive")
            .unwrap();
        assert!(matches!(warning, LogWarning::ChannelFull { dropped } if dropped >= 1));
    }

    /// T033: enable → frames written as parseable NDJSON → disable closes the
    /// file cleanly (complete lines, nothing truncated), within the A3 bound.
    #[tokio::test]
    async fn writes_and_closes_cleanly_within_drain_bound() {
        let dir = temp_dir("write");
        let (handle, _warn_rx) = spawn_logger(64);
        handle.set_enabled(true, dir.clone());
        // Let the Enable control land before frames — a pre-enable frame is
        // (correctly) discarded, which would undercount the file's lines.
        tokio::time::sleep(Duration::from_millis(20)).await;
        for i in 0..10 {
            handle.log_frame(frame("7", 1_700_000_000_000 + i));
        }
        tokio::time::sleep(Duration::from_millis(100)).await; // let the writer run

        let started = std::time::Instant::now();
        handle.set_enabled(false, dir.clone());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            started.elapsed() < DRAIN_TIMEOUT + Duration::from_millis(100),
            "drain-and-close must complete within the 500ms bound"
        );

        let entries: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("iracing-telemetry-7-")
            })
            .collect();
        assert_eq!(entries.len(), 1, "one log file for the session");
        let content = std::fs::read_to_string(entries[0].path()).unwrap();
        let lines: Vec<_> = content.lines().collect();
        assert_eq!(lines.len(), 10);
        for line in lines {
            let parsed: TelemetryLogFrame =
                serde_json::from_str(line).expect("complete NDJSON line");
            assert_eq!(parsed.session_id, "7");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// T033/A3: an EMPTY channel drains near-instantly on stop (≪ 100ms).
    #[tokio::test]
    async fn empty_channel_stop_is_immediate() {
        let dir = temp_dir("empty");
        let (handle, _warn_rx) = spawn_logger(64);
        handle.set_enabled(true, dir.clone());
        tokio::time::sleep(Duration::from_millis(20)).await;
        let started = std::time::Instant::now();
        handle.set_enabled(false, dir.clone());
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(started.elapsed() < Duration::from_millis(100));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// U4/A2: frames before SessionNum arrives carry "unknown"; the file is
    /// NOT renamed once the real id shows up — a new session id rotates to a
    /// new file instead.
    #[tokio::test]
    async fn unknown_session_then_rotation() {
        let dir = temp_dir("rotate");
        let (handle, _warn_rx) = spawn_logger(64);
        handle.set_enabled(true, dir.clone());
        // Let the Enable control land before the first frame — select! order
        // is otherwise unspecified and a pre-enable frame is (correctly)
        // discarded rather than logged.
        tokio::time::sleep(Duration::from_millis(20)).await;
        handle.log_frame(frame("unknown", 1_700_000_000_000));
        tokio::time::sleep(Duration::from_millis(50)).await;
        handle.log_frame(frame("3", 1_700_000_001_000));
        tokio::time::sleep(Duration::from_millis(50)).await;
        handle.set_enabled(false, dir.clone());
        tokio::time::sleep(Duration::from_millis(50)).await;

        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().any(|n| n.contains("-unknown-")), "{names:?}");
        assert!(names.iter().any(|n| n.contains("-3-")), "{names:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
