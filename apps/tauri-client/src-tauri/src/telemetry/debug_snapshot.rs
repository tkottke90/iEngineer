//! M10 US5 (T027/T028): the Debug tab's live snapshot — a 1Hz loop that
//! collects the fixed telemetry set, computes Redis stream lag, probes the hub
//! (single-flight, 2s timeout, 10s stale window), and emits
//! `telemetry:debug-snapshot` while a session is active.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use ts_rs::TS;

use crate::iracing::types::TelemetryValue;
use crate::state::AppState;

const LIVE_STREAM: &str = "iracing:telemetry:live";
const HUB_LIVE_GROUP: &str = "hub:live-processor";
/// FR-016: hub is "connected" while the last SUCCESSFUL probe result is within
/// this window — measured from the last Ok RESPONSE, not the last attempt.
const HUB_STALE_MS: u64 = 10_000;
/// T028/B1: a hung probe must not stall the cadence or leak the guard.
const HUB_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

// Worst-case hub disconnect detection: up to [probe timeout] + [stale window]
// ≈ 12s after the hub becomes unavailable — US5 scenario 4's "10 seconds" is
// measured from the last successful probe, not from hub failure onset
// (T028/B1/F2).

/// whisper_status encoding: 0 = loading/pending (None), 1 = ready (Some(true)),
/// 2 = load failed (Some(false)) — T028/C2 tri-state.
pub const WHISPER_LOADING: u8 = 0;
pub const WHISPER_READY: u8 = 1;
pub const WHISPER_FAILED: u8 = 2;

/// Shared observability state written by the debug loop / probe tasks / STT
/// init, read by `get_debug_snapshot` and the snapshot emitter.
pub struct DebugShared {
    /// T028/A1b single-flight: only one hub probe in the air at a time.
    pub probe_in_flight: AtomicBool,
    /// Wall-clock ms of the last probe that returned Ok. 0 = never.
    pub last_hub_probe_ok_ms: AtomicU64,
    /// False until the FIRST probe result (success OR failure) — the snapshot
    /// reports `hubConnected: null` until then (T028/A3).
    pub first_probe_done: AtomicBool,
    pub redis_ok: AtomicBool,
    /// Stream lag in ms; -1 = null (caught up, or Redis unavailable).
    pub lag_ms: AtomicI64,
    pub whisper_status: AtomicU8,
}

impl Default for DebugShared {
    fn default() -> Self {
        Self {
            probe_in_flight: AtomicBool::new(false),
            last_hub_probe_ok_ms: AtomicU64::new(0),
            first_probe_done: AtomicBool::new(false),
            redis_ok: AtomicBool::new(false),
            lag_ms: AtomicI64::new(-1), // -1 = null (no lag value yet)
            whisper_status: AtomicU8::new(WHISPER_LOADING),
        }
    }
}

/// RAII single-flight guard (T028/I3): `probe_in_flight` is released on EVERY
/// return path — success, error, timeout, panic-unwind — because release lives
/// in Drop. A leak here would stall all future probes permanently.
pub struct ProbeGuard(Arc<DebugShared>);

impl ProbeGuard {
    pub fn try_acquire(shared: &Arc<DebugShared>) -> Option<Self> {
        shared
            .probe_in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()?;
        Some(Self(shared.clone()))
    }
}

impl Drop for ProbeGuard {
    fn drop(&mut self) {
        self.0.probe_in_flight.store(false, Ordering::SeqCst);
    }
}

/// Wire shape per data-model.md: Options serialize to JSON null (never omitted,
/// never the string "unknown" — the frontend owns display-string mapping).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DebugSnapshot {
    pub session_active: bool,
    pub session_id: Option<String>,
    pub fuel_remaining: Option<f64>,
    pub current_lap: Option<f64>,
    pub track_position: Option<f64>,
    pub lap_time_delta: Option<f64>,
    pub redis_stream_lag_ms: Option<i64>,
    pub hub_connected: Option<bool>,
    pub redis_connected: bool,
    pub whisper_model_loaded: Option<bool>,
}

fn value_to_f64(value: &TelemetryValue) -> Option<f64> {
    match value {
        TelemetryValue::Float(v) => Some(*v as f64),
        TelemetryValue::Double(v) => Some(*v),
        TelemetryValue::Int(v) => Some(*v as f64),
        _ => None,
    }
}

pub fn wall_clock_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Assemble a snapshot from current app state. Pure over its inputs (state +
/// clock) so T029b can drive it without a Tauri app.
pub fn build_snapshot(state: &AppState, now_ms: u64) -> DebugSnapshot {
    let session = state.current_session.lock().ok().and_then(|s| s.clone());
    let session_active = session.is_some();
    // The panel's session line is "Active — [Track Name]" (quickstart SC-5).
    let session_id = session.map(|s| s.track_name);

    let fields = state
        .field_cache
        .lock()
        .map(|f| f.clone())
        .unwrap_or_default();
    let get = |names: &[&str]| -> Option<f64> {
        names.iter().find_map(|wanted| {
            fields
                .iter()
                .find(|f| f.name == *wanted)
                .and_then(|f| value_to_f64(&f.value))
        })
    };

    let debug = &state.debug;
    let hub_connected = if !debug.first_probe_done.load(Ordering::Relaxed) {
        None // T028/A3: neutral until the first probe RESULT
    } else {
        let last_ok = debug.last_hub_probe_ok_ms.load(Ordering::Relaxed);
        Some(last_ok != 0 && now_ms.saturating_sub(last_ok) <= HUB_STALE_MS)
    };
    let lag = debug.lag_ms.load(Ordering::Relaxed);
    let whisper = match debug.whisper_status.load(Ordering::Relaxed) {
        WHISPER_READY => Some(true),
        WHISPER_FAILED => Some(false),
        _ => None,
    };

    DebugSnapshot {
        session_active,
        session_id,
        fuel_remaining: get(&["FuelLevel"]),
        current_lap: get(&["Lap"]),
        track_position: get(&["LapDistPct"]),
        lap_time_delta: get(&["LapDeltaToBestLap", "LapDeltaToBest"]),
        redis_stream_lag_ms: if lag < 0 { None } else { Some(lag) },
        hub_connected,
        redis_connected: debug.redis_ok.load(Ordering::Relaxed),
        whisper_model_loaded: whisper,
    }
}

async fn probe_hub(hub_url: &str) -> bool {
    let base = hub_url.trim_end_matches('/');
    reqwest::Client::new()
        .get(format!("{base}/healthz"))
        .timeout(HUB_PROBE_TIMEOUT)
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// XPENDING summary → lag of the oldest unacknowledged live-stream entry for
/// the hub's consumer group (data-model.md formula). None = fully caught up.
async fn query_stream_lag(
    conn: &mut redis::aio::MultiplexedConnection,
    now_ms: u64,
) -> anyhow::Result<Option<i64>> {
    let (count, start, _end, _consumers): (
        i64,
        Option<String>,
        Option<String>,
        Option<Vec<(String, String)>>,
    ) = redis::cmd("XPENDING")
        .arg(LIVE_STREAM)
        .arg(HUB_LIVE_GROUP)
        .query_async(conn)
        .await?;
    if count == 0 {
        return Ok(None);
    }
    let Some(oldest) = start else { return Ok(None) };
    let entry_ms: u64 = oldest
        .split('-')
        .next()
        .and_then(|ms| ms.parse().ok())
        .unwrap_or(0);
    Ok(Some(now_ms.saturating_sub(entry_ms) as i64))
}

/// The 1Hz loop (FR-016/FR-017): always collects + probes (so the tab's badges
/// are fresh whenever it opens); EMITS only while a session is active, plus one
/// final `sessionActive: false` snapshot when the session ends. Hub loss alone
/// never stops emission (FR-017/U4).
pub async fn spawn_debug_loop(app: tauri::AppHandle) {
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut was_active = false;
    let mut redis_conn: Option<redis::aio::MultiplexedConnection> = None;

    loop {
        ticker.tick().await;
        let state = app.state::<AppState>();
        let debug = state.debug.clone();
        let (hub_url, redis_url) = {
            match state.config.lock() {
                Ok(c) => (c.hub_url.clone(), c.redis_url.clone()),
                Err(_) => continue,
            }
        };

        // Hub probe — spawned, never awaited on the snapshot path (FR-016);
        // the single-flight guard skips a spawn while one is still in the air.
        if let Some(guard) = ProbeGuard::try_acquire(&debug) {
            let probe_debug = debug.clone();
            tokio::spawn(async move {
                let _guard = guard; // released on every path (Drop — T028/I3)
                if probe_hub(&hub_url).await {
                    probe_debug
                        .last_hub_probe_ok_ms
                        .store(wall_clock_ms(), Ordering::Relaxed);
                }
                probe_debug.first_probe_done.store(true, Ordering::Relaxed);
            });
        }

        // Stream lag — bounded so a dead Redis can't stall the 1Hz cadence.
        if redis_conn.is_none() {
            redis_conn = match redis::Client::open(redis_url.as_str()) {
                Ok(client) => tokio::time::timeout(
                    Duration::from_millis(800),
                    client.get_multiplexed_async_connection(),
                )
                .await
                .ok()
                .and_then(|r| r.ok()),
                Err(_) => None,
            };
        }
        match redis_conn.as_mut() {
            Some(conn) => {
                match tokio::time::timeout(
                    Duration::from_millis(800),
                    query_stream_lag(conn, wall_clock_ms()),
                )
                .await
                {
                    Ok(Ok(lag)) => {
                        debug.redis_ok.store(true, Ordering::Relaxed);
                        debug.lag_ms.store(lag.unwrap_or(-1), Ordering::Relaxed);
                    }
                    _ => {
                        debug.redis_ok.store(false, Ordering::Relaxed);
                        debug.lag_ms.store(-1, Ordering::Relaxed);
                        redis_conn = None; // reconnect next tick
                    }
                }
            }
            None => {
                debug.redis_ok.store(false, Ordering::Relaxed);
                debug.lag_ms.store(-1, Ordering::Relaxed);
            }
        }

        let snapshot = build_snapshot(&state, wall_clock_ms());
        let active = snapshot.session_active;
        if active || was_active {
            // was_active && !active = the one final sessionActive:false event.
            let _ = app.emit("telemetry:debug-snapshot", snapshot);
        }
        was_active = active;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// T029b(1): full round-trip; None serializes to JSON null (never omitted,
    /// never the string "unknown") per the data-model wire contract.
    #[test]
    fn snapshot_serde_round_trip_with_null_tri_states() {
        let snapshot = DebugSnapshot {
            session_active: true,
            session_id: Some("Okayama".into()),
            fuel_remaining: Some(18.4),
            current_lap: Some(12.0),
            track_position: Some(0.42),
            lap_time_delta: Some(-0.31),
            redis_stream_lag_ms: Some(37),
            hub_connected: None,
            redis_connected: true,
            whisper_model_loaded: None,
        };
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.contains("\"hubConnected\":null"));
        assert!(json.contains("\"whisperModelLoaded\":null"));
        assert!(!json.contains("unknown"));
        let back: DebugSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snapshot, back);
    }

    /// T029b(2): no session → sessionActive false, all telemetry null, hub
    /// null (no probe result yet).
    #[test]
    fn build_snapshot_no_session_defaults() {
        let state = AppState::default();
        let snapshot = build_snapshot(&state, wall_clock_ms());
        assert!(!snapshot.session_active);
        assert_eq!(snapshot.session_id, None);
        assert_eq!(snapshot.fuel_remaining, None);
        assert_eq!(snapshot.current_lap, None);
        assert_eq!(snapshot.track_position, None);
        assert_eq!(snapshot.lap_time_delta, None);
        assert_eq!(
            snapshot.redis_stream_lag_ms, None,
            "-1 sentinel maps to null"
        );
        assert_eq!(
            snapshot.hub_connected, None,
            "neutral until first probe result"
        );
        assert_eq!(snapshot.whisper_model_loaded, None);
    }

    /// T029b(2b): the 10s stale window is measured from the last SUCCESSFUL
    /// probe result.
    #[test]
    fn hub_connected_stale_window() {
        let state = AppState::default();
        state.debug.first_probe_done.store(true, Ordering::Relaxed);
        // Probe completed but never succeeded → disconnected.
        assert_eq!(build_snapshot(&state, 50_000).hub_connected, Some(false));
        // Success 9s ago → connected; 11s ago → disconnected.
        state
            .debug
            .last_hub_probe_ok_ms
            .store(41_000, Ordering::Relaxed);
        assert_eq!(build_snapshot(&state, 50_000).hub_connected, Some(true));
        assert_eq!(build_snapshot(&state, 52_500).hub_connected, Some(false));
    }

    /// T029b(3): the single-flight guard releases on the TIMEOUT path — a
    /// probe that exceeds its budget must not block all future probes.
    #[tokio::test]
    async fn probe_guard_released_on_timeout_path() {
        let shared = Arc::new(DebugShared::default());

        let guard = ProbeGuard::try_acquire(&shared).expect("first acquire");
        assert!(
            ProbeGuard::try_acquire(&shared).is_none(),
            "single-flight: no concurrent probe while one is in the air"
        );

        // Simulate a probe whose inner future overruns and is cut by timeout —
        // the guard is owned by the task and dropped on the timeout path.
        let task = tokio::spawn(async move {
            let _guard = guard;
            let _ = tokio::time::timeout(
                Duration::from_millis(10),
                tokio::time::sleep(Duration::from_secs(60)),
            )
            .await;
            // returns here on timeout; _guard drops
        });
        task.await.unwrap();

        assert!(
            !shared.probe_in_flight.load(Ordering::SeqCst),
            "guard must be released after the timeout path returns"
        );
        assert!(
            ProbeGuard::try_acquire(&shared).is_some(),
            "a subsequent probe can start"
        );
    }
}
