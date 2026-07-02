use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tracing::{info, warn};

use crate::iracing::sdk::IracingSDK;
use crate::iracing::types::{ConnectionStatus, SessionInfo, TelemetryValue};
use crate::state::AppState;
use crate::telemetry::downsampler::Downsampler;
use crate::telemetry::publisher::RedisPublisher;

// ── Stream keys ───────────────────────────────────────────────────────────────

const LIVE_STREAM: &str = "iracing:telemetry:live";
const SESSION_STREAM: &str = "iracing:telemetry:session";
const CONN_EVENT_STREAM: &str = "iracing:events:connection";
const SESSION_EVENT_STREAM: &str = "iracing:events:session";

// ── MAXLEN constants ──────────────────────────────────────────────────────────

const LIVE_MAXLEN: u64 = 3600; // 60 s at 60 Hz
const SESSION_MAXLEN: u64 = 900; // 60 s at 15 Hz
const EVENT_MAXLEN: u64 = 100;

// ── Session-rate field set (source of truth: data-model.md §SessionTelemetryFrame) ──

pub static SESSION_RATE_FIELDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        // Fuel
        "FuelLevel",
        "FuelLevelPct",
        "FuelUsePerHour",
        // Coolant / oil
        "WaterTemp",
        "OilTemp",
        "OilPress",
        // Tire temps LF
        "LFtempCL",
        "LFtempCM",
        "LFtempCR",
        // Tire temps RF
        "RFtempCL",
        "RFtempCM",
        "RFtempCR",
        // Tire temps LR
        "LRtempCL",
        "LRtempCM",
        "LRtempCR",
        // Tire temps RR
        "RRtempCL",
        "RRtempCM",
        "RRtempCR",
        // Tire wear LF
        "LFwearL",
        "LFwearM",
        "LFwearR",
        // Tire wear RF
        "RFwearL",
        "RFwearM",
        "RFwearR",
        // Tire wear LR
        "LRwearL",
        "LRwearM",
        "LRwearR",
        // Tire wear RR
        "RRwearL",
        "RRwearM",
        "RRwearR",
        // Lap timing
        "LapCurrentLapTime",
        "LapLastLapTime",
        "LapBestLapTime",
        "LapDeltaToBestLap",
        "LapDeltaToOptimalLap",
        // Session remaining
        "SessionTimeRemain",
        "SessionLapsRemain",
        // Hero position
        "PlayerCarClassPosition",
        "PlayerCarPosition",
        "IncidentCount",
        // All-car positions
        "CarIdxPosition",
        "CarIdxClassPosition",
        // All-car laps
        "CarIdxLap",
        "CarIdxLapCompleted",
        // All-car timing
        "CarIdxLastLapTime",
        "CarIdxBestLapTime",
        "CarIdxEstTime",
        "CarIdxF2Time",
        // All-car status
        "CarIdxOnPitRoad",
        "CarIdxTireCompound",
        "CarIdxFastRepairsUsed",
        // Pit service
        "PitSvFlags",
        "PitOptRepairLeft",
        "PitRepairLeft",
    ]
    .into_iter()
    .collect()
});

// ── Event payload types ───────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ConnectionEventPayload {
    pub status: &'static str, // "Connected" | "Disconnected"
    pub ts: u64,
}

#[derive(Serialize)]
pub struct SessionEventPayload {
    pub active: bool,
    pub ts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_car_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_car_idx: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wall_clock_time: Option<String>,
}

pub enum SnapshotReason {
    IracingDisconnected,
    RedisConnected,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

pub fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn telemetry_value_to_string(v: &TelemetryValue) -> String {
    match v {
        TelemetryValue::Float(f) => format!("{}", f),
        TelemetryValue::Double(d) => format!("{}", d),
        TelemetryValue::Int(i) => format!("{}", i),
        TelemetryValue::Bool(b) => format!("{}", b),
        TelemetryValue::Bitfield(u) => format!("{}", u),
        TelemetryValue::Char(s) => s.clone(),
        TelemetryValue::FloatArray(arr) => serde_json::to_string(arr).unwrap_or_default(),
        TelemetryValue::IntArray(arr) => serde_json::to_string(arr).unwrap_or_default(),
        TelemetryValue::Unavailable => String::new(),
    }
}

fn session_event_payload(session: &Option<SessionInfo>) -> SessionEventPayload {
    match session {
        None => SessionEventPayload {
            active: false,
            ts: unix_ms(),
            track_name: None,
            player_car_name: None,
            player_car_idx: None,
            session_type: None,
            wall_clock_time: None,
        },
        Some(s) => SessionEventPayload {
            active: true,
            ts: unix_ms(),
            track_name: Some(s.track_name.clone()),
            player_car_name: Some(s.car_name.clone()),
            player_car_idx: Some(s.player_car_idx),
            session_type: Some(s.session_type.clone()),
            wall_clock_time: Some(s.wall_clock_time.clone()),
        },
    }
}

// Returns true on the first tick where session becomes inactive (should log); false thereafter.
fn update_suppression(was_suppressed: &mut bool, session_active: bool) -> bool {
    if !session_active {
        let first = !*was_suppressed;
        *was_suppressed = true;
        return first;
    }
    *was_suppressed = false;
    false
}

// ── FR-009 snapshot ───────────────────────────────────────────────────────────

pub async fn publish_snapshot(
    publisher: &mut RedisPublisher,
    status: &ConnectionStatus,
    current_session: &Option<SessionInfo>,
    reason: SnapshotReason,
) -> anyhow::Result<()> {
    match reason {
        // Path (a): iRacing disconnected — always emit BOTH events
        SnapshotReason::IracingDisconnected => {
            let conn_payload = ConnectionEventPayload {
                status: "Disconnected",
                ts: unix_ms(),
            };
            let conn_json = serde_json::to_string(&conn_payload)?;
            publisher
                .publish_event(CONN_EVENT_STREAM, &conn_json)
                .await?;

            let sess_payload = session_event_payload(&None);
            let sess_json = serde_json::to_string(&sess_payload)?;
            publisher
                .publish_event(SESSION_EVENT_STREAM, &sess_json)
                .await?;
        }

        // Paths (b) and (c): Redis (re)connected
        SnapshotReason::RedisConnected => {
            match status {
                // Path (b): Redis reconnected, iRacing still disconnected — ConnectionEvent only
                ConnectionStatus::Disconnected => {
                    let conn_payload = ConnectionEventPayload {
                        status: "Disconnected",
                        ts: unix_ms(),
                    };
                    let conn_json = serde_json::to_string(&conn_payload)?;
                    publisher
                        .publish_event(CONN_EVENT_STREAM, &conn_json)
                        .await?;
                }

                // Path (c): Redis reconnected, iRacing connected — both events
                ConnectionStatus::Connected | ConnectionStatus::Connecting => {
                    let conn_payload = ConnectionEventPayload {
                        status: "Connected",
                        ts: unix_ms(),
                    };
                    let conn_json = serde_json::to_string(&conn_payload)?;
                    publisher
                        .publish_event(CONN_EVENT_STREAM, &conn_json)
                        .await?;

                    let sess_payload = session_event_payload(current_session);
                    let sess_json = serde_json::to_string(&sess_payload)?;
                    publisher
                        .publish_event(SESSION_EVENT_STREAM, &sess_json)
                        .await?;
                }
            }
        }
    }
    Ok(())
}

// ── Publisher task ────────────────────────────────────────────────────────────

pub async fn spawn_publisher_task(handle: AppHandle) {
    let mut backoff = Duration::from_millis(100);
    let max_backoff = Duration::from_secs(8);
    let mut attempt = 0u32;

    loop {
        // FR-010: read URL fresh on each reconnect attempt
        let url = {
            let state = handle.state::<AppState>();
            let guard = state.config.lock().unwrap();
            guard.redis_url.clone()
        };

        let mut publisher = match RedisPublisher::new(&url).await {
            Ok(p) => {
                info!("redis publisher connected: {}", url);
                attempt = 0;
                backoff = Duration::from_millis(100);
                p
            }
            Err(e) => {
                warn!("redis connect attempt {} failed: {}", attempt, e);
                attempt += 1;
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(max_backoff);
                continue;
            }
        };

        // FR-009: snapshot current state immediately on connect (paths b/c)
        {
            let state = handle.state::<AppState>();
            let current_status = state.iracing_status.borrow().clone();
            let current_session = state.current_session.lock().unwrap().clone();
            if let Err(e) = publish_snapshot(
                &mut publisher,
                &current_status,
                &current_session,
                SnapshotReason::RedisConnected,
            )
            .await
            {
                warn!("redis publish_snapshot on connect failed: {}", e);
                continue;
            }
        }

        // ── Inner loop ────────────────────────────────────────────────────────
        let mut status_rx = handle.state::<AppState>().iracing_status.subscribe();
        let mut interval = tokio::time::interval(Duration::from_millis(16));
        let mut downsampler = Downsampler::new();
        let mut was_suppressed = false;
        let mut last_sdk_session_update: i32 = -1;

        'inner: loop {
            tokio::select! {
                _ = interval.tick() => {
                    let current_status = status_rx.borrow().clone();
                    if !matches!(current_status, ConnectionStatus::Connected) {
                        continue 'inner;
                    }

                    // Open a fresh SDK snapshot (Windows only; no-op on Linux CI)
                    let mut sdk = match IracingSDK::open() {
                        Ok(s) => s,
                        Err(_) => continue 'inner,
                    };
                    if !sdk.is_connected() {
                        continue 'inner;
                    }

                    // T015: counter-based session change detection
                    let session_update = sdk.session_info_update();
                    if session_update != last_sdk_session_update {
                        last_sdk_session_update = session_update;
                        let current_session = handle.state::<AppState>().current_session.lock().unwrap().clone();
                        let payload = session_event_payload(&current_session);
                        match serde_json::to_string(&payload) {
                            Ok(json) => {
                                if let Err(e) = publisher.publish_event(SESSION_EVENT_STREAM, &json).await {
                                    warn!("redis publish session event error: {}", e);
                                    break 'inner;
                                }
                            }
                            Err(e) => warn!("session event serialization error: {}", e),
                        }
                    }

                    // Read field cache
                    sdk.populate_var_offsets();
                    let fields = sdk.enumerate_vars();

                    // T020: session suppression gate
                    let current_session = handle.state::<AppState>().current_session.lock().unwrap().clone();
                    if update_suppression(&mut was_suppressed, current_session.is_some()) {
                        info!("telemetry publish suppressed — no active session");
                        continue 'inner;
                    }
                    if was_suppressed {
                        continue 'inner;
                    }

                    // Build live + session-rate vecs
                    let ts_str = unix_ms().to_string();
                    let mut live_fields: Vec<(String, String)> = vec![("_ts".to_string(), ts_str.clone())];
                    let mut session_fields: Vec<(String, String)> = vec![("_ts".to_string(), ts_str)];

                    for f in &fields {
                        let val = telemetry_value_to_string(&f.value);
                        if SESSION_RATE_FIELDS.contains(f.name.as_str()) {
                            session_fields.push((f.name.clone(), val));
                        } else {
                            live_fields.push((f.name.clone(), val));
                        }
                    }

                    // T019: publish live at 60 Hz
                    let live_refs: Vec<(&str, &str)> =
                        live_fields.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
                    if let Err(e) = publisher.publish_live(live_refs).await {
                        warn!("redis publish_live error: {}", e);
                        break 'inner;
                    }

                    // T023: publish session-rate at 15 Hz (every 4th tick)
                    if downsampler.should_emit_session() {
                        let sess_refs: Vec<(&str, &str)> =
                            session_fields.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
                        if let Err(e) = publisher.publish_session(sess_refs).await {
                            warn!("redis publish_session error: {}", e);
                            break 'inner;
                        }
                    }
                }

                result = status_rx.changed() => {
                    match result {
                        Err(_) => break 'inner, // AppState dropped (app shutting down)
                        Ok(()) => {
                            let new_status = status_rx.borrow().clone();
                            let reason = match new_status {
                                ConnectionStatus::Disconnected => SnapshotReason::IracingDisconnected,
                                ConnectionStatus::Connected | ConnectionStatus::Connecting => {
                                    SnapshotReason::RedisConnected
                                }
                            };
                            let current_session = handle.state::<AppState>().current_session.lock().unwrap().clone();
                            if let Err(e) = publish_snapshot(&mut publisher, &new_status, &current_session, reason).await {
                                warn!("redis publish_snapshot error: {}", e);
                                break 'inner;
                            }
                        }
                    }
                }
            }
        }

        info!("redis publisher disconnected — reconnecting");
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use redis::AsyncCommands;

    const REDIS_URL: &str = "redis://localhost:6379";

    async fn test_publisher() -> (RedisPublisher, redis::aio::MultiplexedConnection) {
        let pub_ = RedisPublisher::new(REDIS_URL)
            .await
            .expect("Redis must be running for integration tests");
        let client = redis::Client::open(REDIS_URL).unwrap();
        let conn = client.get_multiplexed_async_connection().await.unwrap();
        (pub_, conn)
    }

    async fn del(conn: &mut redis::aio::MultiplexedConnection, keys: &[&str]) {
        for k in keys {
            let _: redis::RedisResult<()> = redis::cmd("DEL").arg(k).query_async(conn).await;
        }
    }

    async fn xrange_payloads(
        conn: &mut redis::aio::MultiplexedConnection,
        stream: &str,
    ) -> Vec<serde_json::Value> {
        let reply: redis::streams::StreamRangeReply = redis::cmd("XRANGE")
            .arg(stream)
            .arg("-")
            .arg("+")
            .query_async(conn)
            .await
            .unwrap();
        reply
            .ids
            .iter()
            .filter_map(|id| {
                let v = id.map.get("payload")?;
                let s: String = redis::from_redis_value(v).ok()?;
                serde_json::from_str(&s).ok()
            })
            .collect()
    }

    // ── T011: connection event round-trip ─────────────────────────────────────

    #[tokio::test]
    async fn test_connection_event_roundtrip() {
        let (mut pub_, mut conn) = test_publisher().await;
        del(&mut conn, &[CONN_EVENT_STREAM]).await;

        let payload = ConnectionEventPayload {
            status: "Connected",
            ts: 1719619200000,
        };
        let json = serde_json::to_string(&payload).unwrap();
        pub_.publish_event(CONN_EVENT_STREAM, &json).await.unwrap();

        let entries = xrange_payloads(&mut conn, CONN_EVENT_STREAM).await;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["status"], "Connected");
        assert!(entries[0]["ts"].is_number());
    }

    // ── T011: FR-009 path (a) — iRacing disconnects → both events ────────────

    #[tokio::test]
    async fn test_fr009_path_a_dual_event() {
        let (mut pub_, mut conn) = test_publisher().await;
        del(&mut conn, &[CONN_EVENT_STREAM, SESSION_EVENT_STREAM]).await;

        publish_snapshot(
            &mut pub_,
            &ConnectionStatus::Disconnected,
            &None,
            SnapshotReason::IracingDisconnected,
        )
        .await
        .unwrap();

        let conn_entries = xrange_payloads(&mut conn, CONN_EVENT_STREAM).await;
        let sess_entries = xrange_payloads(&mut conn, SESSION_EVENT_STREAM).await;

        assert_eq!(
            conn_entries.len(),
            1,
            "path (a) must emit exactly one ConnectionEvent"
        );
        assert_eq!(conn_entries[0]["status"], "Disconnected");

        assert_eq!(
            sess_entries.len(),
            1,
            "path (a) must emit exactly one SessionEvent"
        );
        assert_eq!(sess_entries[0]["active"], false);
    }

    // ── T011: FR-009 path (c) — Redis reconnect, iRacing connected, no session ─

    #[tokio::test]
    async fn test_fr009_path_c_none() {
        let (mut pub_, mut conn) = test_publisher().await;
        del(&mut conn, &[CONN_EVENT_STREAM, SESSION_EVENT_STREAM]).await;

        publish_snapshot(
            &mut pub_,
            &ConnectionStatus::Connected,
            &None,
            SnapshotReason::RedisConnected,
        )
        .await
        .unwrap();

        let conn_entries = xrange_payloads(&mut conn, CONN_EVENT_STREAM).await;
        let sess_entries = xrange_payloads(&mut conn, SESSION_EVENT_STREAM).await;

        assert_eq!(conn_entries.len(), 1);
        assert_eq!(conn_entries[0]["status"], "Connected");
        assert_eq!(sess_entries.len(), 1);
        assert_eq!(sess_entries[0]["active"], false);
    }

    // ── T011: FR-009 path (c) — Redis reconnect, iRacing connected, active session ─

    #[tokio::test]
    async fn test_fr009_path_c_some() {
        let (mut pub_, mut conn) = test_publisher().await;
        del(&mut conn, &[CONN_EVENT_STREAM, SESSION_EVENT_STREAM]).await;

        let session = SessionInfo {
            track_name: "Watkins Glen Boot".into(),
            session_type: "Race".into(),
            car_name: "BMW M4 GT3".into(),
            wall_clock_time: "14:32:07".into(),
            player_car_idx: 3,
        };

        publish_snapshot(
            &mut pub_,
            &ConnectionStatus::Connected,
            &Some(session),
            SnapshotReason::RedisConnected,
        )
        .await
        .unwrap();

        let conn_entries = xrange_payloads(&mut conn, CONN_EVENT_STREAM).await;
        let sess_entries = xrange_payloads(&mut conn, SESSION_EVENT_STREAM).await;

        assert_eq!(conn_entries.len(), 1);
        assert_eq!(conn_entries[0]["status"], "Connected");
        assert_eq!(sess_entries.len(), 1);
        assert_eq!(sess_entries[0]["active"], true);
        assert_eq!(sess_entries[0]["track_name"], "Watkins Glen Boot");
        assert_eq!(sess_entries[0]["player_car_idx"], 3);
    }

    // ── T017: live frame round-trip ───────────────────────────────────────────

    #[tokio::test]
    async fn test_live_frame_roundtrip() {
        let (mut pub_, mut conn) = test_publisher().await;
        del(&mut conn, &[LIVE_STREAM]).await;

        let fields = vec![
            ("_ts", "1719619200123"),
            ("Speed", "42.37"),
            ("RPM", "6800"),
            ("Gear", "4"),
            ("Throttle", "0.82"),
            ("Brake", "0.0"),
            ("SessionFlags", "0"),
        ];
        pub_.publish_live(fields).await.unwrap();

        let reply: redis::streams::StreamRangeReply = redis::cmd("XRANGE")
            .arg(LIVE_STREAM)
            .arg("-")
            .arg("+")
            .query_async(&mut conn)
            .await
            .unwrap();

        assert_eq!(reply.ids.len(), 1);
        let entry = &reply.ids[0];
        let speed: String = redis::from_redis_value(entry.map.get("Speed").unwrap()).unwrap();
        let ts: String = redis::from_redis_value(entry.map.get("_ts").unwrap()).unwrap();
        assert_eq!(speed, "42.37");
        assert_eq!(ts, "1719619200123");
    }

    // ── T020: suppression flag state machine ──────────────────────────────────

    #[test]
    fn test_was_suppressed_flag_logic() {
        let mut flag = false;

        // First tick with no session → should log (returns true), flag → true
        assert!(
            update_suppression(&mut flag, false),
            "first suppression tick must return true (triggers log)"
        );
        assert!(flag, "flag must be true after first suppression");

        // Second tick with no session → should NOT log (returns false), flag stays true
        assert!(
            !update_suppression(&mut flag, false),
            "subsequent suppression tick must return false"
        );
        assert!(flag, "flag must remain true");

        // Session becomes active → flag resets, returns false
        assert!(
            !update_suppression(&mut flag, true),
            "active session tick must return false"
        );
        assert!(!flag, "flag must reset to false when session is active");
    }

    // ── T021: session-rate frame round-trip ───────────────────────────────────

    #[tokio::test]
    async fn test_session_rate_frame_roundtrip() {
        let (mut pub_, mut conn) = test_publisher().await;
        del(&mut conn, &[SESSION_STREAM]).await;

        // Verify SESSION_RATE_FIELDS contains expected field
        assert!(
            SESSION_RATE_FIELDS.contains("FuelLevel"),
            "FuelLevel missing from SESSION_RATE_FIELDS — verify field name capitalization against sdk.enumerate_vars()"
        );

        let fields = vec![
            ("_ts", "1719619200456"),
            ("FuelLevel", "28.5"),
            ("LapLastLapTime", "92.341"),
            ("CarIdxPosition", "[1,3,2,4]"),
        ];
        pub_.publish_session(fields).await.unwrap();

        let reply: redis::streams::StreamRangeReply = redis::cmd("XRANGE")
            .arg(SESSION_STREAM)
            .arg("-")
            .arg("+")
            .query_async(&mut conn)
            .await
            .unwrap();

        assert_eq!(reply.ids.len(), 1);
        let entry = &reply.ids[0];
        let fuel: String = redis::from_redis_value(entry.map.get("FuelLevel").unwrap()).unwrap();
        let positions: String =
            redis::from_redis_value(entry.map.get("CarIdxPosition").unwrap()).unwrap();
        assert_eq!(fuel, "28.5");
        assert_eq!(positions, "[1,3,2,4]");
    }

    // ── T024: FR-009 path (b) negative test ──────────────────────────────────

    #[tokio::test]
    async fn test_fr009_path_b_negative() {
        let (mut pub_, mut conn) = test_publisher().await;
        del(&mut conn, &[CONN_EVENT_STREAM, SESSION_EVENT_STREAM]).await;

        // Path (b): Redis reconnected while iRacing Disconnected → ConnectionEvent only
        publish_snapshot(
            &mut pub_,
            &ConnectionStatus::Disconnected,
            &None,
            SnapshotReason::RedisConnected,
        )
        .await
        .unwrap();

        let conn_entries = xrange_payloads(&mut conn, CONN_EVENT_STREAM).await;
        let sess_entries = xrange_payloads(&mut conn, SESSION_EVENT_STREAM).await;

        assert_eq!(
            conn_entries.len(),
            1,
            "path (b) must emit exactly one ConnectionEvent"
        );
        assert_eq!(conn_entries[0]["status"], "Disconnected");
        assert_eq!(
            sess_entries.len(),
            0,
            "path (b) must NOT emit a SessionEvent"
        );
    }
}
