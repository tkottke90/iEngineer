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
                .with_handler(|_app, _shortcut, event| {
                    if let Some(tx) = PTT_TX.get() {
                        let pressed = matches!(event.state(), ShortcutState::Pressed);
                        let _ = tx.try_send(pressed);
                    }
                })
                .build(),
        )
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            list_audio_devices,
            set_audio_device,
            test_audio_playback,
            check_redis,
            check_hub,
            get_iracing_status,
            get_session_data,
            list_telemetry_fields,
            get_watchlist,
            set_watchlist,
            get_focused_car_data,
            get_sdk_debug,
        ])
        .setup(|app| {
            // Init logging first so every subsequent task logs to stdout AND the
            // on-disk file (the only way to see audio/STT errors in a Windows
            // release build, where the console is detached).
            logging::init(app.handle());

            iracing::spawn_connection_watcher(app.handle().clone());
            tauri::async_runtime::spawn(telemetry::spawn_publisher_task(app.handle().clone()));
            // Racing Engineer (M4): subscribe to voice:audio and play clips.
            let redis_url = app
                .state::<AppState>()
                .config
                .lock()
                .map(|c| c.redis_url.clone())
                .unwrap_or_default();
            tauri::async_runtime::spawn(engineer::spawn_engineer_task(
                app.handle().clone(),
                redis_url.clone(),
            ));

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
                    .unwrap_or_else(|_| "F13".to_string());
                let (ptt_tx, ptt_rx) = tokio::sync::mpsc::channel::<bool>(32);
                let _ = PTT_TX.set(ptt_tx);
                let ptt_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    engineer::spawn_ptt_pipeline(ptt_app, redis_url, ptt_rx);
                });
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
            #[cfg(not(feature = "stt"))]
            {
                let _ = &redis_url; // consumed by the STT pipeline when built
                tracing::info!("[stt] built without the `stt` feature — push-to-talk disabled (rebuild with --features stt on a native Windows/macOS toolchain)");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
