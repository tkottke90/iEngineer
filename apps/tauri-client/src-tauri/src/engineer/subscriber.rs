use anyhow::Result;
use serde::Deserialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::redis::pubsub::PubSubListener;

// COUPLING: 60_000 must equal AUDIO_CLIP_TTL_MS in audio-store.ts (T018) —
// change both together or the client discards clips the hub still serves.
const AUDIO_CLIP_TTL_MS: u128 = 60_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioClipRef {
    #[allow(dead_code)]
    audio_id: String,
    clip_url: String,
    #[allow(dead_code)]
    tier: u8,
    // Tier 1/2 clips carry eventType; Tier 3 (LLM-synthesized) carry tier3Type
    // (Model A). Both optional so either shape deserializes.
    #[allow(dead_code)]
    #[serde(default)]
    event_type: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    tier3_type: Option<String>,
    generated_at: u128,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Subscribe to `voice:audio`, resolve each clip URL against the configured
/// `hub_url`, and forward it to the playback queue. Stale clips (older than the
/// TTL) are discarded.
pub async fn spawn_subscriber(
    hub_url: String,
    redis_url: &str,
    queue_tx: mpsc::UnboundedSender<String>,
) -> Result<JoinHandle<()>> {
    let base = hub_url.trim_end_matches('/').to_string();

    PubSubListener::subscribe(redis_url, vec!["voice:audio"], move |_channel, payload| {
        let clip: AudioClipRef = match serde_json::from_str(&payload) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "[engineer] Failed to parse AudioClipRef");
                return;
            }
        };

        if now_ms().saturating_sub(clip.generated_at) > AUDIO_CLIP_TTL_MS {
            tracing::info!(url = %clip.clip_url, "[engineer] Stale clip discarded");
            return;
        }

        // Resolve relative clip_url against the configured hub_url.
        let absolute = format!("{}{}", base, clip.clip_url);
        tracing::info!(url = %absolute, "[engineer] Clip received");
        if let Err(e) = queue_tx.send(absolute) {
            tracing::error!(error = %e, "[engineer] Playback queue closed");
        }
    })
    .await
}
