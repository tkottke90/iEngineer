mod audio;
mod camera;
mod commands;
mod db;
mod engineer;
mod hotkeys;
mod iracing;
mod redis;
mod state;
mod telemetry;

use commands::*;
use state::AppState;
use tauri::Manager;

pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
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
                redis_url,
            ));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
