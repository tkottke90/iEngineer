use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

use crate::iracing::sdk::IracingSDK;
use crate::iracing::types::{ConnectionStatus, SessionInfo};
use crate::state::AppState;

/// Main loop sleep; determines tick rate (10 Hz)
const TICK_SLEEP: Duration = Duration::from_millis(100);
/// How many ticks between full connection polls (5 × 100 ms = 500 ms)
const CONNECT_EVERY_N_TICKS: u32 = 5;

fn wall_clock_hms() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{h:02}:{m:02}:{s:02}")
}

fn parse_session_info(yaml: &str) -> SessionInfo {
    let doc: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap_or(serde_yaml::Value::Null);

    let get_str = |keys: &[&str]| -> String {
        let mut cur = &doc;
        for k in keys {
            cur = match cur.get(k) {
                Some(v) => v,
                None => return "unknown".into(),
            };
        }
        cur.as_str().unwrap_or("unknown").to_string()
    };

    // Drivers is a YAML sequence — must use numeric index, not string key.
    let car_name = doc
        .get("DriverInfo")
        .and_then(|d| d.get("Drivers"))
        .and_then(|d| d.get(0usize))
        .and_then(|d| d.get("CarScreenNameShort"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    SessionInfo {
        track_name: get_str(&["WeekendInfo", "TrackName"]),
        session_type: get_str(&["WeekendInfo", "EventType"]),
        car_name,
        wall_clock_time: wall_clock_hms(),
    }
}

fn emit_disconnected(handle: &AppHandle) {
    info!("connection status → Disconnected");
    {
        let state = handle.state::<AppState>();
        let _ = state.iracing_status.send(ConnectionStatus::Disconnected);
        let mut s = state.current_session.lock().unwrap();
        *s = None;
    }
    let _ = handle.emit("iracing://status-changed", ConnectionStatus::Disconnected);
    let _ = handle.emit("iracing://session-changed", Option::<SessionInfo>::None);
}

pub fn spawn_connection_watcher(handle: AppHandle) {
    std::thread::spawn(move || {
        let mut was_connected = false;
        let mut last_session_update: i32 = -1;
        let mut tick: u32 = 0;

        loop {
            std::thread::sleep(TICK_SLEEP);
            tick = tick.wrapping_add(1);

            let is_connection_poll_tick = tick % CONNECT_EVERY_N_TICKS == 0;

            // Open SDK to get a fresh snapshot of shared memory.
            // On Windows this is ~4 syscalls + 1 MB copy; negligible for a dev tool.
            // On non-Windows open() always fails, so we just log + skip below.
            let sdk = match IracingSDK::open() {
                Ok(s) => s,
                Err(e) => {
                    if is_connection_poll_tick {
                        warn!("iRacing shared memory unavailable: {e}");
                        if was_connected {
                            emit_disconnected(&handle);
                            was_connected = false;
                            last_session_update = -1;
                        }
                    }
                    continue;
                }
            };

            let connected = sdk.is_connected();

            // ── Connection transitions (only emit on change) ───────────────
            if connected && !was_connected {
                info!("connection status → Connected");
                {
                    let state = handle.state::<AppState>();
                    let _ = state.iracing_status.send(ConnectionStatus::Connected);
                }
                let _ = handle.emit("iracing://status-changed", ConnectionStatus::Connected);
                was_connected = true;
            } else if !connected && was_connected {
                emit_disconnected(&handle);
                was_connected = false;
                last_session_update = -1;
                continue;
            }

            if !connected {
                continue;
            }

            // ── Session / field cache ──────────────────────────────────────
            let session_update = sdk.session_info_update();
            if session_update != last_session_update {
                last_session_update = session_update;

                let mut sdk_mut = sdk;
                let fields = sdk_mut.enumerate_vars();
                {
                    let state = handle.state::<AppState>();
                    *state.field_cache.lock().unwrap() = fields;
                }

                let session_info = sdk_mut.read_session_info().map(|yaml| {
                    let info = parse_session_info(&yaml);
                    info!(
                        "session changed: {} @ {}",
                        info.session_type, info.track_name
                    );
                    info
                });
                {
                    let state = handle.state::<AppState>();
                    *state.current_session.lock().unwrap() = session_info.clone();
                }
                let _ = handle.emit("iracing://session-changed", &session_info);
                continue; // skip tick this iteration — session change is higher priority
            }

            // ── 10 Hz watchlist tick ───────────────────────────────────────
            let watchlist = {
                let state = handle.state::<AppState>();
                let wl = state.watchlist.lock().unwrap().clone();
                wl
            };
            if !watchlist.is_empty() {
                // populate_var_offsets is cheap (header parse only, no value reads).
                // We call it every tick because each IracingSDK is a fresh snapshot —
                // var_offsets are not carried over from the session-update branch.
                let mut sdk = sdk;
                sdk.populate_var_offsets();
                let values = sdk.read_watchlist_values(&watchlist);
                let _ = handle.emit("iracing://telemetry-tick", &values);
            }
        }
    });
}
