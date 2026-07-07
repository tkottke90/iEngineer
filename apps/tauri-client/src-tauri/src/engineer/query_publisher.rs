use anyhow::Result;
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::redis::pubsub::PubSubListener;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineerQuery {
    query_id: String,
    transcript: String,
    /// Left empty — the hub derives the session from live race state; this field
    /// exists only to satisfy the shared EngineerQuery contract.
    session_id: String,
    captured_at_ms: u128,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Publish a transcribed PTT query to the `engineer:query` pub/sub channel
/// (contracts/engineer-query-channel.md). Opens a short-lived connection — presses
/// are infrequent and STT already dominates the latency.
pub async fn publish_query(redis_url: &str, transcript: String) -> Result<()> {
    let query = EngineerQuery {
        query_id: format!("ptt-{}", now_nanos()),
        transcript,
        session_id: String::new(),
        captured_at_ms: now_ms(),
    };
    let json = serde_json::to_string(&query)?;

    let client = redis::Client::open(redis_url)?;
    let mut conn = client.get_multiplexed_async_connection().await?;
    PubSubListener::publish(&mut conn, "engineer:query", &json).await?;
    tracing::info!(query_id = %query.query_id, "[stt] PTT query published to engineer:query");
    Ok(())
}
