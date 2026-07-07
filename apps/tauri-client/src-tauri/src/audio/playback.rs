use anyhow::{bail, Context, Result};
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
        let resp = reqwest::get(url)
            .await
            .with_context(|| format!("HTTP request to hub failed for {url}"))?;

        // reqwest only errors on transport failure, NOT on 4xx/5xx — check the
        // status ourselves. A 404 here is almost always an expired clip (past the
        // 60s TTL) or a wrong hub_url; surfacing it beats a misleading MP3 decode
        // error from the 404 body.
        let status = resp.status();
        if !status.is_success() {
            bail!("hub returned HTTP {status} for {url} (clip expired past its 60s TTL, or wrong hub_url?)");
        }

        let bytes = resp
            .bytes()
            .await
            .with_context(|| format!("reading clip body from {url}"))?;
        if bytes.is_empty() {
            bail!("hub returned an empty clip body for {url}");
        }

        self.play_bytes(bytes.to_vec())
    }

    pub fn play_bytes(&self, bytes: Vec<u8>) -> Result<()> {
        // NOTE: device selection is not implemented yet — playback always uses the
        // system default output. output_device_name is logged for diagnostics so a
        // "played fine but heard nothing" case points at the default-device gap.
        tracing::debug!(
            requested_device = ?self.output_device_name,
            bytes = bytes.len(),
            "[engineer] playing clip on system default output (device selection not yet wired)"
        );

        let (_stream, stream_handle) =
            OutputStream::try_default().context("no default audio output device available")?;
        let sink = Sink::try_new(&stream_handle).context("failed to open audio sink")?;
        let cursor = Cursor::new(bytes);
        let source =
            Decoder::new(cursor).context("failed to decode clip audio (not valid MP3?)")?;
        sink.append(source);
        sink.sleep_until_end();
        Ok(())
    }
}
