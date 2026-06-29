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
    _iracing_status_rx: watch::Receiver<ConnectionStatus>,
    /// Notifies publisher_task when session changes (watcher.rs sends here).
    pub session_watch_tx: watch::Sender<Option<SessionInfo>>,
    _session_watch_rx: watch::Receiver<Option<SessionInfo>>,
    /// Notifies publisher_task when Redis URL is saved; URL read from config at reconnect.
    pub redis_url_watch_tx: watch::Sender<String>,
    _redis_url_rx: watch::Receiver<String>,
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
        }
    }
}
