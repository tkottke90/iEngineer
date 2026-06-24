use anyhow::Result;
use rodio::{Decoder, OutputStream, Sink};
use std::io::Cursor;

pub struct AudioPlayback {
    output_device_name: Option<String>,
}

impl AudioPlayback {
    pub fn new(output_device_name: Option<String>) -> Self {
        Self { output_device_name }
    }

    pub async fn play_url(&self, url: &str) -> Result<()> {
        let bytes = reqwest::get(url).await?.bytes().await?;
        self.play_bytes(bytes.to_vec())
    }

    pub fn play_bytes(&self, bytes: Vec<u8>) -> Result<()> {
        let (_stream, stream_handle) = OutputStream::try_default()?;
        let sink = Sink::try_new(&stream_handle)?;
        let cursor = Cursor::new(bytes);
        let source = Decoder::new(cursor)?;
        sink.append(source);
        sink.sleep_until_end();
        Ok(())
    }
}
