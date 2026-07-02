use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tokio::sync::{mpsc, watch};
use ts_rs::TS;

use crate::iracing::types::{ConnectionStatus, SessionInfo, TelemetryField};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AppConfig {
    pub redis_url: String,
    pub hub_url: String,
    pub connection_token: String,
    pub audio_input_device: Option<String>,
    pub audio_output_device: Option<String>,
    pub ptt_hotkey: String,
    /// DEPRECATED (M5): retained for the current Setup UI until T053 migrates it
    /// to the five OCEAN traits below; then these three String fields are removed.
    pub chattiness: String,
    pub familiarity: String,
    pub aggression: String,
    /// M5 personality — five OCEAN traits, each 1–5 (default 3). Written to the
    /// hub via Redis `hub:config:personality`. Wired to the UI in T053.
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
}

fn default_trait_level() -> u8 {
    3
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            redis_url: "redis://localhost:6379".into(),
            hub_url: "http://localhost:5173".into(),
            connection_token: String::new(),
            audio_input_device: None,
            audio_output_device: None,
            ptt_hotkey: "F13".into(),
            chattiness: "Default".into(),
            familiarity: "Default".into(),
            aggression: "Default".into(),
            openness: 3,
            warmth: 3,
            energy: 3,
            conscientiousness: 3,
            assertiveness: 3,
        }
    }
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
    /// Sender into the Racing Engineer playback queue — set once the engineer task
    /// spawns (mod.rs). The audio test panel command (T038) enqueues clip URLs here.
    pub engineer_playback_tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
}

impl Default for AppState {
    fn default() -> Self {
        let (iracing_tx, iracing_rx) = watch::channel(ConnectionStatus::Disconnected);
        let (session_tx, session_rx) = watch::channel(None);
        let (redis_url_tx, redis_url_rx) = watch::channel(AppConfig::default().redis_url);
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
            engineer_playback_tx: Mutex::new(None),
        }
    }
}
