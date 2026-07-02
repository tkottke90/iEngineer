use serde::{Deserialize, Serialize};
use tauri::State;
use tracing::info;
use ts_rs::TS;

use crate::iracing::types::{ConnectionStatus, SessionInfo, TelemetryField, TelemetryValue};
use crate::state::{AppConfig, AppState};

// ── Audio helpers (unchanged) ─────────────────────────────────────────────────

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
    let new_url = config.redis_url.clone();
    // Capture the five personality traits for the hub sync before moving `config`.
    let personality = serde_json::json!({
        "openness": config.openness,
        "warmth": config.warmth,
        "energy": config.energy,
        "conscientiousness": config.conscientiousness,
        "assertiveness": config.assertiveness,
    })
    .to_string();
    let redis_url = config.redis_url.clone();
    let mut current = state.config.lock().map_err(|e| e.to_string())?;
    let url_changed = current.redis_url != new_url;
    *current = config;
    drop(current);
    if url_changed {
        let _ = state.redis_url_watch_tx.send(new_url);
        info!("redis url updated — will apply on next reconnect");
    }

    // Tauri→hub personality sync (M5): write the five-trait config to the Redis key
    // the RacingEngineerService reads (T016). Best-effort — a Redis failure must not
    // block saving the local config.
    tokio::spawn(async move {
        if let Err(e) = write_personality(&redis_url, &personality).await {
            tracing::warn!(error = %e, "failed to write hub:config:personality");
        }
    });

    Ok(())
}

async fn write_personality(redis_url: &str, value: &str) -> anyhow::Result<()> {
    let client = redis::Client::open(redis_url)?;
    let mut conn = client.get_multiplexed_async_connection().await?;
    let _: () = redis::cmd("SET")
        .arg("hub:config:personality")
        .arg(value)
        .query_async(&mut conn)
        .await?;
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
            let is_default = default_input
                .as_ref()
                .and_then(|d| d.name().ok())
                .as_deref()
                == Some(&name);
            devices.push(AudioDevice {
                name,
                direction: "input".into(),
                is_default,
            });
        }
    }

    if let Ok(outputs) = host.output_devices() {
        let default_output = host.default_output_device();
        for device in outputs {
            let name = device.name().unwrap_or_default();
            let is_default = default_output
                .as_ref()
                .and_then(|d| d.name().ok())
                .as_deref()
                == Some(&name);
            devices.push(AudioDevice {
                name,
                direction: "output".into(),
                is_default,
            });
        }
    }

    Ok(devices)
}

#[tauri::command]
pub async fn set_audio_device(_device: AudioDevice) -> Result<(), String> {
    Ok(())
}

// ── Service connection checks ─────────────────────────────────────────────────

/// PING Redis at the given URL. Returns true if reachable, false otherwise.
/// Never errors — an unreachable service is a normal `false`, not a failure.
#[tauri::command]
pub async fn check_redis(url: String) -> Result<bool, String> {
    let fut = async {
        let client = redis::Client::open(url)?;
        let mut conn = client.get_multiplexed_async_connection().await?;
        let pong: String = redis::cmd("PING").query_async(&mut conn).await?;
        anyhow::Ok(pong == "PONG")
    };
    match tokio::time::timeout(std::time::Duration::from_secs(3), fut).await {
        Ok(Ok(ok)) => Ok(ok),
        _ => Ok(false),
    }
}

/// GET the hub's /healthz endpoint. Returns true on a 2xx response.
#[tauri::command]
pub async fn check_hub(url: String) -> Result<bool, String> {
    let base = url.trim_end_matches('/');
    let resp = reqwest::Client::new()
        .get(format!("{base}/healthz"))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await;
    Ok(resp.map(|r| r.status().is_success()).unwrap_or(false))
}

/// Audio device test panel (T038): ask the hub to synthesize a fixed test phrase,
/// then enqueue the returned clip into the Racing Engineer playback queue. Always
/// routes through the hub endpoint so AudioStore TTL tracking + structured logging
/// apply (never calls Chatterbox directly).
#[tauri::command]
pub async fn test_audio_playback(state: State<'_, AppState>) -> Result<(), String> {
    let (hub_url, tx) = {
        let hub_url = state
            .config
            .lock()
            .map_err(|e| e.to_string())?
            .hub_url
            .clone();
        let tx = state
            .engineer_playback_tx
            .lock()
            .map_err(|e| e.to_string())?
            .clone();
        (hub_url, tx)
    };
    let tx = tx.ok_or_else(|| "playback queue not ready".to_string())?;

    let base = hub_url.trim_end_matches('/');
    #[derive(serde::Deserialize)]
    struct TestClip {
        #[serde(rename = "clipUrl")]
        clip_url: String,
    }
    let resp = reqwest::Client::new()
        .post(format!("{base}/api/audio/test"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("hub returned {status}: {body}"));
    }
    let clip: TestClip = resp.json().await.map_err(|e| e.to_string())?;

    let absolute = format!("{}{}", base, clip.clip_url);
    tx.send(absolute).map_err(|e| e.to_string())?;
    Ok(())
}

// ── iRacing commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_iracing_status(_state: State<'_, AppState>) -> Result<ConnectionStatus, String> {
    // Read live from shared memory rather than the watch channel.
    // The watch channel is still updated by the watcher for event emissions,
    // but polling via invoke always reflects the true current state.
    #[cfg(target_os = "windows")]
    {
        use crate::iracing::sdk::IracingSDK;
        if let Ok(sdk) = IracingSDK::open() {
            if sdk.is_connected() {
                return Ok(ConnectionStatus::Connected);
            }
        }
        return Ok(ConnectionStatus::Disconnected);
    }
    #[cfg(not(target_os = "windows"))]
    Ok(ConnectionStatus::Disconnected)
}

#[tauri::command]
pub async fn get_session_data(state: State<'_, AppState>) -> Result<Option<SessionInfo>, String> {
    let session = state.current_session.lock().map_err(|e| e.to_string())?;
    Ok(session.clone())
}

#[tauri::command]
pub async fn list_telemetry_fields(
    state: State<'_, AppState>,
) -> Result<Vec<TelemetryField>, String> {
    let cache = state.field_cache.lock().map_err(|e| e.to_string())?;
    Ok(cache.clone())
}

#[tauri::command]
pub async fn get_watchlist(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let wl = state.watchlist.lock().map_err(|e| e.to_string())?;
    Ok(wl.clone())
}

#[tauri::command]
pub async fn set_watchlist(fields: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    let mut wl = state.watchlist.lock().map_err(|e| e.to_string())?;
    *wl = fields;
    Ok(())
}

/// Resolves the current camera car (CamCarIdx) and returns its per-car telemetry
/// fields as scalar values — useful for stream overlays and camera-follow panels.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FocusedCarData {
    pub cam_car_idx: i32,
    pub cam_group: i32,
    pub cam_num: i32,
    pub fields: std::collections::HashMap<String, TelemetryValue>,
}

/// CarIdx* fields to resolve for the focused car, in display order.
const FOCUSED_FIELDS: &[&str] = &[
    "CarIdxPosition",
    "CarIdxClassPosition",
    "CarIdxLapCompleted",
    "CarIdxLapDistPct",
    "CarIdxF2Time",
    "CarIdxEstTime",
    "CarIdxGear",
    "CarIdxRPM",
    "CarIdxTrackSurface",
    "CarIdxOnPitRoad",
    "CarIdxSteer",
];

#[tauri::command]
pub async fn get_focused_car_data() -> Result<Option<FocusedCarData>, String> {
    #[cfg(target_os = "windows")]
    {
        use crate::iracing::sdk::IracingSDK;
        let mut sdk = match IracingSDK::open() {
            Ok(s) if s.is_connected() => s,
            _ => return Ok(None),
        };
        sdk.populate_var_offsets();

        let cam_car_idx = match sdk.read_var_int("CamCarIdx") {
            Some(v) if v >= 0 => v,
            _ => return Ok(None),
        };
        let cam_group = sdk.read_var_int("CamGroupNumber").unwrap_or(-1);
        let cam_num = sdk.read_var_int("CamCameraNumber").unwrap_or(-1);

        let mut fields = std::collections::HashMap::new();
        for &name in FOCUSED_FIELDS {
            if let Some(value) = sdk.read_var_array_element(name, cam_car_idx as usize) {
                fields.insert(name.to_string(), value);
            }
        }

        return Ok(Some(FocusedCarData {
            cam_car_idx,
            cam_group,
            cam_num,
            fields,
        }));
    }
    #[cfg(not(target_os = "windows"))]
    Ok(None)
}

#[tauri::command]
pub async fn get_sdk_debug() -> Result<std::collections::HashMap<String, String>, String> {
    #[cfg(target_os = "windows")]
    {
        use crate::iracing::sdk::IracingSDK;
        if let Ok(mut sdk) = IracingSDK::open() {
            return Ok(sdk.debug_info());
        }
        return Ok(std::collections::HashMap::new());
    }
    #[cfg(not(target_os = "windows"))]
    Ok(std::collections::HashMap::new())
}
