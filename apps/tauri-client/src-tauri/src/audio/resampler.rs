use anyhow::Result;
use rubato::{FftFixedIn, Resampler};

const TARGET_SAMPLE_RATE: u32 = 16_000;

pub struct AudioResampler;

impl AudioResampler {
    pub fn resample_to_whisper(input: Vec<f32>, input_sample_rate: u32) -> Result<Vec<i16>> {
        if input_sample_rate == TARGET_SAMPLE_RATE {
            return Ok(to_pcm16(input));
        }

        let mut resampler = FftFixedIn::<f32>::new(
            input_sample_rate as usize,
            TARGET_SAMPLE_RATE as usize,
            input.len(),
            2,
            1,
        )?;

        let output = resampler.process(&[input], None)?;
        Ok(to_pcm16(output.into_iter().flatten().collect()))
    }
}

fn to_pcm16(samples: Vec<f32>) -> Vec<i16> {
    samples
        .into_iter()
        .map(|s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
        .collect()
}
