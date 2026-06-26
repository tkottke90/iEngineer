use std::path::Path;
use std::time::Instant;

use serde::Serialize;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const ITERATIONS: usize = 5;
const REMOTE_BASELINE_MS: f64 = 12_161.0;

#[derive(Serialize)]
struct RunResult {
    run: usize,
    inference_ms: f64,
    transcript: String,
}

#[derive(Serialize)]
struct Summary {
    mean_ms: f64,
    p50_ms: f64,
    p95_ms: f64,
}

#[derive(Serialize)]
struct ModelResult {
    model: String,
    load_ms: f64,
    runs: Vec<RunResult>,
    summary: Summary,
}

#[derive(Serialize)]
struct Measurements {
    poc: &'static str,
    remote_baseline_ms: f64,
    models: Vec<ModelResult>,
}

fn stats(values: &[f64]) -> Summary {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = sorted.len();
    let mean = sorted.iter().sum::<f64>() / n as f64;
    let p50 = sorted[((n as f64 * 0.5) as usize).min(n - 1)];
    let p95 = sorted[((n as f64 * 0.95) as usize).min(n - 1)];
    Summary { mean_ms: mean, p50_ms: p50, p95_ms: p95 }
}

fn load_wav_f32(path: &str) -> Vec<f32> {
    let reader = hound::WavReader::open(path).expect("failed to open WAV");
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, 16_000, "WAV must be 16kHz (got {})", spec.sample_rate);
    assert_eq!(spec.channels, 1, "WAV must be mono (got {} channels)", spec.channels);

    let i16_samples: Vec<i16> = reader
        .into_samples::<i16>()
        .map(|s| s.expect("bad sample"))
        .collect();

    let mut f32_samples = vec![0.0f32; i16_samples.len()];
    whisper_rs::convert_integer_to_float_audio(&i16_samples, &mut f32_samples)
        .expect("audio conversion failed");
    f32_samples
}

fn run_inference(ctx: &WhisperContext, samples: &[f32]) -> (f64, String) {
    let mut state = ctx.create_state().expect("failed to create state");

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    let t = Instant::now();
    state.full(params, samples).expect("inference failed");
    let ms = t.elapsed().as_secs_f64() * 1_000.0;

    let n = state.full_n_segments().expect("failed to get segment count");
    let transcript = (0..n)
        .map(|i| state.full_get_segment_text(i).expect("failed to get segment"))
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();

    (ms, transcript)
}

fn main() {
    let models = [
        ("tiny.en", "fixtures/models/ggml-tiny.en.bin"),
        ("base.en", "fixtures/models/ggml-base.en.bin"),
        ("small.en", "fixtures/models/ggml-small.en.bin"),
    ];
    let wav_path = "fixtures/query.wav";

    println!("POC 0002 — Local STT Latency (whisper-rs)");
    println!("==========================================");
    println!("Baseline (POC-0001 remote): {:.0}ms mean", REMOTE_BASELINE_MS);
    println!("Fixture: {}", wav_path);
    println!("Iterations per model: {}\n", ITERATIONS);

    let samples = load_wav_f32(wav_path);
    println!(
        "Loaded {} samples ({:.2}s at 16kHz)\n",
        samples.len(),
        samples.len() as f64 / 16_000.0
    );

    let mut results: Vec<ModelResult> = Vec::new();

    for (name, path) in &models {
        println!("--- {} ---", name);

        if !Path::new(path).exists() {
            println!("  SKIPPED — model not found at {}", path);
            println!("  Run: bash fixtures/models/download.sh\n");
            continue;
        }

        let t_load = Instant::now();
        let ctx = WhisperContext::new_with_params(path, WhisperContextParameters::default())
            .expect("failed to load model");
        let load_ms = t_load.elapsed().as_secs_f64() * 1_000.0;
        println!("  Load: {:.0}ms", load_ms);

        let mut runs: Vec<RunResult> = Vec::new();
        for i in 0..ITERATIONS {
            let (inference_ms, transcript) = run_inference(&ctx, &samples);
            println!(
                "  Run {}/{}: {:.0}ms → \"{}\"",
                i + 1,
                ITERATIONS,
                inference_ms,
                transcript
            );
            runs.push(RunResult { run: i + 1, inference_ms, transcript });
        }

        let times: Vec<f64> = runs.iter().map(|r| r.inference_ms).collect();
        let summary = stats(&times);
        println!(
            "  Mean: {:.0}ms  p50: {:.0}ms  p95: {:.0}ms  ({:.0}× faster than remote)\n",
            summary.mean_ms,
            summary.p50_ms,
            summary.p95_ms,
            REMOTE_BASELINE_MS / summary.mean_ms
        );

        results.push(ModelResult { model: name.to_string(), load_ms, runs, summary });
    }

    // Summary table
    println!("=== Summary vs. POC-0001 Remote Baseline ===");
    println!("{:<12} | {:>10} | {:>10} | {:>10} | {:>10}", "Model", "Mean", "p50", "p95", "Speedup");
    println!("{}", "-".repeat(65));
    println!("{:<12} | {:>8.0}ms | {:>8.0}ms | {:>8.0}ms | {:>9}", "remote", 12_161, 12_079, 12_452, "1×");
    for r in &results {
        println!(
            "{:<12} | {:>8.0}ms | {:>8.0}ms | {:>8.0}ms | {:>8.0}×",
            r.model,
            r.summary.mean_ms,
            r.summary.p50_ms,
            r.summary.p95_ms,
            REMOTE_BASELINE_MS / r.summary.mean_ms
        );
    }

    let out = Measurements { poc: "0002-local-stt-latency", remote_baseline_ms: REMOTE_BASELINE_MS, models: results };
    let json = serde_json::to_string_pretty(&out).expect("serialization failed");
    std::fs::write("results/measurements.json", &json).expect("failed to write results");
    println!("\nWrote results/measurements.json");
}
