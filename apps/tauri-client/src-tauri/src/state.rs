use serde::{Deserialize, Serialize};
use ts_rs::TS;

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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum ConnectionStatus {
    Connected,
    Disconnected,
    Connecting,
}

#[derive(Debug, Default)]
pub struct AppState {
    pub config: std::sync::Mutex<AppConfig>,
}
