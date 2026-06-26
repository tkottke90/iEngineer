# 0001 — Audio Pipeline End-to-End Latency

| Field      | Value                  |
|------------|------------------------|
| **Status** | `concluded`            |
| **Index**  | `0001`                 |
| **Author** | Thomas Kottke          |
| **Date**   | 2026-06-26             |

---

## Observation

The Racing Engineer behavior spec (`Docs/Specs/Racing Engineer Behavior Spec.md`) defines a safe-window gate: the engineer only speaks to the driver when lateral G < 0.4g, throttle > 0.7, and no braking in the last 150m. These windows are often 2–4 seconds wide. The entire voice-first interaction model assumes the roundtrip from PTT release to audible speech fits comfortably inside that window. Neither the end-to-end pipeline latency nor which stage dominates has ever been measured. The 500ms TTFA target in `Docs/Research/TTS.md` is aspirational — this POC establishes the baseline.

---

## Question

What is the end-to-end latency from PTT release (WAV file available) to first audio byte delivered by Chatterbox, measured across the three pipeline stages: Lemonade STT (Whisper-Large-v3-Turbo) → Lemonade LLM (qwen3.5:9b-FLM) → Chatterbox TTS?

---

## Research

- **`Docs/Research/TTS.md`** — Establishes Time-to-First-Audio (TTFA) as the primary latency metric. Documents a sub-500ms target. Recommends Chatterbox (MIT, high quality) as the TTS backend and notes streaming support is architecture-dependent.
- **`Docs/Research/llm-audio-playback.md`** — Recommends streaming as the primary delivery model to reduce perceived latency; the first audio chunk can begin playing before synthesis is complete.
- **`Docs/Engineering/POCs.md`** — Explicitly lists "LLM latency in live race context" as a required validation before committing to agent architecture.
- **Lemonade API** — OpenAI-compatible inference server hosted at `https://lemonade.tdkottke.com`. Serves both STT (Whisper-Large-v3-Turbo via `/v1/audio/transcriptions`) and LLM inference (qwen3.5:9b-FLM via `/v1/chat/completions`).
- **Chatterbox** (`devnen/chatterbox-tts-api`) — Running at `http://10.0.0.12:8004`. **Does not implement the OpenAI `/v1/audio/speech` endpoint in a compatible way.** The correct endpoint is `/tts` with a custom request schema (see Corrections below).

### Corrections discovered during setup

**Chatterbox API shape** — Initial assumption was that Chatterbox would expose a standard `/v1/audio/speech` endpoint accepting `{ model, input, voice }`. This was wrong. On first run, the server returned:

```
TTS 404: {"detail":"Voice file 'default' not found."}
```

Inspection of `http://10.0.0.12:8004/openapi.json` revealed the real API:
- Correct endpoint: `POST /tts`
- Voice mode must be specified explicitly: `voice_mode: "clone"` (for a cloned reference voice) or `"predefined"`
- Clone mode requires `reference_audio_filename` — the filename of a previously uploaded WAV/MP3, not a short string like `"default"`
- A custom voice `voice2.wav` was already uploaded to the server and is used for this experiment
- `stream: true` enables chunked response for first-byte timing
- `output_format: "mp3"` with `split_text: true` and `chunk_size: 240` matches the server's recommended defaults

The `CHATTERBOX_MODEL` env var maps to `reference_audio_filename` in the request body.

**LLM moved to Lemonade** — The experiment initially targeted a local Ollama instance. During setup it was switched to `https://lemonade.tdkottke.com` to use the homelab GPU server, which also hosts the STT model. Model in use: `qwen3.5:9b-FLM`.

---

## Hypothesis

Total TTFA will fall in the **800ms–2s range**. Stage breakdown expected:

- **STT (Whisper-Large-v3-Turbo):** ~100–300ms. The fixture query is short (~1 second of audio). Lemonade is a GPU-accelerated server, so transcription should be fast.
- **LLM TTFT (qwen3.5:9b-FLM on Lemonade):** ~300–700ms. GPU-backed inference should be faster than local CPU Ollama. First token determines when TTS can begin.
- **TTS first byte (Chatterbox):** ~200–500ms after LLM response is available. Depends on whether the server streams or buffers the full audio before sending.

**Sub-500ms TTFA is unlikely in batch mode** (wait for full LLM response before calling TTS). Streaming LLM output directly to TTS may be required to approach the target. This POC measures batch mode as a baseline; streaming is a follow-on optimization.

---

## Experiment

### Prerequisites

- Lemonade API available at `https://lemonade.tdkottke.com` (serves both STT and LLM)
- Chatterbox running on homelab at `http://10.0.0.12:8004` with `voice2.wav` uploaded
- `fixtures/query.wav` generated (see Setup)
- `.env` configured from `.env.example`

### Setup

```bash
cd pocs/0001-audio-pipeline-latency

# Generate the fixture WAV (macOS, requires ffmpeg: brew install ffmpeg)
bash fixtures/generate.sh

# Configure environment
cp .env.example .env
# CHATTERBOX_MODEL must match a voice filename uploaded to the Chatterbox server

# Install deps
npm install
```

### Run

```bash
npm start -w @poc/0001-audio-pipeline-latency
```

### What to observe

- Per-stage timing for each iteration: `stt_ms`, `llm_ttft_ms`, `llm_total_ms`, `tts_ttfa_ms`, `total_ttfa_ms`
- Which stage is the largest contributor to total TTFA
- Whether total TTFA is above or below the 500ms target
- Variance between iterations (p50 vs p95 spread)
- Whether `tts_ttfa_ms` collapses to the full render time (indicating Chatterbox buffers before streaming despite `stream: true`)

---

## Results

5 runs, model: `qwen3.5-9b-FLM`, STT: `Whisper-Large-v3-Turbo`, TTS: `voice2.wav` clone. Full data in `results/measurements.json`.

| Stage          |   Mean |    p50 |    p95 | % of total |
|----------------|-------:|-------:|-------:|------------|
| STT            | 12,161ms | 12,079ms | 12,452ms | **67%** |
| LLM TTFT       |  2,611ms |  2,612ms |  2,631ms | 14% |
| LLM Total      |  4,448ms |  4,406ms |  4,604ms | — |
| TTS First Byte |  1,588ms |  1,580ms |  1,658ms | 9% |
| **TOTAL TTFA** | **18,198ms** | **18,088ms** | **18,563ms** | — |

All transcripts were correct: `"What's my gap to the car ahead?"`. LLM responses were terse and accurate (7–12 words). Variance across runs was minimal — p95 is within 3% of p50 for every stage, confirming these are structural latencies, not spikes.

---

## Conclusions

### The 500ms target is not achievable with the current architecture

Total TTFA is **18.2 seconds** — 36× over the 500ms target. This is not a tuning problem; it is an architectural one. Even if LLM and TTS were instantaneous, STT alone at 12 seconds makes real-time voice interaction impossible.

### STT is the dominant bottleneck — and the hypothesis was wrong by 40×

The hypothesis predicted 100–300ms for STT. The actual result is ~12,160ms — **40× slower than expected**. The consistency across runs (p95 within 400ms of mean) rules out cold start or queueing; this is the steady-state cost of sending audio to a remote Whisper-Large-v3-Turbo instance over HTTPS.

Likely causes:
- **Network round-trip** for uploading a WAV file over a residential internet connection adds fixed overhead
- **Whisper-Large-v3-Turbo** is a large model; even on GPU, the `FLM` runtime may not be optimized for short audio clips at this latency target
- The Lemonade server may be serialising STT requests

### LLM and TTS are also far from target, but secondary

LLM TTFT at 2.6s and TTS first byte at 1.6s are both well above budget. However, addressing STT is the prerequisite — reducing LLM and TTS only matters once STT is no longer the dominant term.

### Recommended path forward

**Move STT to the racing PC (Tauri client).** This is the most important architectural change this POC motivates. The Tauri client already owns audio capture (`cpal`). Running Whisper locally — even a smaller model like Whisper-Small or Whisper-Tiny — eliminates the network upload cost entirely. On a modern gaming PC, Whisper-Tiny processes 1 second of audio in ~50ms. This single change could drop the STT contribution from 12,160ms to under 100ms.

Secondary optimisations to pursue once STT is local:
1. **Streaming LLM → TTS:** Begin synthesis as the first tokens arrive rather than waiting for the full response. This would reduce the LLM+TTS contribution from ~6s to closer to ~2s (time to first coherent sentence).
2. **Smaller/faster LLM:** `qwen3.5-9b-FLM` produces correct, terse responses but TTFT at 2.6s is still above budget. A 4B model or smaller may hit ~500ms TTFT on the same hardware.
3. **Chatterbox streaming:** TTS first byte at 1.6s suggests either buffering before streaming or a slow synthesis step. Worth profiling directly against the Chatterbox server.

### Decision this informs

**ADR update required.** The current ADR places STT on the homelab hub server. This POC demonstrates that is not viable for real-time racing. STT must run on the racing PC. This changes the Tauri client's role: it is not just a telemetry publisher and audio I/O layer — it must also run inference for speech recognition locally.

**Next POC:** `0002-local-stt-latency` — measure Whisper-Tiny and Whisper-Small running natively in the Tauri client (via a Rust Whisper binding or a sidecar process) against the same fixture audio.
