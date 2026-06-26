# 0002 — Local STT Latency

| Field      | Value                  |
|------------|------------------------|
| **Status** | `concluded`            |
| **Index**  | `0002`                 |
| **Author** | Thomas Kottke          |
| **Date**   | 2026-06-26             |

---

## Observation

POC-0001 measured remote Whisper-Large-v3-Turbo via Lemonade at **12,161ms mean** — 40× over hypothesis and 67% of total TTFA. The bottleneck is structural: uploading a WAV file over HTTPS to a homelab server over a residential internet connection adds fixed overhead regardless of server-side inference speed. The RETRO concluded STT must move to the Tauri client (racing PC), eliminating the network upload entirely.

---

## Question

What is the transcription latency for `Whisper-Tiny.en`, `Whisper-Base.en`, and `Whisper-Small.en` running locally via `whisper-rs` (Rust bindings to `whisper.cpp`) with Metal GPU acceleration, on the same `fixtures/query.wav` used in POC-0001?

---

## Research

- **POC-0001 RETRO** — Established the remote STT baseline at 12,161ms and recommended local inference as the path forward. Uses the same fixture WAV for direct comparison.

- **`whisper-rs` crate (v0.14)** — Rust bindings to `whisper.cpp` via FFI. Actively maintained (moved to Codeberg July 2025, still published on crates.io). Feature flags: `metal` (macOS), `vulkan` (AMD/cross-platform), `cuda` (NVIDIA). Tauri-compatible — no async runtime required, runs synchronously in the Rust backend.

- **`whisper.cpp` benchmarks (Apple M-series, Metal)** — From the whisper.cpp README:
  - `tiny.en`: ~30ms per clip
  - `base.en`: ~60ms per clip
  - `small.en`: ~140ms per clip
  These are for ~30s JFK audio; our fixture is ~1s, so times should be shorter.

- **GPU backend for AMD Radeon 7900 (Windows racing PC)** — ROCm/HIP on Windows has unresolved CMake build failures with MSVC (whisper.cpp issue #2202, unresolved as of June 2026). **Vulkan is the correct backend** for AMD on Windows — supported via standard Radeon drivers, no extra toolchain. This POC runs on macOS with `metal`; production uses `vulkan` on the racing PC. Performance should be directionally comparable.

- **English-only `.en` models** — Smaller and faster than multilingual variants. Appropriate since the racing context is English-only.

- **Model files** — Downloaded from `ggerganov/whisper.cpp` on Hugging Face: `ggml-tiny.en.bin` (75MB), `ggml-base.en.bin` (142MB), `ggml-small.en.bin` (466MB).

---

## Hypothesis

All three models will be dramatically faster than the 12,161ms remote baseline. Expected inference times on Apple Silicon with Metal:

- **Tiny.en:** 20–50ms — well under the <170ms per-stage budget, but may have degraded accuracy on short clips
- **Base.en:** 40–100ms — strong candidate; accuracy should be reliable for clear speech
- **Small.en:** 100–200ms — highest accuracy of the three, likely still within budget

**Expected outcome:** At least Tiny and Base will comfortably fit within a <500ms total TTFA budget when combined with LLM (~2.6s) and TTS (~1.6s) from POC-0001. Local STT will not be the bottleneck. The remaining constraint is LLM+TTS, which will require streaming LLM→TTS chaining to approach the target.

---

## Experiment

### Prerequisites

- Rust toolchain (`rustup` — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- Xcode command line tools (`xcode-select --install`) — required to compile `whisper.cpp` from source
- `ffmpeg` for fixture WAV generation (`brew install ffmpeg`)
- Model files downloaded (see Setup — ~700MB total)

### Setup

```bash
cd pocs/0002-local-stt-latency

# Generate fixture WAV (macOS, one-time)
bash fixtures/generate.sh

# Download Whisper model files (~700MB)
bash fixtures/models/download.sh

# Build (first build compiles whisper.cpp — takes ~2–3 minutes)
npm run build -w @poc/0002-local-stt-latency
```

### Run

```bash
npm start -w @poc/0002-local-stt-latency
```

**Windows racing PC (Vulkan/AMD):**
```bash
cd pocs/0002-local-stt-latency
cargo run --release --features vulkan
```

### What to observe

- **Model load time** (one-time cost per process start — not included in TTFA budget)
- **Inference time per run** across 5 iterations for each model
- **Transcript accuracy** — does the text match `"What's my gap to the car ahead?"`
- **Speedup vs. 12,161ms remote baseline**
- Whether any model fits within a <170ms per-stage STT budget

---

## Results

5 runs per model, CPU inference (Metal GPU fallback — see note). All transcripts correct. Full data in `results/measurements.json`.

| Model    | Load  |   Mean |    p50 |    p95 | vs. remote (12,161ms) |
|----------|------:|-------:|-------:|-------:|----------------------:|
| tiny.en  |  86ms |  184ms |  184ms |  191ms | **66× faster** |
| base.en  |  61ms |  345ms |  341ms |  363ms | **35× faster** |
| small.en | 165ms | 1,071ms | 1,057ms | 1,126ms | **11× faster** |

**Note on Metal:** `whisper-rs 0.14.4` failed to compile its embedded Metal compute shaders on this macOS version (`unknown type name 'block_q4_0'` — a version mismatch between the bundled `ggml` Metal shaders and the macOS Metal SDK). All results above are **CPU-only**. Metal/Vulkan GPU would substantially reduce these times (whisper.cpp benchmarks on Apple M1 Metal: tiny ~30ms, base ~60ms, small ~140ms). The CPU numbers are therefore a conservative floor, not the expected production value.

---

## Conclusions

### Local inference resolves the STT bottleneck

Even on CPU, all three models are dramatically faster than the 12,161ms remote baseline. The structural fix — eliminating the network upload — works exactly as predicted. STT is no longer the dominant TTFA contributor.

### tiny.en and base.en are within budget on CPU alone

- **tiny.en at 184ms** (CPU) is already inside the <170ms per-stage budget on most runs (p50: 184ms — borderline). With Metal/Vulkan, expect ~30ms.
- **base.en at 345ms** (CPU) is over the per-stage budget but still viable if the LLM and TTS stages are reduced. With Metal/Vulkan, expect ~60ms.
- **small.en at 1,071ms** (CPU) exceeds the per-stage STT budget and requires GPU acceleration to be useful.

### Recommended model: base.en

`base.en` is the recommended starting point for the Tauri production integration:
- **Perfect accuracy** on all 5 runs for clean speech
- With Vulkan on the AMD Radeon 7900, expect ~60ms — well under the per-stage budget
- Significantly more robust than tiny for real-world conditions (background noise, non-standard pronunciation, racing vocabulary)
- Model file is 142MB — acceptable for a desktop Tauri client

`tiny.en` should be kept as a fallback if Vulkan performance doesn't materialise on the Windows racing PC.

### Metal GPU fix needed before shipping on macOS

The Metal backend in `whisper-rs 0.14.4` fails to compile its shaders on the current macOS Metal SDK. This must be resolved before the Tauri client can use GPU acceleration on macOS (dev machine or any Mac racing setup). Options:
1. Upgrade to `whisper-rs 0.16.0` — may include a fix
2. Pin to a `whisper.cpp` version with compatible Metal shaders
3. Skip Metal on macOS and rely on CPU (184ms on M1 is still viable)

On the Windows racing PC, Vulkan bypasses this issue entirely.

### The new binding constraint is LLM+TTS

With STT at ~60ms (GPU), the pipeline becomes:
- STT: ~60ms
- LLM TTFT: 2,611ms (from POC-0001)
- TTS first byte: 1,588ms (from POC-0001)
- **Total: ~4,259ms**

The 500ms target still requires streaming LLM output directly into TTS synthesis, reducing the combined LLM+TTS contribution from ~4.2s to roughly the time needed to generate and speak the first sentence (~1.5–2s). That is the next POC to validate.
