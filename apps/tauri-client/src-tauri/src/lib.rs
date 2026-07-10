mod audio;
mod camera;
mod commands;
mod db;
mod engineer;
mod hotkeys;
mod iracing;
mod logging;
mod redis;
mod state;
#[cfg(feature = "stt")]
mod stt;
mod telemetry;

use commands::*;
use state::AppState;
use std::sync::OnceLock;
use tauri::Manager;
use tauri_plugin_global_shortcut::ShortcutState;

// PTT press/release events from the global-shortcut handler are forwarded here to
// the capture pipeline. The handler is registered at plugin-build time (before the
// channel exists), so it reads the sender from this OnceLock, set during setup.
static PTT_TX: OnceLock<tokio::sync::mpsc::Sender<bool>> = OnceLock::new();

pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    let pressed = matches!(event.state(), ShortcutState::Pressed);
                    if let Some(tx) = PTT_TX.get() {
                        let _ = tx.try_send(pressed);
                    }
                    // M10: track the held state (bind_ptt_hotkey refuses a
                    // rebind mid-capture, T022/U2) and drive the Hotkeys tab's
                    // PTT-active indicator — the SC-003 confirmation signal
                    // (T023/A1; the mic meter is always-on and can't confirm
                    // the shortcut fired).
                    if let Some(state) = app.try_state::<state::AppState>() {
                        state
                            .ptt_key_held
                            .store(pressed, std::sync::atomic::Ordering::Relaxed);
                    }
                    use tauri::Emitter;
                    let _ = app.emit("ptt:state", serde_json::json!({ "active": pressed }));
                })
                .build(),
        )
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            list_audio_devices,
            set_audio_device,
            get_audio_device_status,
            test_audio_playback,
            check_redis,
            check_hub,
            check_llm,
            bind_ptt_hotkey,
            submit_ptt_key,
            open_accessibility_settings,
            get_iracing_status,
            get_session_data,
            list_telemetry_fields,
            get_watchlist,
            set_watchlist,
            get_focused_car_data,
            get_sdk_debug,
            get_debug_snapshot,
            toggle_telemetry_logging,
            get_voice_profile,
            upload_voice_profile,
            upload_voice_profile_data,
        ])
        .setup(|app| {
            // Init logging first so every subsequent task logs to stdout AND the
            // on-disk file (the only way to see audio/STT errors in a Windows
            // release build, where the console is detached).
            logging::init(app.handle());

            // M10 T001: load the persisted config from disk before anything reads
            // it, resolve the telemetry_log_dir sentinel (Default::default() cannot
            // call app_data_dir()), and persist the resolved path back so every
            // later read sees an absolute path. If the app data dir itself cannot
            // be resolved, the sentinel stays "" and the Logging tab shows its
            // error state with the toggle disabled (FR-019/U3) — nothing crashes.
            match app.path().app_data_dir() {
                Ok(data_dir) => {
                    let mut loaded = state::AppConfig::load_from(&data_dir);
                    if loaded.telemetry_log_dir.is_empty() {
                        loaded.telemetry_log_dir = data_dir
                            .join("logs")
                            .join("telemetry")
                            .to_string_lossy()
                            .into_owned();
                    }
                    if let Err(e) = loaded.save_to(&data_dir) {
                        tracing::warn!(error = %e, "could not persist resolved config at startup");
                    }
                    if let Ok(mut cfg) = app.state::<AppState>().config.lock() {
                        *cfg = loaded;
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "app data dir unresolved — settings will not persist this session");
                }
            }

            // M10 T014: seed the audio-device watch channels from the loaded
            // config, checking availability first. A saved device that is gone
            // falls back to the system default AT RUNTIME (the saved value
            // stays on disk so replugging works next launch), is recorded in
            // managed state for the Audio tab's mount-time query (U1), and is
            // announced via `audio:device-unavailable`. Each type is handled
            // independently (C4) — both failing yields two records/events.
            {
                use tauri::Emitter;
                let state = app.state::<AppState>();
                let (saved_input, saved_output) = {
                    let cfg = state.config.lock().expect("config mutex poisoned at startup");
                    (cfg.audio_input_device.clone(), cfg.audio_output_device.clone())
                };
                for (device_type, saved, tx) in [
                    ("input", saved_input, &state.audio_input_watch_tx),
                    ("output", saved_output, &state.audio_output_watch_tx),
                ] {
                    let names = audio::device_names(device_type);
                    if names.is_empty() {
                        // No hardware of this direction at all (headless/VM):
                        // disable gracefully; the Audio tab shows the per-type
                        // FR-002 message (T015/U1 owns the display strings).
                        tracing::warn!(device_type, "[audio] no audio devices found — subsystem disabled for this direction");
                        let _ = app.emit(
                            "audio:no-devices",
                            serde_json::json!({ "deviceType": device_type }),
                        );
                    }
                    let seed = match saved {
                        Some(name) if !names.contains(&name) => {
                            tracing::warn!(device_type, saved = %name, "[audio] saved device unavailable — using system default");
                            let record = state::UnavailableDevice {
                                device_type: device_type.into(),
                                saved_name: name,
                            };
                            if let Ok(mut list) = state.unavailable_devices.lock() {
                                list.push(record.clone());
                            }
                            let _ = app.emit("audio:device-unavailable", record);
                            None
                        }
                        other => other,
                    };
                    let _ = tx.send_replace(seed);
                }
            }

            iracing::spawn_connection_watcher(app.handle().clone());
            tauri::async_runtime::spawn(telemetry::spawn_publisher_task(app.handle().clone()));
            // M10 US5 (T028): 1Hz debug snapshot loop — collects the fixed
            // telemetry set, probes the hub, and emits telemetry:debug-snapshot
            // while a session is active.
            tauri::async_runtime::spawn(telemetry::debug_snapshot::spawn_debug_loop(
                app.handle().clone(),
            ));

            // M10 US7 (T030/T031): telemetry log writer + warning forwarder.
            {
                use tauri::Emitter;
                let (logger_handle, mut warn_rx) =
                    telemetry::logger::spawn_logger(telemetry::logger::CHANNEL_CAPACITY);
                let warn_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    while let Some(warning) = warn_rx.recv().await {
                        let _ = warn_app.emit("telemetry:log-warning", &warning);
                    }
                });
                // Toggle saved as enabled last session → resume logging now
                // (validate quietly; a failure surfaces in the Logging tab).
                let (was_enabled, log_dir) = {
                    let cfg = app
                        .state::<AppState>()
                        .config
                        .lock()
                        .expect("config mutex poisoned at startup")
                        .clone();
                    (cfg.telemetry_logging_enabled, cfg.telemetry_log_dir)
                };
                if was_enabled {
                    match telemetry::logger::validate_log_dir(&log_dir) {
                        Ok(dir) => logger_handle.set_enabled(true, dir),
                        Err(e) => tracing::warn!(
                            event = "telemetry-logging-toggle-failed",
                            reason = %e,
                            "saved logging toggle could not resume at startup"
                        ),
                    }
                }
                if let Ok(mut slot) = app.state::<AppState>().telemetry_logger.lock() {
                    *slot = Some(logger_handle);
                }
            }
            // Racing Engineer (M4): subscribe to voice:audio and play clips.
            let redis_url = app
                .state::<AppState>()
                .config
                .lock()
                .map(|c| c.redis_url.clone())
                .unwrap_or_default();
            tauri::async_runtime::spawn(engineer::spawn_engineer_task(app.handle().clone()));

            // Push-to-talk (M5 US1): global hotkey → capture → local Whisper STT →
            // publish engineer:query. The global shortcut works while the sim is
            // focused; a Stream Deck key maps to the same shortcut (FR-003). Only
            // wired when the `stt` feature is built (whisper.cpp) — see Cargo.toml.
            #[cfg(feature = "stt")]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let ptt_key = app
                    .state::<AppState>()
                    .config
                    .lock()
                    .map(|c| c.ptt_hotkey.clone())
                    .unwrap_or_default();
                let (ptt_tx, ptt_rx) = tokio::sync::mpsc::channel::<bool>(32);
                let _ = PTT_TX.set(ptt_tx);
                let ptt_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    engineer::spawn_ptt_pipeline(ptt_app, redis_url, ptt_rx);
                });
                // T001/I1: "" is the never-configured sentinel — a valid state,
                // not an error. Skip registration; the Hotkeys tab shows the
                // first-run prompt (no FR-012 banner).
                if ptt_key.is_empty() {
                    tracing::info!("[stt] no PTT key configured — skipping global shortcut registration (bind one in Settings → Hotkeys)");
                } else {
                    match ptt_key.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                        Ok(shortcut) => {
                            if let Err(e) = app.global_shortcut().register(shortcut) {
                                tracing::warn!(error = %e, key = %ptt_key, "[stt] failed to register global PTT shortcut (check OS accessibility permission)");
                            } else {
                                tracing::info!(key = %ptt_key, "[stt] global PTT shortcut registered");
                            }
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, key = %ptt_key, "[stt] invalid PTT hotkey — PTT disabled");
                        }
                    }
                }
            }
            #[cfg(not(feature = "stt"))]
            {
                let _ = &redis_url; // consumed by the STT pipeline when built
                // Whisper never loads in a non-stt build — surface that as
                // "Load failed" in the Debug tab rather than "Loading…" forever.
                app.state::<AppState>().debug.whisper_status.store(
                    telemetry::debug_snapshot::WHISPER_FAILED,
                    std::sync::atomic::Ordering::Relaxed,
                );
                // FR-005 (manual-test finding 2.3): the mic level meter's data
                // source (audio:mic-level) is emitted by the capture stream,
                // which previously started only inside the stt-gated PTT
                // pipeline — leaving the Audio tab meter dead in default
                // builds. Start a METER-ONLY capture here: the PTT gate sender
                // is dropped immediately, so the recording gate never arms and
                // on_audio never fires — this is purely the level meter.
                let meter_rx = app.state::<AppState>().audio_input_watch_tx.subscribe();
                let meter_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let (gate_tx, gate_rx) = tokio::sync::mpsc::channel::<bool>(1);
                    drop(gate_tx);
                    let capture = audio::capture::AudioCapture::new(meter_rx);
                    if let Err(e) = capture.start(meter_app, gate_rx, |_samples, _rate| {}) {
                        tracing::warn!(error = %e, "[audio] meter-only capture failed to start");
                    }
                });
                tracing::info!("[stt] built without the `stt` feature — push-to-talk disabled (rebuild with --features stt on a native Windows/macOS toolchain)");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
