use anyhow::Result;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{mpsc, watch};

use crate::audio::playback::AudioPlayback;

/// A play function: takes a clip URL, returns a boxed future resolving to
/// Ok/Err. Structured this way so tests can inject a failing stub (E3 coverage)
/// without depending on real audio hardware or `async_trait`.
pub type PlayFn =
    Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<()>> + Send>> + Send + Sync>;

/// Sequential, no-interrupt playback queue. Clips play FIFO; a playback error is
/// logged and the clip discarded — the loop MUST continue with the next clip.
pub struct PlaybackQueue {
    tx: mpsc::UnboundedSender<String>,
}

impl PlaybackQueue {
    /// Create a queue that plays through the currently selected output device.
    /// The watch channel (T013) is read at play time, so a device change in
    /// Settings applies to the very next clip — no queue restart needed.
    pub fn new(device_rx: watch::Receiver<Option<String>>) -> Self {
        let play: PlayFn = Arc::new(move |url: String| {
            let device = device_rx.borrow().clone();
            Box::pin(async move { AudioPlayback::new(device).play_url(&url).await })
        });
        Self::with_player(play)
    }

    /// Create a queue backed by a custom play function (used in tests).
    pub fn with_player(play: PlayFn) -> Self {
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(run_receiver(rx, play));
        Self { tx }
    }

    /// A cloneable sender for enqueuing clip URLs.
    pub fn sender(&self) -> mpsc::UnboundedSender<String> {
        self.tx.clone()
    }
}

async fn run_receiver(mut rx: mpsc::UnboundedReceiver<String>, play: PlayFn) {
    while let Some(url) = rx.recv().await {
        tracing::info!(url = %url, "[engineer] Playback started");
        match play(url.clone()).await {
            Ok(()) => tracing::info!(url = %url, "[engineer] Playback complete"),
            Err(e) => {
                // Log and discard; do NOT halt the loop or panic.
                tracing::error!(
                    "{}",
                    serde_json::json!({
                        "msg": "[engineer] Audio playback failed",
                        "url": url,
                        // {:#} renders the full anyhow context chain (e.g.
                        // "HTTP request to hub failed: connection refused").
                        "reason": format!("{e:#}"),
                    })
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    #[tokio::test]
    async fn continues_after_play_error() {
        let played: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let calls = Arc::new(AtomicUsize::new(0));
        let p = played.clone();
        let c = calls.clone();

        // First URL fails, second succeeds. Both must be consumed.
        let play: PlayFn = Arc::new(move |url: String| {
            let p = p.clone();
            let c = c.clone();
            Box::pin(async move {
                p.lock().unwrap().push(url);
                let n = c.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    Err(anyhow::anyhow!("simulated device error"))
                } else {
                    Ok(())
                }
            })
        });

        let (tx, rx) = mpsc::unbounded_channel::<String>();
        let handle = tokio::spawn(run_receiver(rx, play));
        tx.send("url1".to_string()).unwrap();
        tx.send("url2".to_string()).unwrap();
        drop(tx); // close channel so the loop terminates
        handle.await.unwrap();

        assert_eq!(*played.lock().unwrap(), vec!["url1", "url2"]);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
