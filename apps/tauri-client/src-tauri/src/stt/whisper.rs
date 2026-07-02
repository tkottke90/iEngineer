use anyhow::{Context, Result};
use std::path::Path;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const WHISPER_SAMPLE_RATE: u32 = 16_000;

/// Local Whisper base.en STT (POC-0002). Runs in-process; no network hop.
pub struct WhisperStt {
    ctx: WhisperContext,
}

impl WhisperStt {
    /// Load the ggml base.en model. Errors if the model file is missing so the
    /// caller can disable STT gracefully rather than crashing.
    pub fn load(model_path: &Path) -> Result<Self> {
        let path = model_path
            .to_str()
            .context("model path is not valid UTF-8")?;
        let ctx = WhisperContext::new_with_params(path, WhisperContextParameters::default())
            .context("failed to load whisper model")?;
        Ok(Self { ctx })
    }

    /// Transcribe mono f32 PCM captured at `sample_rate`. Resamples to Whisper's
    /// required 16 kHz and returns the trimmed transcript.
    pub fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String> {
        let audio = resample_linear(samples, sample_rate, WHISPER_SAMPLE_RATE);

        let mut state = self
            .ctx
            .create_state()
            .context("failed to create whisper state")?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        state
            .full(params, &audio)
            .context("whisper inference failed")?;

        let n = state
            .full_n_segments()
            .context("failed to get segment count")?;
        let mut text = String::new();
        for i in 0..n {
            text.push_str(
                &state
                    .full_get_segment_text(i)
                    .context("failed to get segment text")?,
            );
        }
        Ok(text.trim().to_string())
    }
}

/// Simple linear-interpolation resampler for mono f32 — adequate for speech STT.
/// (Assumes mono input; multi-channel downmix is a future refinement.)
pub fn resample_linear(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if input.is_empty() || from_rate == to_rate || from_rate == 0 {
        return input.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let idx = src.floor() as usize;
        let frac = (src - idx as f64) as f32;
        let a = input.get(idx).copied().unwrap_or(0.0);
        let b = input.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

/// Whether a transcript is real speech worth sending to the LLM (FR-004). Empty,
/// whitespace-only, Whisper's blank markers, and sub-threshold noise are rejected.
pub fn is_speech(transcript: &str) -> bool {
    let t = transcript.trim();
    if t.len() < 2 {
        return false;
    }
    let lower = t.to_lowercase();
    // whisper.cpp emits these for silence/non-speech.
    const BLANKS: [&str; 4] = ["[blank_audio]", "[ blank_audio ]", "(silence)", "[silence]"];
    if BLANKS.iter().any(|b| lower == *b) {
        return false;
    }
    // require at least one alphanumeric character
    t.chars().any(|c| c.is_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_changes_length_by_ratio() {
        let input = vec![0.0_f32; 48_000]; // 1s @ 48kHz
        let out = resample_linear(&input, 48_000, 16_000);
        assert_eq!(out.len(), 16_000);
    }

    #[test]
    fn resample_is_identity_at_same_rate() {
        let input = vec![0.1, 0.2, 0.3];
        assert_eq!(resample_linear(&input, 16_000, 16_000), input);
    }

    #[test]
    fn is_speech_rejects_empty_and_blank_markers() {
        assert!(!is_speech(""));
        assert!(!is_speech("   "));
        assert!(!is_speech("[BLANK_AUDIO]"));
        assert!(!is_speech("(silence)"));
        assert!(!is_speech("."));
    }

    #[test]
    fn is_speech_accepts_real_utterances() {
        assert!(is_speech("do we pit this lap?"));
        assert!(is_speech("Box now"));
    }
}
