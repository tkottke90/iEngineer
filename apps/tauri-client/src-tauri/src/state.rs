use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tokio::sync::{mpsc, watch};
use ts_rs::TS;

use crate::iracing::types::{ConnectionStatus, SessionInfo, TelemetryField};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AppConfig {
    #[serde(default = "default_redis_url")]
    pub redis_url: String,
    #[serde(default = "default_hub_url")]
    pub hub_url: String,
    /// Existing M4 field, unused in M10 — intentionally not exposed in the
    /// Connection tab UI (FR-007/E4). Preserved through Save round-trips.
    #[serde(default)]
    pub connection_token: String,
    #[serde(default)]
    pub audio_input_device: Option<String>,
    #[serde(default)]
    pub audio_output_device: Option<String>,
    /// "" = never configured (sentinel). The Hotkeys tab shows the first-run
    /// prompt and startup registration is skipped (FR-012/A2). M5's "F13"
    /// default is gone — configs that explicitly saved a key keep it on load.
    #[serde(default)]
    pub ptt_hotkey: String,
    /// M5 personality — five OCEAN traits, each 1–5 (default 3). Written to the
    /// hub via Redis `hub:config:personality`.
    /// `serde(default)` so pre-M5 saved configs (without these fields) still load.
    #[serde(default = "default_trait_level")]
    pub openness: u8,
    #[serde(default = "default_trait_level")]
    pub warmth: u8,
    #[serde(default = "default_trait_level")]
    pub energy: u8,
    #[serde(default = "default_trait_level")]
    pub conscientiousness: u8,
    #[serde(default = "default_trait_level")]
    pub assertiveness: u8,
    /// M10 LLM config. baseUrl + model propagate to the hub via the Redis
    /// `hub:config:llm` key at save time; the API key stays local only.
    #[serde(default = "default_llm_base_url")]
    pub llm_base_url: String,
    #[serde(default = "default_llm_model")]
    pub llm_model: String,
    /// Plain string in the app-data JSON — a known M10 tradeoff (no keychain).
    /// Never written to Redis or sent to the hub.
    #[serde(default)]
    pub llm_api_key: String,
    /// M10 telemetry logging (US7).
    #[serde(default)]
    pub telemetry_logging_enabled: bool,
    /// "" = unresolved sentinel. `Default::default()` cannot call
    /// `app_data_dir()` (no Tauri handle); the startup init flow resolves it to
    /// `app_data_dir()/logs/telemetry` and persists the resolved path.
    #[serde(default)]
    pub telemetry_log_dir: String,
    /// false shows the first-launch LLM-defaults hint (FR-007). Set to true on
    /// the first successful explicit Save-button save only — the PTT auto-save
    /// in `bind_ptt_hotkey()` must NOT set it (T022/A2).
    #[serde(default)]
    pub first_launch_seen: bool,
}

fn default_trait_level() -> u8 {
    3
}

fn default_redis_url() -> String {
    "redis://localhost:6379".into()
}

fn default_hub_url() -> String {
    "http://localhost:5173".into()
}

fn default_llm_base_url() -> String {
    "https://lemonade.tdkottke.com/v1".into()
}

fn default_llm_model() -> String {
    "user.Ornith-1.0-35B-GGUF".into()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            redis_url: default_redis_url(),
            hub_url: default_hub_url(),
            connection_token: String::new(),
            audio_input_device: None,
            audio_output_device: None,
            ptt_hotkey: String::new(),
            openness: 3,
            warmth: 3,
            energy: 3,
            conscientiousness: 3,
            assertiveness: 3,
            llm_base_url: default_llm_base_url(),
            llm_model: default_llm_model(),
            llm_api_key: String::new(),
            telemetry_logging_enabled: false,
            telemetry_log_dir: String::new(),
            first_launch_seen: false,
        }
    }
}

impl AppConfig {
    pub fn path_in(dir: &Path) -> PathBuf {
        dir.join("config.json")
    }

    /// Load the persisted config, falling back to defaults on a missing file
    /// (first run) or unparseable JSON (corrupted file — logged, not fatal).
    pub fn load_from(dir: &Path) -> Self {
        match std::fs::read_to_string(Self::path_in(dir)) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "config.json unparseable — using defaults");
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    /// Persist to `{dir}/config.json`. Error strings are user-facing (FR-027
    /// save-failure surface shows them verbatim).
    pub fn save_to(&self, dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("Cannot write to config file: {e}"))?;
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Cannot serialize config: {e}"))?;
        std::fs::write(Self::path_in(dir), json)
            .map_err(|e| format!("Cannot write to config file: {e}"))
    }
}

/// A saved audio device that was absent at startup (T014). Recorded in managed
/// state so a late-mounting Audio tab can query it (`get_audio_device_status`,
/// U1 — Tauri events are not replayed) in addition to the live
/// `audio:device-unavailable` event. Also the event payload shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UnavailableDevice {
    pub device_type: String, // "input" | "output"
    pub saved_name: String,
}

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub field_cache: Mutex<Vec<TelemetryField>>,
    pub watchlist: Mutex<Vec<String>>,
    pub current_session: Mutex<Option<SessionInfo>>,
    pub iracing_status: watch::Sender<ConnectionStatus>,
    // Kept alive so watch::Sender::send() does not fail with "no receivers".
    _iracing_status_rx: watch::Receiver<ConnectionStatus>,
    /// Notifies publisher_task when session changes (watcher.rs sends here).
    pub session_watch_tx: watch::Sender<Option<SessionInfo>>,
    _session_watch_rx: watch::Receiver<Option<SessionInfo>>,
    /// Notifies publisher_task when Redis URL is saved; URL read from config at reconnect.
    pub redis_url_watch_tx: watch::Sender<String>,
    _redis_url_rx: watch::Receiver<String>,
    /// Live audio device selection (T011/T012/T013): `set_audio_device` sends
    /// the new name here; the capture thread / playback queue subscribe. None =
    /// system default. Seeded from the saved config at startup (T014, after the
    /// availability check).
    pub audio_input_watch_tx: watch::Sender<Option<String>>,
    _audio_input_rx: watch::Receiver<Option<String>>,
    pub audio_output_watch_tx: watch::Sender<Option<String>>,
    _audio_output_rx: watch::Receiver<Option<String>>,
    /// Saved devices found missing at startup (T014/U1) — cleared per type when
    /// a valid device is selected again.
    pub unavailable_devices: Mutex<Vec<UnavailableDevice>>,
    /// True while the PTT key is physically held (set by the global-shortcut
    /// handler). `bind_ptt_hotkey` refuses a rebind while held (T022/U2).
    pub ptt_key_held: std::sync::atomic::AtomicBool,
    /// Pending PTT capture session (T022): `bind_ptt_hotkey` parks a oneshot
    /// sender here; the frontend's keydown handler delivers the captured key
    /// via `submit_ptt_key` while the listening window is open.
    pub ptt_capture_slot: Mutex<Option<tokio::sync::oneshot::Sender<String>>>,
    /// Debug-panel observability state (M10 US5): hub probe, stream lag,
    /// Whisper status — written by the 1Hz debug loop + STT init, read by
    /// `get_debug_snapshot` and the snapshot emitter.
    pub debug: std::sync::Arc<crate::telemetry::debug_snapshot::DebugShared>,
    /// Telemetry logging handle (M10 US7) — set in setup once the writer task
    /// spawns; the publisher's tick loop `try_send`s frames through it.
    pub telemetry_logger: Mutex<Option<crate::telemetry::logger::LoggerHandle>>,
    /// Sender into the Racing Engineer playback queue — set once the engineer task
    /// spawns (mod.rs). The audio test panel command (T038) enqueues clip URLs here.
    pub engineer_playback_tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
}

impl Default for AppState {
    fn default() -> Self {
        let (iracing_tx, iracing_rx) = watch::channel(ConnectionStatus::Disconnected);
        let (session_tx, session_rx) = watch::channel(None);
        let (redis_url_tx, redis_url_rx) = watch::channel(AppConfig::default().redis_url);
        let (audio_in_tx, audio_in_rx) = watch::channel(None);
        let (audio_out_tx, audio_out_rx) = watch::channel(None);
        Self {
            config: Mutex::new(AppConfig::default()),
            field_cache: Mutex::new(Vec::new()),
            watchlist: Mutex::new(Vec::new()),
            current_session: Mutex::new(None),
            iracing_status: iracing_tx,
            _iracing_status_rx: iracing_rx,
            session_watch_tx: session_tx,
            _session_watch_rx: session_rx,
            redis_url_watch_tx: redis_url_tx,
            _redis_url_rx: redis_url_rx,
            audio_input_watch_tx: audio_in_tx,
            _audio_input_rx: audio_in_rx,
            audio_output_watch_tx: audio_out_tx,
            _audio_output_rx: audio_out_rx,
            unavailable_devices: Mutex::new(Vec::new()),
            ptt_key_held: std::sync::atomic::AtomicBool::new(false),
            ptt_capture_slot: Mutex::new(None),
            debug: std::sync::Arc::new(Default::default()),
            telemetry_logger: Mutex::new(None),
            engineer_playback_tx: Mutex::new(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// T001/E2: a fully-populated config (every M10 field non-default) survives
    /// a serialize → deserialize round-trip with no field silently dropped.
    #[test]
    fn round_trip_preserves_all_m10_fields() {
        let config = AppConfig {
            redis_url: "redis://race-box:6380".into(),
            hub_url: "http://race-box:9999".into(),
            connection_token: "tok-123".into(),
            audio_input_device: Some("Racing Headset Mic".into()),
            audio_output_device: Some("Racing Headset".into()),
            ptt_hotkey: "F14".into(),
            openness: 1,
            warmth: 2,
            energy: 4,
            conscientiousness: 5,
            assertiveness: 1,
            llm_base_url: "https://api.example.com/v1".into(),
            llm_model: "some-other-model".into(),
            llm_api_key: "sk-secret".into(),
            telemetry_logging_enabled: true,
            telemetry_log_dir: "/tmp/telemetry-logs".into(),
            first_launch_seen: true,
        };
        let json = serde_json::to_string(&config).unwrap();
        let back: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(config, back);
    }

    /// T001/E2: an old-format (M5) JSON missing every M10 field deserializes
    /// with each new field at its documented default — no load failure, no
    /// silent data loss on the fields that ARE present.
    #[test]
    fn old_format_json_defaults_new_fields() {
        let old = r#"{
            "redis_url": "redis://saved:6379",
            "hub_url": "http://saved:5173",
            "connection_token": "m4-token",
            "audio_input_device": "Old Mic",
            "audio_output_device": null,
            "ptt_hotkey": "F13",
            "openness": 4,
            "warmth": 4,
            "energy": 4,
            "conscientiousness": 4,
            "assertiveness": 4
        }"#;
        let config: AppConfig = serde_json::from_str(old).unwrap();
        // Saved values preserved (incl. an explicitly saved M5 "F13" key).
        assert_eq!(config.redis_url, "redis://saved:6379");
        assert_eq!(config.connection_token, "m4-token");
        assert_eq!(config.ptt_hotkey, "F13");
        assert_eq!(config.openness, 4);
        // New fields get their serde defaults.
        assert_eq!(config.llm_base_url, "https://lemonade.tdkottke.com/v1");
        assert_eq!(config.llm_model, "user.Ornith-1.0-35B-GGUF");
        assert_eq!(config.llm_api_key, "");
        assert!(!config.telemetry_logging_enabled);
        assert_eq!(config.telemetry_log_dir, "");
        assert!(!config.first_launch_seen);
    }

    /// T001/I1: JSON missing ptt_hotkey entirely → "" (never-configured
    /// sentinel), and a fresh default config starts never-configured.
    #[test]
    fn ptt_hotkey_defaults_to_never_configured() {
        let config: AppConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(config.ptt_hotkey, "");
        assert_eq!(AppConfig::default().ptt_hotkey, "");
    }

    /// T001: config persists to and loads from disk; a missing file is a
    /// clean first-run (defaults), not an error.
    #[test]
    fn save_and_load_round_trip_on_disk() {
        let dir =
            std::env::temp_dir().join(format!("iracing-engineer-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // Missing file → defaults.
        assert_eq!(AppConfig::load_from(&dir), AppConfig::default());

        let mut config = AppConfig::default();
        config.ptt_hotkey = "F15".into();
        config.telemetry_log_dir = "/resolved/logs/telemetry".into();
        config.save_to(&dir).expect("save should succeed");
        assert_eq!(AppConfig::load_from(&dir), config);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
