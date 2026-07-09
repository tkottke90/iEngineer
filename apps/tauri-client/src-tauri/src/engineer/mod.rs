pub mod playback_queue;
pub mod subscriber;
// STT-only modules (whisper.cpp) — see the `stt` feature in Cargo.toml.
#[cfg(feature = "stt")]
pub mod ptt_pipeline;
#[cfg(feature = "stt")]
pub mod query_publisher;

#[cfg(feature = "stt")]
pub use ptt_pipeline::spawn_ptt_pipeline;

use std::time::Duration;

use tauri::{AppHandle, Manager};
use tokio::sync::watch;

use crate::state::AppState;
use playback_queue::PlaybackQueue;

/// Spawn the Racing Engineer client: a playback queue plus a supervised
/// `voice:audio` subscriber that resolves clip URLs against the configured
/// `hub_url`.
///
/// The subscriber is re-established whenever the Redis/hub URL is saved in Setup
/// (via `redis_url_watch_tx`), and retries with backoff if a connect fails or the
/// connection drops — so a config fix takes effect without restarting the client,
/// and a subscriber that failed at startup (e.g. Redis not yet reachable) heals
/// itself instead of staying dead.
pub async fn spawn_engineer_task(app_handle: AppHandle) {
    // Subscribe to config-change notifications BEFORE the first connect so a save
    // that lands during startup is not missed. `changed()` fires on the next
    // `send`, not the current value, so we won't spuriously reconnect immediately.
    let mut url_rx = app_handle
        .state::<AppState>()
        .redis_url_watch_tx
        .subscribe();

    // The playback queue (and its sender) is created ONCE and reused across every
    // re-subscription, so the queue receiver — and the audio-test-panel sender slot
    // (T038) — stay valid for the process lifetime. The output device is read from
    // the watch channel per clip (T013), so a change in Settings needs no restart.
    let output_rx = app_handle
        .state::<AppState>()
        .audio_output_watch_tx
        .subscribe();
    let queue = PlaybackQueue::new(output_rx);
    let tx = queue.sender();
    if let Ok(mut slot) = app_handle.state::<AppState>().engineer_playback_tx.lock() {
        *slot = Some(tx.clone());
    }

    let min_backoff = Duration::from_millis(200);
    let max_backoff = Duration::from_secs(5);
    let mut backoff = min_backoff;

    loop {
        // Re-read redis_url + hub_url fresh on each (re)subscribe so a saved change
        // is picked up. hub_url matters here too: the subscriber resolves clip URLs
        // against it.
        let (redis_url, hub_url) = {
            let state = app_handle.state::<AppState>();
            let cfg = match state.config.lock() {
                Ok(c) => c,
                Err(e) => {
                    tracing::error!(error = %e, "[engineer] Failed to read config");
                    return;
                }
            };
            (cfg.redis_url.clone(), cfg.hub_url.clone())
        };

        match subscriber::spawn_subscriber(hub_url, &redis_url, tx.clone()).await {
            Ok(mut handle) => {
                backoff = min_backoff;
                tracing::info!(redis_url = %redis_url, "[engineer] subscriber listening on voice:audio");
                tokio::select! {
                    // Stream ended (connection dropped) → reconnect after a short,
                    // interruptible backoff.
                    _ = &mut handle => {
                        tracing::warn!("[engineer] voice:audio subscription ended — reconnecting");
                        interruptible_sleep(backoff, &mut url_rx).await;
                        backoff = (backoff * 2).min(max_backoff);
                    }
                    // Redis/hub URL saved in Setup → tear down and resubscribe now.
                    changed = url_rx.changed() => {
                        if changed.is_err() {
                            return; // watch sender dropped — app shutting down.
                        }
                        // Dropping a JoinHandle detaches the task; abort to actually
                        // close the stale connection before we open a new one.
                        handle.abort();
                        backoff = min_backoff;
                        tracing::info!("[engineer] Redis/hub config changed — resubscribing to voice:audio");
                    }
                }
            }
            Err(e) => {
                tracing::error!(error = %e, redis_url = %redis_url, "[engineer] Failed to subscribe to voice:audio — retrying");
                interruptible_sleep(backoff, &mut url_rx).await;
                backoff = (backoff * 2).min(max_backoff);
            }
        }
    }
}

/// Sleep for `dur`, but wake early if a new Redis/hub URL is saved so a config fix
/// applies immediately instead of waiting out the backoff.
async fn interruptible_sleep(dur: Duration, url_rx: &mut watch::Receiver<String>) {
    tokio::select! {
        _ = tokio::time::sleep(dur) => {}
        _ = url_rx.changed() => {}
    }
}
