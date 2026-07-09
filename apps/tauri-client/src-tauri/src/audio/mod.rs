pub mod capture;
pub mod playback;
pub mod resampler;

use cpal::traits::{DeviceTrait, HostTrait};
use tokio::task::JoinHandle;

/// Names of all current system audio devices of one direction ("input" |
/// "output"). Used by the T014 startup availability check.
pub fn device_names(direction: &str) -> Vec<String> {
    let host = cpal::default_host();
    let devices = if direction == "input" {
        host.input_devices().ok()
    } else {
        host.output_devices().ok()
    };
    devices
        .map(|it| it.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

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
