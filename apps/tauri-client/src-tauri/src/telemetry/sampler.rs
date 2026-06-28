use super::downsampler::Downsampler;
use crate::iracing::IracingSDK;
use std::sync::Arc;
use tokio::time::{interval, Duration};

const SAMPLE_RATE_HZ: u64 = 60;

pub struct TelemetrySampler {
    sdk: Arc<IracingSDK>,
    downsampler: Downsampler,
}

impl TelemetrySampler {
    pub fn new(sdk: Arc<IracingSDK>) -> Self {
        Self {
            sdk,
            downsampler: Downsampler::new(),
        }
    }

    pub async fn run(mut self) {
        let mut ticker = interval(Duration::from_millis(1000 / SAMPLE_RATE_HZ));

        loop {
            ticker.tick().await;

            if !self.sdk.is_connected() {
                continue;
            }

            // Read live telemetry variables
            let _brake = self.sdk.read_var_float("Brake").unwrap_or(0.0);
            let _throttle = self.sdk.read_var_float("Throttle").unwrap_or(0.0);
            let _lat_accel = self.sdk.read_var_float("LatAccel").unwrap_or(0.0);
            let _long_accel = self.sdk.read_var_float("LongAccel").unwrap_or(0.0);
            let _speed = self.sdk.read_var_float("Speed").unwrap_or(0.0);
            let _gear = self.sdk.read_var_int("Gear").unwrap_or(0);
            let _car_idx_lap_dist_pct = self.sdk.read_var_float_array("CarIdxLapDistPct");

            // TODO: publish live message to Redis
            // TODO: if downsampler.should_emit_session(), publish session message

            if self.downsampler.should_emit_session() {
                // Read session-rate variables and publish
            }
        }
    }
}
