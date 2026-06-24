mod audio;
mod camera;
mod commands;
mod db;
mod hotkeys;
mod iracing;
mod redis;
mod state;
mod telemetry;

use commands::*;

pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            list_audio_devices,
            set_audio_device,
            get_connection_status,
            test_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
