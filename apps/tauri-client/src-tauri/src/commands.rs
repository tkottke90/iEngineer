use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
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
pub async fn save_config(
    app: tauri::AppHandle,
    config: AppConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // FR-027/I2 disk-first ordering: the local disk save must succeed before
    // any hub sync is attempted. On Err the in-memory state is left untouched
    // so the form retains its unsaved values (FR-027).
    let config = clamp_personality(config);
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot write to config file: app data dir unresolved ({e})"))?;
    config.save_to(&data_dir)?;

    let new_url = config.redis_url.clone();
    let new_hub_url = config.hub_url.clone();
    // Capture the five personality traits for the hub sync before moving `config`.
    let personality = serde_json::json!({
        "openness": config.openness,
        "warmth": config.warmth,
        "energy": config.energy,
        "conscientiousness": config.conscientiousness,
        "assertiveness": config.assertiveness,
    })
    .to_string();
    // T017: hub:config:llm is written only when baseUrl/model DIFFER from the
    // last-persisted values (the in-memory config, which mirrors disk for LLM
    // fields) — avoids spurious Redis writes on unrelated saves. No apiKey in
    // the payload, ever (contracts/hub-llm-config.md).
    let llm_json = serde_json::json!({
        "baseUrl": config.llm_base_url,
        "model": config.llm_model,
    })
    .to_string();
    let redis_url = config.redis_url.clone();
    let mut current = state.config.lock().map_err(|e| e.to_string())?;
    // A hub_url change matters too: the engineer subscriber resolves clip URLs
    // against it, so notify on either so it resubscribes with fresh config.
    let url_changed = current.redis_url != new_url || current.hub_url != new_hub_url;
    let llm_changed =
        current.llm_base_url != config.llm_base_url || current.llm_model != config.llm_model;
    // T017/C2 (Constitution V): audit that the key CHANGED — never its value.
    let api_key_audit = api_key_audit_event(&current.llm_api_key, &config.llm_api_key);
    *current = config;
    drop(current);
    if let Some(has_key) = api_key_audit {
        info!(
            event = "llm-api-key-updated",
            hasKey = has_key,
            "LLM API key updated"
        );
    }
    if url_changed {
        // The watch carries redis_url, but the engineer task re-reads both URLs
        // from config on wake — so sending here applies redis_url and hub_url edits.
        let _ = state.redis_url_watch_tx.send(new_url);
        info!("connection config updated — engineer subscriber will resubscribe");
    }

    // Tauri→hub sync (M5 personality + M10 LLM): one Redis pipeline so both
    // SETs go in a single round-trip — both queued or the whole sync fails
    // together (FR-027 pipeline-batched atomicity). Best-effort — a Redis
    // failure must not block the (already completed) local save; retry happens
    // on the next explicit Save (T017/I4, T039/B2: every Save invocation with
    // a successful local write re-attempts the sync — no skip carries over).
    let sync_app = app.clone();
    tokio::spawn(async move {
        let llm = if llm_changed {
            Some(llm_json.as_str())
        } else {
            None
        };
        if let Err(e) = write_hub_sync(&redis_url, &personality, llm).await {
            tracing::warn!(error = %e, event = "hub-sync-failed", "hub config sync failed (settings saved locally)");
            // T039: surface the non-blocking warning to the settings page —
            // the local save SUCCEEDED and is never rolled back (C2).
            use tauri::Emitter;
            let _ = sync_app.emit(
                "config:hub-sync-failed",
                serde_json::json!({ "reason": e.to_string() }),
            );
        }
    });

    Ok(())
}

/// T025/F3(b) (FR-026): clamp the five personality traits into 1–5 so
/// `save_config` never persists or pipelines an out-of-range value (a
/// corrupted form payload clamps instead of poisoning disk + Redis).
pub(crate) fn clamp_personality(mut config: AppConfig) -> AppConfig {
    let clamp = |v: u8| v.clamp(1, 5);
    config.openness = clamp(config.openness);
    config.warmth = clamp(config.warmth);
    config.energy = clamp(config.energy);
    config.conscientiousness = clamp(config.conscientiousness);
    config.assertiveness = clamp(config.assertiveness);
    config
}

/// T017/C2: Some(has_key) when the API key changed (the audit event to emit),
/// None when unchanged (no event). Pure so the audit decision is unit-testable
/// without capturing tracing output.
pub(crate) fn api_key_audit_event(old_key: &str, new_key: &str) -> Option<bool> {
    if old_key == new_key {
        None
    } else {
        Some(!new_key.is_empty())
    }
}

/// T017/F1: both hub config keys in ONE pipeline (single TCP round-trip). The
/// llm SET is included only when the values changed (differ-guard). Split from
/// the network call so the C1 unit test can assert the pipeline's contents.
pub(crate) fn build_hub_sync_pipe(personality: &str, llm: Option<&str>) -> redis::Pipeline {
    let mut pipe = redis::pipe();
    pipe.cmd("SET")
        .arg("hub:config:personality")
        .arg(personality)
        .ignore();
    if let Some(llm_json) = llm {
        pipe.cmd("SET").arg("hub:config:llm").arg(llm_json).ignore();
    }
    pipe
}

async fn write_hub_sync(
    redis_url: &str,
    personality: &str,
    llm: Option<&str>,
) -> anyhow::Result<()> {
    let client = redis::Client::open(redis_url)?;
    let mut conn = client.get_multiplexed_async_connection().await?;
    let _: () = build_hub_sync_pipe(personality, llm)
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

/// Core of `set_audio_device` (T011), split from the command so unit tests can
/// drive it with a bare `AppState`. Live switch semantics (analysis I1): the
/// selection updates in-memory managed config and signals the running audio
/// task via the watch channel — disk persistence happens ONLY via
/// `save_config()` on an explicit Save (T015), preserving the unsaved-state
/// model and the FR-007 hint lifecycle.
pub(crate) fn apply_audio_device(
    state: &AppState,
    device_name: &str,
    device_type: &str,
) -> Result<(), String> {
    if device_type != "input" && device_type != "output" {
        return Err("invalid device type".into());
    }

    // "" = reset to system default; no lookup needed. A named device must
    // exist in the current cpal list.
    let selected: Option<String> = if device_name.is_empty() {
        None
    } else {
        use cpal::traits::{DeviceTrait, HostTrait};
        let host = cpal::default_host();
        let found = if device_type == "input" {
            host.input_devices()
                .map(|mut it| it.any(|d| d.name().ok().as_deref() == Some(device_name)))
                .unwrap_or(false)
        } else {
            host.output_devices()
                .map(|mut it| it.any(|d| d.name().ok().as_deref() == Some(device_name)))
                .unwrap_or(false)
        };
        if !found {
            return Err(format!("device not found: {device_name}"));
        }
        Some(device_name.to_string())
    };

    {
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        if device_type == "input" {
            cfg.audio_input_device = selected.clone();
        } else {
            cfg.audio_output_device = selected.clone();
        }
    }

    // A (re)selection resolves any startup unavailable record for this type (U1).
    if let Ok(mut unavailable) = state.unavailable_devices.lock() {
        unavailable.retain(|u| u.device_type != device_type);
    }

    let tx = if device_type == "input" {
        &state.audio_input_watch_tx
    } else {
        &state.audio_output_watch_tx
    };
    tx.send(selected).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_audio_device(
    device_name: String,
    device_type: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    apply_audio_device(&state, &device_name, &device_type)
}

/// U1: startup-detected unavailable devices, queryable on Audio tab mount —
/// Tauri events are not replayed, so a tab opened after startup reads this
/// instead of relying on having observed `audio:device-unavailable`.
#[tauri::command]
pub async fn get_audio_device_status(
    state: State<'_, AppState>,
) -> Result<Vec<crate::state::UnavailableDevice>, String> {
    let unavailable = state
        .unavailable_devices
        .lock()
        .map_err(|e| e.to_string())?;
    Ok(unavailable.clone())
}

// ── Debug snapshot (M10 T027, FR-016/FR-017) ──────────────────────────────────

/// Current debug snapshot on demand — the Debug tab's initial load; subsequent
/// updates arrive via the 1Hz `telemetry:debug-snapshot` event (T028).
#[tauri::command]
pub async fn get_debug_snapshot(
    state: State<'_, AppState>,
) -> Result<crate::telemetry::debug_snapshot::DebugSnapshot, String> {
    Ok(crate::telemetry::debug_snapshot::build_snapshot(
        &state,
        crate::telemetry::debug_snapshot::wall_clock_ms(),
    ))
}

// ── Voice profile (M10 T036, FR-021/FR-022/FR-024) ───────────────────────────

/// Persisted profile state from Redis hub:config:voice-profile (data-model.md).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProfileState {
    pub filename: String,
    pub uploaded_at: String,
    pub duration_seconds: f64,
}

/// Transient upload response — testClipUrl is ephemeral, never persisted (B4).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProfileResult {
    pub filename: String,
    pub uploaded_at: String,
    pub duration_seconds: f64,
    #[serde(default)]
    pub test_clip_url: String,
}

/// I1 contract — THREE distinct states, never collapsed: Ok(Some) = profile
/// active; Ok(None) = Redis reachable, key absent ("Default voice (no profile
/// uploaded)"); Err = Redis unreachable ("Redis unreachable — profile status
/// unavailable").
#[tauri::command]
pub async fn get_voice_profile(
    state: State<'_, AppState>,
) -> Result<Option<VoiceProfileState>, String> {
    let redis_url = state
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .redis_url
        .clone();
    let read = async {
        let client = redis::Client::open(redis_url.as_str())?;
        let mut conn = client.get_multiplexed_async_connection().await?;
        let raw: Option<String> = redis::cmd("GET")
            .arg("hub:config:voice-profile")
            .query_async(&mut conn)
            .await?;
        anyhow::Ok(raw)
    };
    let raw = match tokio::time::timeout(std::time::Duration::from_secs(3), read).await {
        Ok(Ok(raw)) => raw,
        Ok(Err(e)) => {
            tracing::warn!(event = "voice-profile-read-failed", reason = %e, "voice profile read failed");
            return Err(format!("Redis unreachable: {e}"));
        }
        Err(_) => {
            tracing::warn!(
                event = "voice-profile-read-failed",
                reason = "timeout",
                "voice profile read failed"
            );
            return Err("Redis unreachable: timeout".into());
        }
    };
    match raw {
        None => Ok(None),
        Some(json) => match serde_json::from_str::<VoiceProfileState>(&json) {
            Ok(profile) => Ok(Some(profile)),
            Err(e) => {
                tracing::warn!(event = "voice-profile-read-failed", reason = %e, "stored profile malformed — treating as absent");
                Ok(None)
            }
        },
    }
}

/// Canonical MP3 magic bytes — data-model.md "MP3 magic byte sequences
/// (shared reference)"; the hub re-checks the same list as its second gate.
pub(crate) fn is_mp3_magic(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xff, 0xfb])
        || bytes.starts_with(&[0xff, 0xf3])
        || bytes.starts_with(&[0xff, 0xf2])
        || bytes.starts_with(&[0x49, 0x44, 0x33])
}

/// Upload core with an injectable timeout (tests don't wait 90 real seconds).
/// Every Err path emits the D2 structured warn before returning.
pub(crate) async fn upload_voice_profile_core(
    hub_url: &str,
    file_name: &str,
    bytes: Vec<u8>,
    timeout: std::time::Duration,
) -> Result<VoiceProfileResult, String> {
    let fail = |reason: String| {
        tracing::warn!(event = "voice-profile-upload-failed", reason = %reason, "voice profile upload failed");
        reason
    };

    // Client-side first gate (FR-022): wrong format never makes a request.
    if !is_mp3_magic(&bytes) {
        return Err(fail("File must be an MP3".into()));
    }

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name.to_string())
        .mime_str("audio/mpeg")
        .map_err(|e| fail(e.to_string()))?;
    let form = reqwest::multipart::Form::new().part("audio", part);

    let base = hub_url.trim_end_matches('/');
    let resp = reqwest::Client::new()
        .post(format!("{base}/api/voice-profile"))
        .multipart(form)
        // 90s client budget: 50s hub processing (T034/C4b) + transfer margin.
        .timeout(timeout)
        .send()
        .await;

    match resp {
        Err(e) if e.is_timeout() => Err(fail(
            "Upload timed out — hub did not respond within 90s".into(),
        )),
        Err(e) => Err(fail(format!("upload failed: {e}"))),
        Ok(r) if !r.status().is_success() => {
            let status = r.status();
            let body = r.text().await.unwrap_or_default();
            // Surface the hub's human-readable message when present.
            let message = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
                .unwrap_or_else(|| format!("hub returned {status}"));
            Err(fail(message))
        }
        Ok(r) => r
            .json::<VoiceProfileResult>()
            .await
            .map_err(|e| fail(format!("invalid hub response: {e}"))),
    }
}

/// Contract form (contracts/tauri-commands.md): upload from a filesystem path.
#[tauri::command]
pub async fn upload_voice_profile(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<VoiceProfileResult, String> {
    let bytes = std::fs::read(&file_path).map_err(|e| {
        tracing::warn!(event = "voice-profile-upload-failed", reason = %e, "cannot read file");
        format!("cannot read file: {e}")
    })?;
    let name = std::path::Path::new(&file_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "upload.mp3".into());
    let hub_url = state
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .hub_url
        .clone();
    upload_voice_profile_core(&hub_url, &name, bytes, std::time::Duration::from_secs(90)).await
}

/// UI form: the webview's file input exposes bytes but no real filesystem path
/// (Tauri v2 sandbox), so the Voice tab sends the content directly. Same core
/// (gates, timeout, errors) as the path-based contract command.
#[tauri::command]
pub async fn upload_voice_profile_data(
    file_name: String,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<VoiceProfileResult, String> {
    let hub_url = state
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .hub_url
        .clone();
    upload_voice_profile_core(
        &hub_url,
        &file_name,
        data,
        std::time::Duration::from_secs(90),
    )
    .await
}

// ── Telemetry logging toggle (M10 T031, FR-019/FR-020) ───────────────────────

/// Enable/disable raw telemetry logging. Path validation happens HERE at
/// toggle time (T031/C4 — not deferred to session start), with the two
/// distinct failure messages from U2. The enabled flag persists to disk
/// immediately so it survives restarts.
#[tauri::command]
pub async fn toggle_telemetry_logging(
    enabled: bool,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let toggle_failed = |reason: String| {
        // Constitution V: no silent failures.
        tracing::warn!(
            event = "telemetry-logging-toggle-failed",
            reason = %reason,
            "telemetry logging toggle failed"
        );
        reason
    };

    let dir_str = state
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .telemetry_log_dir
        .clone();
    let dir = if enabled {
        crate::telemetry::logger::validate_log_dir(&dir_str).map_err(toggle_failed)?
    } else {
        std::path::PathBuf::from(dir_str)
    };

    let handle = state
        .telemetry_logger
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| toggle_failed("logger task not running".into()))?;
    handle.set_enabled(enabled, dir);

    // Persist the flag (survives restart — FR-025). Like the PTT auto-save,
    // this must NOT flip first_launch_seen (T022/A2 applies to any implicit
    // save path).
    let updated = {
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.telemetry_logging_enabled = enabled;
        cfg.clone()
    };
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| toggle_failed(format!("cannot persist toggle: {e}")))?;
    updated.save_to(&data_dir).map_err(toggle_failed)?;
    Ok(())
}

// ── PTT hotkey binding (M10 T022, FR-010/FR-011) ─────────────────────────────

/// Bind a new global PTT shortcut: enter a 10s listening window (the frontend
/// captures the next keypress and delivers it via `submit_ptt_key`), register
/// it OS-globally, and auto-save the config (T022/C5 — a bound key must
/// survive restarts without a Save-button press).
///
/// Error codes (contracts/tauri-commands.md, I1): `ptt:timeout`,
/// `ptt:key-conflict`, `ptt:accessibility-denied`, `ptt:capture-in-progress`.
/// Every Err path emits a structured `ptt-bind-failed` warn (Constitution V).
#[tauri::command]
pub async fn bind_ptt_hotkey(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use crate::hotkeys::ptt::{await_capture, classify_register_error};
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let bind_failed = |reason: &str, detail: Option<&str>| {
        tracing::warn!(
            event = "ptt-bind-failed",
            reason = %reason,
            detail = detail.unwrap_or(""),
            "PTT binding failed"
        );
        reason.to_string()
    };

    // T022/U2: a rebind while the PTT key is physically held is refused — the
    // active capture completes normally; the driver re-initiates afterward.
    if state
        .ptt_key_held
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        return Err(bind_failed("ptt:capture-in-progress", None));
    }

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    {
        let mut slot = state.ptt_capture_slot.lock().map_err(|e| e.to_string())?;
        // Superseding a stale session drops its sender → that session times out.
        *slot = Some(tx);
    }

    let captured = match await_capture(rx, std::time::Duration::from_secs(10)).await {
        Ok(key) => key,
        Err(code) => {
            if let Ok(mut slot) = state.ptt_capture_slot.lock() {
                *slot = None;
            }
            return Err(bind_failed(&code, None));
        }
    };

    let old_key = state
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .ptt_hotkey
        .clone();

    let shortcut: tauri_plugin_global_shortcut::Shortcut = captured
        .parse()
        .map_err(|e| bind_failed("ptt:key-conflict", Some(&format!("unparseable key: {e:?}"))))?;

    // Swap the OS registration: drop the old binding, register the new one; on
    // failure re-register the old key so a working binding is never lost (T024).
    if !old_key.is_empty() {
        if let Ok(old_shortcut) = old_key.parse::<tauri_plugin_global_shortcut::Shortcut>() {
            let _ = app.global_shortcut().unregister(old_shortcut);
        }
    }
    if let Err(e) = app.global_shortcut().register(shortcut) {
        let code = classify_register_error(&e.to_string());
        if !old_key.is_empty() {
            if let Ok(old_shortcut) = old_key.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                let _ = app.global_shortcut().register(old_shortcut);
            }
        }
        return Err(bind_failed(code, Some(&e.to_string())));
    }

    // T022/C5 auto-save. A2: this path MUST NOT set first_launch_seen — only an
    // explicit Save-button save suppresses the first-launch LLM hint.
    let updated = {
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        cfg.ptt_hotkey = captured.clone();
        cfg.clone()
    };
    let save_result = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())
        .and_then(|dir| updated.save_to(&dir));
    if let Err(reason) = save_result {
        // U2: the binding WORKS for this session — do not roll it back over a
        // disk error. Surface the persistence gap; the next explicit Save
        // (which writes the full config incl. ptt_hotkey) recovers it.
        use tauri::Emitter;
        tracing::warn!(event = "ptt-save-failed", reason = %reason, "PTT key bound but config save failed");
        let _ = app.emit("ptt:save-failed", serde_json::json!({ "reason": reason }));
    }

    Ok(captured)
}

/// Deliver the key captured by the frontend's keydown handler while a
/// `bind_ptt_hotkey` listening window is open (T022). A call with no pending
/// session is a harmless no-op (e.g. a keypress racing the 10s timeout).
#[tauri::command]
pub async fn submit_ptt_key(key: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut slot) = state.ptt_capture_slot.lock() {
        if let Some(tx) = slot.take() {
            let _ = tx.send(key);
        }
    }
    Ok(())
}

/// FR-028: open the macOS Accessibility preferences pane directly (the
/// "Open Accessibility Settings" button in the Hotkeys tab). Not shown on
/// Windows (T023/C5).
#[tauri::command]
pub async fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(crate::hotkeys::ptt::MACOS_ACCESSIBILITY_PREFS_URI)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    Err("Accessibility settings pane is macOS-only".into())
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

/// T019: connectivity test result for the Connection tab's per-service "Test"
/// buttons (contracts/tauri-commands.md).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub service: String,
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

/// Core of `check_llm` with an injectable timeout so the timeout path is
/// testable without waiting 5 real seconds. Probes `GET {base_url}/models`
/// ONLY — a non-inference endpoint.
// MUST NOT call synthesis endpoint — audit gate exemption depends on this
// (FR-008/D3: any completions/inference call counts as synthesis regardless of
// token count and would require an engineer_events row).
pub(crate) async fn check_llm_at(
    base_url: &str,
    api_key: &str,
    timeout: std::time::Duration,
) -> ConnectionTestResult {
    let fail = |error: &str| {
        // Constitution V: no silent failures.
        tracing::warn!(
            event = "llm-connectivity-check-failed",
            reason = %error,
            "LLM connectivity check failed"
        );
        ConnectionTestResult {
            service: "llm".into(),
            ok: false,
            latency_ms: None,
            error: Some(error.to_string()),
        }
    };

    if reqwest::Url::parse(base_url).is_err() {
        return fail("invalid URL");
    }
    let endpoint = format!("{}/models", base_url.trim_end_matches('/'));

    let mut req = reqwest::Client::new().get(&endpoint).timeout(timeout);
    // data-model.md: "" is the canonical no-auth sentinel — no header sent.
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }

    let start = std::time::Instant::now();
    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                ConnectionTestResult {
                    service: "llm".into(),
                    ok: true,
                    latency_ms: Some(start.elapsed().as_millis() as u64),
                    error: None,
                }
            } else if status.as_u16() == 401 {
                fail("HTTP 401 — check API key")
            } else if status.as_u16() == 404 {
                fail("HTTP 404 — verify base URL and model path")
            } else {
                fail(&format!("HTTP {} — unexpected response", status.as_u16()))
            }
        }
        Err(e) if e.is_timeout() => fail("timeout after 5s"),
        Err(_) => fail("connection refused"),
    }
}

/// T019 (FR-008): probe the LLM endpoint's connectivity + auth. The `model`
/// param is part of the command contract but unused by the /models probe — it
/// exists so a future model-listing check can validate it without a signature
/// change.
#[tauri::command]
pub async fn check_llm(
    base_url: String,
    #[allow(unused_variables)] model: String,
    api_key: String,
) -> Result<ConnectionTestResult, String> {
    Ok(check_llm_at(&base_url, &api_key, std::time::Duration::from_secs(5)).await)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::UnavailableDevice;

    /// T016: invalid device_type is rejected before any device lookup.
    #[test]
    fn set_audio_device_rejects_invalid_type() {
        let state = AppState::default();
        assert_eq!(
            apply_audio_device(&state, "Some Mic", "sideways"),
            Err("invalid device type".into())
        );
    }

    /// T016: a name matching no device in the cpal list → specific Err.
    #[test]
    fn set_audio_device_rejects_unknown_device() {
        let state = AppState::default();
        let err = apply_audio_device(&state, "definitely-not-a-real-device-9c41", "input")
            .expect_err("unknown device must be rejected");
        assert_eq!(err, "device not found: definitely-not-a-real-device-9c41");
    }

    /// T017/C1: one pipeline carrying BOTH hub config SETs when the LLM
    /// values changed (fixture precondition per I2), and personality-only when
    /// they did not — the differ-guard working as designed. Fails if the
    /// implementation ever switches back to sequential SET calls.
    #[test]
    fn hub_sync_pipe_batches_both_keys_when_llm_changed() {
        let both = build_hub_sync_pipe("{\"energy\":3}", Some("{\"model\":\"m\"}"));
        let packed = String::from_utf8_lossy(&both.get_packed_pipeline()).into_owned();
        assert!(packed.contains("hub:config:personality"));
        assert!(packed.contains("hub:config:llm"));

        let unchanged = build_hub_sync_pipe("{\"energy\":3}", None);
        let packed = String::from_utf8_lossy(&unchanged.get_packed_pipeline()).into_owned();
        assert!(packed.contains("hub:config:personality"));
        assert!(
            !packed.contains("hub:config:llm"),
            "unchanged LLM values must not produce a hub:config:llm SET"
        );
    }

    /// T025/F3(b) + T026 (FR-026): out-of-range traits clamp to 1-5 before
    /// any persist/pipeline; in-range values (incl. the meaningful energy=1
    /// Quiet mode) pass through untouched.
    #[test]
    fn personality_traits_clamped_before_persist() {
        let mut config = AppConfig::default();
        config.energy = 0;
        config.warmth = 7;
        config.openness = 1;
        let clamped = clamp_personality(config);
        assert_eq!(clamped.energy, 1);
        assert_eq!(clamped.warmth, 5);
        assert_eq!(clamped.openness, 1, "in-range values must not be altered");

        // T026: energy=1 (Quiet mode) survives into the hub-sync personality
        // payload — the clamp must not erase the suppression setting.
        let payload = serde_json::json!({ "energy": clamped.energy }).to_string();
        let pipe = build_hub_sync_pipe(&payload, None);
        let packed = String::from_utf8_lossy(&pipe.get_packed_pipeline()).into_owned();
        assert!(packed.contains("\"energy\":1"));
    }

    /// T017/C2-D2: the api-key audit fires exactly on change, carries only a
    /// has-key boolean, and stays silent when the key is unchanged.
    #[test]
    fn api_key_audit_event_fires_only_on_change() {
        assert_eq!(api_key_audit_event("", "sk-new"), Some(true));
        assert_eq!(api_key_audit_event("sk-old", ""), Some(false));
        assert_eq!(api_key_audit_event("sk-same", "sk-same"), None);
        assert_eq!(api_key_audit_event("", ""), None);
    }

    /// T039/C2 (FR-027 inverse): a successful local disk save is NOT rolled
    /// back when the hub Redis sync fails afterwards — the file keeps the new
    /// values; only the sync warning surfaces.
    #[tokio::test]
    async fn local_save_survives_hub_sync_failure() {
        let dir = std::env::temp_dir().join(format!("irc-t039-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // Disk-first save with NEW values succeeds…
        let mut config = AppConfig::default();
        config.llm_model = "new-model-after-sync-failure".into();
        config.save_to(&dir).expect("local save succeeds");

        // …then the hub sync fails (nothing listens on port 1).
        let sync = write_hub_sync(
            "redis://127.0.0.1:1",
            "{\"energy\":3}",
            Some("{\"model\":\"new-model-after-sync-failure\"}"),
        )
        .await;
        assert!(sync.is_err(), "sync against a dead redis must fail");

        // The config on disk still contains the new values — no rollback.
        let reloaded = AppConfig::load_from(&dir);
        assert_eq!(reloaded.llm_model, "new-model-after-sync-failure");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── T036/C3 (I1): upload_voice_profile Rust-side unit tests ──

    #[test]
    fn mp3_magic_byte_gate() {
        assert!(is_mp3_magic(&[0xff, 0xfb, 0x90]));
        assert!(is_mp3_magic(&[0xff, 0xf3, 0x00]));
        assert!(is_mp3_magic(&[0xff, 0xf2, 0x00]));
        assert!(is_mp3_magic(&[0x49, 0x44, 0x33, 0x04])); // ID3
        assert!(!is_mp3_magic(&[0x52, 0x49, 0x46, 0x46])); // RIFF/WAV
        assert!(!is_mp3_magic(&[]));
    }

    #[tokio::test]
    async fn upload_rejects_wrong_format_without_network() {
        // No listener anywhere — a network attempt would error differently;
        // the format gate must reject BEFORE any request (FR-022).
        let err = upload_voice_profile_core(
            "http://127.0.0.1:1",
            "clip.wav",
            vec![0x52, 0x49, 0x46, 0x46],
            std::time::Duration::from_secs(1),
        )
        .await
        .expect_err("wrong format must fail");
        assert_eq!(err, "File must be an MP3");
    }

    #[tokio::test]
    async fn upload_surfaces_hub_error_message_on_non_2xx() {
        // content-length computed from the actual body — a mismatch makes
        // reqwest hand back a truncated/padded body that fails JSON parsing.
        const BODY: &str =
            "{\"error\":\"duration-out-of-range\",\"message\":\"Audio must be between 3 and 60 seconds\"}";
        let response: &'static str = Box::leak(
            format!(
                "HTTP/1.1 422 Unprocessable Entity\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                BODY.len(),
                BODY
            )
            .into_boxed_str(),
        );
        let (base_url, _handle) = spawn_http_stub(response).await;
        let err = upload_voice_profile_core(
            &base_url,
            "clip.mp3",
            vec![0xff, 0xfb, 0x90, 0x00],
            std::time::Duration::from_secs(2),
        )
        .await
        .expect_err("non-2xx must surface the hub message");
        assert!(
            err.contains("Audio must be between 3 and 60 seconds"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn upload_timeout_uses_contract_message() {
        use tokio::io::AsyncReadExt;
        // Accepts but never responds; the injectable timeout keeps this fast.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let _hold = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let _ = sock.read(&mut buf).await;
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        });
        let err = upload_voice_profile_core(
            &format!("http://{addr}"),
            "clip.mp3",
            vec![0xff, 0xfb, 0x90, 0x00],
            std::time::Duration::from_millis(250),
        )
        .await
        .expect_err("timeout must fail");
        assert_eq!(err, "Upload timed out — hub did not respond within 90s");
    }

    // ── T019/G2: check_llm error taxonomy against a scripted local listener ──

    async fn spawn_http_stub(response: &'static str) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            buf.truncate(n);
            sock.write_all(response.as_bytes()).await.unwrap();
            sock.shutdown().await.ok();
            buf
        });
        (format!("http://{addr}/v1"), handle)
    }

    #[tokio::test]
    async fn check_llm_taxonomy_http_statuses() {
        for (resp, expected) in [
            (
                "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n",
                "HTTP 401 — check API key",
            ),
            (
                "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n",
                "HTTP 404 — verify base URL and model path",
            ),
            (
                "HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n",
                "HTTP 503 — unexpected response",
            ),
        ] {
            let (base_url, _handle) = spawn_http_stub(resp).await;
            let result = check_llm_at(&base_url, "", std::time::Duration::from_secs(2)).await;
            assert!(!result.ok);
            assert_eq!(result.error.as_deref(), Some(expected));
            assert_eq!(result.latency_ms, None);
        }
    }

    #[tokio::test]
    async fn check_llm_success_reports_latency_and_no_auth_header_when_key_empty() {
        let (base_url, handle) =
            spawn_http_stub("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}").await;
        let result = check_llm_at(&base_url, "", std::time::Duration::from_secs(2)).await;
        assert!(result.ok);
        assert!(result.latency_ms.is_some());
        assert_eq!(result.error, None);
        // data-model.md empty-key sentinel: no Authorization header sent.
        let request = String::from_utf8_lossy(&handle.await.unwrap()).to_lowercase();
        assert!(request.starts_with("get /v1/models"));
        assert!(!request.contains("authorization:"));
    }

    #[tokio::test]
    async fn check_llm_sends_bearer_header_when_key_present() {
        let (base_url, handle) =
            spawn_http_stub("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}").await;
        let result = check_llm_at(&base_url, "sk-test", std::time::Duration::from_secs(2)).await;
        assert!(result.ok);
        let request = String::from_utf8_lossy(&handle.await.unwrap()).into_owned();
        assert!(
            request.contains("authorization: Bearer sk-test")
                || request.contains("Authorization: Bearer sk-test")
        );
    }

    #[tokio::test]
    async fn check_llm_connection_refused_and_invalid_url() {
        // Bind + drop to get a port with nothing listening.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let refused = check_llm_at(
            &format!("http://127.0.0.1:{port}/v1"),
            "",
            std::time::Duration::from_secs(2),
        )
        .await;
        assert_eq!(refused.error.as_deref(), Some("connection refused"));

        let invalid = check_llm_at("not a url at all", "", std::time::Duration::from_secs(2)).await;
        assert_eq!(invalid.error.as_deref(), Some("invalid URL"));
    }

    #[tokio::test]
    async fn check_llm_timeout_path() {
        use tokio::io::AsyncReadExt;
        // Accepts the connection but never responds — the injectable timeout
        // keeps the test fast while exercising the real timeout branch.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let _hold = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = sock.read(&mut buf).await;
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        });
        let result = check_llm_at(
            &format!("http://{addr}/v1"),
            "",
            std::time::Duration::from_millis(200),
        )
        .await;
        assert_eq!(result.error.as_deref(), Some("timeout after 5s"));
    }

    /// T016: a valid selection signals the watch channel, updates in-memory
    /// config, and clears the type's unavailable record (U1). Uses the ""
    /// reset-to-default path so the test needs no real audio hardware.
    #[test]
    fn set_audio_device_signals_watch_and_clears_unavailable() {
        let state = AppState::default();
        // Simulate a startup where the saved output device was missing…
        state
            .unavailable_devices
            .lock()
            .unwrap()
            .push(UnavailableDevice {
                device_type: "output".into(),
                saved_name: "Ghost Speaker".into(),
            });
        // …and a stale selection on the channel.
        state
            .audio_output_watch_tx
            .send_replace(Some("Ghost Speaker".into()));

        let rx = state.audio_output_watch_tx.subscribe();
        apply_audio_device(&state, "", "output").expect("reset to default must succeed");

        assert_eq!(
            *rx.borrow(),
            None,
            "watch channel must carry the new selection"
        );
        assert_eq!(
            state.config.lock().unwrap().audio_output_device,
            None,
            "in-memory config must reflect the live selection"
        );
        assert!(
            state.unavailable_devices.lock().unwrap().is_empty(),
            "reselection clears the unavailable record for that type"
        );
    }
}
