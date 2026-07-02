pub mod playback_queue;
pub mod ptt_pipeline;
pub mod query_publisher;
pub mod subscriber;

pub use ptt_pipeline::spawn_ptt_pipeline;

use tauri::{AppHandle, Manager};

use crate::state::AppState;
use playback_queue::PlaybackQueue;

/// Spawn the Racing Engineer client: a playback queue plus a `voice:audio`
/// subscriber that resolves clip URLs against the configured `hub_url`.
pub async fn spawn_engineer_task(app_handle: AppHandle, redis_url: String) {
    let (hub_url, output_device) = {
        let state = app_handle.state::<AppState>();
        let cfg = match state.config.lock() {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(error = %e, "[engineer] Failed to read config");
                return;
            }
        };
        (cfg.hub_url.clone(), cfg.audio_output_device.clone())
    };

    let queue = PlaybackQueue::new(output_device);
    let tx = queue.sender();

    // Share the sender so the audio test panel command (T038) can enqueue clips
    // into the same playback queue. The cloned sender keeps the channel (and its
    // receiver task) alive for the process lifetime.
    if let Ok(mut slot) = app_handle.state::<AppState>().engineer_playback_tx.lock() {
        *slot = Some(tx.clone());
    }

    match subscriber::spawn_subscriber(hub_url, &redis_url, tx).await {
        Ok(_handle) => {
            tracing::info!("[engineer] subscriber listening on voice:audio");
        }
        Err(e) => {
            tracing::error!(error = %e, "[engineer] Failed to subscribe to voice:audio");
        }
    }
}
