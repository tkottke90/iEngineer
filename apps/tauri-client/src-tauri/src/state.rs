use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tokio::sync::watch;
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
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            redis_url: "redis://localhost:6379".into(),
            hub_url: "http://localhost:3000".into(),
            connection_token: String::new(),
            audio_input_device: None,
            audio_output_device: None,
            ptt_hotkey: "F13".into(),
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
    // Without a live receiver, send() returns Err and borrow() always sees the
    // initial Disconnected value regardless of what the watcher tries to write.
    _iracing_status_rx: watch::Receiver<ConnectionStatus>,
}

impl Default for AppState {
    fn default() -> Self {
        let (tx, rx) = watch::channel(ConnectionStatus::Disconnected);
        Self {
            config: Mutex::new(AppConfig::default()),
            field_cache: Mutex::new(Vec::new()),
            watchlist: Mutex::new(Vec::new()),
            current_session: Mutex::new(None),
            iracing_status: tx,
            _iracing_status_rx: rx,
        }
    }
}
