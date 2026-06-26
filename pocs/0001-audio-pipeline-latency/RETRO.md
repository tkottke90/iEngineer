# POC 0001 Retrospective — Audio Pipeline End-to-End Latency

**Date:** 2026-06-26
**Status:** Concluded

---

## What we set out to learn

Whether the three-stage audio pipeline (STT → LLM → TTS) could fit inside a 2–4 second safe window, with a stretch target of sub-500ms TTFA. We expected STT to be fast (~100–300ms) and the LLM to be the interesting variable.

---

## What actually happened

| Stage          | Hypothesis | Actual (mean) | Delta  |
|----------------|-----------|---------------|--------|
| STT            | 100–300ms | 12,161ms      | ~40×   |
| LLM TTFT       | 300–700ms | 2,611ms       | ~5×    |
| TTS first byte | 200–500ms | 1,588ms       | ~5×    |
| **Total TTFA** | 800–2000ms | **18,198ms** | **~12×** |

STT was the shock. Every other stage being slow was explainable and improvable. A 12-second transcription of a 1-second audio clip is a structural constraint, not a tuning problem.

---

## What we got wrong

**The STT hypothesis was not grounded in anything.** The 100–300ms estimate came from Whisper benchmark numbers measured on local GPU inference — not from a round-trip over HTTPS to a remote server. We assumed the network cost was negligible. It wasn't. Uploading audio to a remote endpoint, waiting for transcription, and receiving a JSON response adds fixed overhead that scales poorly with the latency target.

**We assumed the hub server was the natural home for STT.** The architecture placed STT on the homelab because "that's where the LLM is." This made sense from a co-location standpoint but ignored the latency cost of the audio upload step. STT is the one stage where the input is inherently large (a binary WAV file) and has to travel over the network.

---

## What we learned about the infrastructure

**Lemonade API** — OpenAI-compatible inference server works well for both STT and LLM. The model naming convention uses dashes, not colons (`qwen3.5-9b-FLM`, not `qwen3.5:9b-FLM`). STT latency is consistent but slow for remote use; likely faster for local inference.

**Chatterbox TTS** — The `/v1/audio/speech` endpoint is not fully implemented. The correct path is `POST /tts` with a custom schema requiring `voice_mode` (`"clone"` or `"predefined"`) and `reference_audio_filename`. Voice names are filenames, not short strings. The `stream: true` flag is supported and required for first-byte timing.

**LLM responses** — `qwen3.5-9b-FLM` produced correct, terse, consistent responses to the race engineer prompt across all 5 runs. TTFT consistency was excellent (p95 within 20ms of mean). The model is viable for the Racing Engineer role but needs a faster inference path.

---

## What this changes

**STT must move to the Tauri client.** This is the clearest decision this POC produces. The racing PC already owns audio capture (`cpal`). Running Whisper locally — even a small variant — eliminates the network upload entirely. The hub server should receive a text transcript, not raw audio.

**The ADR for STT placement needs to be updated.** The current architecture has STT on the hub. That assumption is invalidated.

**LLM and TTS are fixable, but secondary.** Once STT is local, the remaining pipeline (LLM + TTS) is ~6 seconds in batch mode. Streaming LLM output directly into TTS would reduce that to roughly time-to-first-sentence (~2–3s). Still over target, but in range of further optimisation.

---

## What we'd do differently

- **Establish a latency budget per stage before writing the hypothesis.** If total TTFA must be <500ms and there are 3 stages, each stage needs to be under ~170ms. That constraint alone would have flagged remote STT as impossible before we ran a single test.
- **Run a connectivity/ping baseline first.** A simple `curl` timing the empty STT endpoint would have surfaced the network cost before building the full experiment.
- **Start with the smallest model (Whisper-Tiny) rather than the best (Whisper-Large-v3-Turbo).** The smallest model would have shown the floor for remote latency and made it obvious the bottleneck was structural, not model-specific.

---

## Next step

**POC 0002 — Local STT Latency.** Run Whisper-Tiny and Whisper-Small natively on the racing PC (Rust binding or sidecar) against the same fixture audio. Establish the latency floor for local inference before committing to an implementation approach in the Tauri client.
