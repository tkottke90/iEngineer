use anyhow::Result;
use redis::aio::MultiplexedConnection;

const LIVE_STREAM: &str = "iracing:telemetry:live";
const SESSION_STREAM: &str = "iracing:telemetry:session";
const EVENT_CONNECTION_STREAM: &str = "iracing:events:connection";
const EVENT_SESSION_STREAM: &str = "iracing:events:session";
const LIVE_MAXLEN: u64 = 3600; // 60 seconds at 60 Hz
const SESSION_MAXLEN: u64 = 900; // 60 seconds at 15 Hz
const EVENT_MAXLEN: u64 = 100;

pub struct RedisPublisher {
    conn: MultiplexedConnection,
}

impl RedisPublisher {
    pub async fn new(redis_url: &str) -> Result<Self> {
        let client = redis::Client::open(redis_url)?;
        let conn = client.get_multiplexed_async_connection().await?;
        Ok(Self { conn })
    }

    pub async fn publish_live(&mut self, fields: Vec<(&str, &str)>) -> Result<()> {
        let _: String = redis::cmd("XADD")
            .arg(LIVE_STREAM)
            .arg("MAXLEN")
            .arg("~")
            .arg(LIVE_MAXLEN)
            .arg("*")
            .arg(fields.as_slice())
            .query_async(&mut self.conn)
            .await?;
        Ok(())
    }

    pub async fn publish_session(&mut self, fields: Vec<(&str, &str)>) -> Result<()> {
        let _: String = redis::cmd("XADD")
            .arg(SESSION_STREAM)
            .arg("MAXLEN")
            .arg("~")
            .arg(SESSION_MAXLEN)
            .arg("*")
            .arg(fields.as_slice())
            .query_async(&mut self.conn)
            .await?;
        Ok(())
    }

    pub async fn publish_event(&mut self, stream: &str, payload_json: &str) -> Result<()> {
        let _: String = redis::cmd("XADD")
            .arg(stream)
            .arg("MAXLEN")
            .arg("~")
            .arg(EVENT_MAXLEN)
            .arg("*")
            .arg(&[("payload", payload_json)])
            .query_async(&mut self.conn)
            .await?;
        Ok(())
    }

    pub fn connection_stream() -> &'static str {
        EVENT_CONNECTION_STREAM
    }

    pub fn session_stream() -> &'static str {
        EVENT_SESSION_STREAM
    }
}
