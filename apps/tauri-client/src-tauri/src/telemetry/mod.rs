pub mod downsampler;
pub mod publisher;
pub mod sampler;

use std::sync::Arc;
use tokio::task::JoinHandle;

use crate::iracing::IracingSDK;

pub fn spawn_telemetry_task(_sdk: Arc<IracingSDK>) -> JoinHandle<()> {
    tokio::spawn(async move {
        // TODO: wire sampler + downsampler + publisher
        tracing::info!("telemetry task started");
    })
}
