use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub struct AudioCapture {
    device_name: Option<String>,
}

impl AudioCapture {
    pub fn new(device_name: Option<String>) -> Self {
        Self { device_name }
    }

    pub fn start(
        &self,
        mut ptt_rx: mpsc::Receiver<bool>, // true = pressed, false = released
        on_audio: impl Fn(Vec<f32>, u32) + Send + 'static,
    ) -> Result<()> {
        let host = cpal::default_host();
        let device = match &self.device_name {
            Some(name) => host
                .input_devices()?
                .find(|d| d.name().ok().as_deref() == Some(name))
                .ok_or_else(|| anyhow::anyhow!("device not found: {name}"))?,
            None => host.default_input_device().ok_or_else(|| anyhow::anyhow!("no default input device"))?,
        };

        let config = device.default_input_config()?;
        let sample_rate = config.sample_rate().0;
        let buffer: Arc<Mutex<Vec<f32>>> = Arc::default();
        let buffer_clone = buffer.clone();
        let recording = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let recording_clone = recording.clone();

        let stream = device.build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                if recording_clone.load(std::sync::atomic::Ordering::Relaxed) {
                    buffer_clone.lock().unwrap().extend_from_slice(data);
                }
            },
            |err| tracing::error!("audio capture error: {err}"),
            None,
        )?;
        stream.play()?;

        tokio::spawn(async move {
            while let Some(pressed) = ptt_rx.recv().await {
                if pressed {
                    buffer.lock().unwrap().clear();
                    recording.store(true, std::sync::atomic::Ordering::Relaxed);
                } else {
                    recording.store(false, std::sync::atomic::Ordering::Relaxed);
                    let samples = buffer.lock().unwrap().drain(..).collect::<Vec<_>>();
                    if !samples.is_empty() {
                        on_audio(samples, sample_rate);
                    }
                }
            }
            drop(stream);
        });

        Ok(())
    }
}
