pub mod capture;
pub mod playback;
pub mod resampler;

use tokio::task::JoinHandle;

pub fn spawn_audio_tasks() -> (JoinHandle<()>, JoinHandle<()>) {
    let capture_task = tokio::spawn(async move {
        tracing::info!("audio capture task started");
        // TODO: wire AudioCapture + PTT channel
    });

    let playback_task = tokio::spawn(async move {
        tracing::info!("audio playback task started");
        // TODO: wire AudioPlayback + voice:audio Redis channel
    });

    (capture_task, playback_task)
}
