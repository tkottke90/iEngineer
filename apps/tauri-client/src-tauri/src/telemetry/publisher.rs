use anyhow::Result;
use redis::aio::MultiplexedConnection;
use redis::AsyncCommands;

const LIVE_STREAM: &str = "telemetry:live";
const SESSION_STREAM: &str = "telemetry:session";
const LIVE_MAXLEN: u64 = 600; // 10 seconds at 60 Hz

pub struct RedisPublisher {
    conn: MultiplexedConnection,
}

impl RedisPublisher {
    pub async fn new(redis_url: &str) -> Result<Self> {
        let client = redis::Client::open(redis_url)?;
        let conn = client.get_multiplexed_async_connection().await?;
        Ok(Self { conn })
    }

    pub async fn publish_live(&mut self, fields: Vec<(&str, String)>) -> Result<()> {
        let items: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let _: String = redis::cmd("XADD")
            .arg(LIVE_STREAM)
            .arg("MAXLEN")
            .arg("~")
            .arg(LIVE_MAXLEN)
            .arg("*")
            .arg(items.as_slice())
            .query_async(&mut self.conn)
            .await?;
        Ok(())
    }

    pub async fn publish_session(&mut self, fields: Vec<(&str, String)>) -> Result<()> {
        let items: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let _: String = redis::cmd("XADD")
            .arg(SESSION_STREAM)
            .arg("MAXLEN")
            .arg("~")
            .arg(600u64)
            .arg("*")
            .arg(items.as_slice())
            .query_async(&mut self.conn)
            .await?;
        Ok(())
    }
}
