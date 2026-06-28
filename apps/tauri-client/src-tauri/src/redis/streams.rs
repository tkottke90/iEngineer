use anyhow::Result;
use redis::aio::MultiplexedConnection;

pub struct StreamPublisher {
    conn: MultiplexedConnection,
}

impl StreamPublisher {
    pub async fn new(redis_url: &str) -> Result<Self> {
        let client = redis::Client::open(redis_url)?;
        let conn = client.get_multiplexed_async_connection().await?;
        Ok(Self { conn })
    }

    pub async fn xadd(&mut self, stream: &str, maxlen: u64, fields: &[(&str, &str)]) -> Result<()> {
        let mut cmd = redis::cmd("XADD");
        cmd.arg(stream).arg("MAXLEN").arg("~").arg(maxlen).arg("*");
        for (k, v) in fields {
            cmd.arg(k).arg(v);
        }
        let _: () = cmd.query_async(&mut self.conn).await?;
        Ok(())
    }
}
