use anyhow::Result;
use redis::aio::PubSub;
use redis::AsyncCommands;
use tokio::task::JoinHandle;

pub struct PubSubListener;

impl PubSubListener {
    pub async fn subscribe(
        redis_url: &str,
        channels: Vec<&str>,
        handler: impl Fn(&str, String) + Send + 'static,
    ) -> Result<JoinHandle<()>> {
        let client = redis::Client::open(redis_url)?;
        let mut pubsub: PubSub = client.get_async_pubsub().await?;

        for channel in channels {
            pubsub.subscribe(channel).await?;
        }

        let handle = tokio::spawn(async move {
            use futures::StreamExt;
            let mut stream = pubsub.into_on_message();
            while let Some(msg) = stream.next().await {
                let channel = msg.get_channel_name().to_string();
                if let Ok(payload) = msg.get_payload::<String>() {
                    handler(&channel, payload);
                }
            }
        });

        Ok(handle)
    }

    pub async fn publish(
        conn: &mut redis::aio::MultiplexedConnection,
        channel: &str,
        message: &str,
    ) -> Result<()> {
        let _: () = conn.publish(channel, message).await?;
        Ok(())
    }
}
