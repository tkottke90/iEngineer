use tauri::State;
use crate::state::{AppConfig, AppState, ConnectionStatus};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AudioDevice {
    pub name: String,
    pub direction: String,
    pub is_default: bool,
}

#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> Result<AppConfig, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.clone())
}

#[tauri::command]
pub async fn save_config(config: AppConfig, state: State<'_, AppState>) -> Result<(), String> {
    let mut current = state.config.lock().map_err(|e| e.to_string())?;
    *current = config;
    // TODO: persist to SQLite
    Ok(())
}

#[tauri::command]
pub async fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let mut devices = Vec::new();

    if let Ok(inputs) = host.input_devices() {
        let default_input = host.default_input_device();
        for device in inputs {
            let name = device.name().unwrap_or_default();
            let is_default = default_input.as_ref().and_then(|d| d.name().ok()).as_deref() == Some(&name);
            devices.push(AudioDevice { name, direction: "input".into(), is_default });
        }
    }

    if let Ok(outputs) = host.output_devices() {
        let default_output = host.default_output_device();
        for device in outputs {
            let name = device.name().unwrap_or_default();
            let is_default = default_output.as_ref().and_then(|d| d.name().ok()).as_deref() == Some(&name);
            devices.push(AudioDevice { name, direction: "output".into(), is_default });
        }
    }

    Ok(devices)
}

#[tauri::command]
pub async fn set_audio_device(_device: AudioDevice) -> Result<(), String> {
    // TODO: update audio capture/playback to use selected device
    Ok(())
}

#[tauri::command]
pub async fn get_connection_status(state: State<'_, AppState>) -> Result<ConnectionStatus, String> {
    // TODO: check actual Redis connection state
    let _ = state.config.lock().map_err(|e| e.to_string())?;
    Ok(ConnectionStatus::Disconnected)
}

#[tauri::command]
pub async fn test_connection(state: State<'_, AppState>) -> Result<ConnectionStatus, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();
    // TODO: attempt Redis PING using config.redis_url
    let _ = config;
    Ok(ConnectionStatus::Disconnected)
}
