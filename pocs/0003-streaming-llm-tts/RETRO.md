# POC-0003 Retrospective — Streaming LLM→TTS Chain

**Date:** 2026-06-26
**Status:** Concluded

---

## What we did

Implemented a streaming pipeline that fires each complete sentence from the LLM to Chatterbox TTS immediately rather than waiting for the full response. Ran 5 back-to-back batch vs. streaming comparisons using the same fixed transcript ("What's my gap to the car ahead?"), Lemonade `qwen3.5-9b-FLM`, and Chatterbox TTS with `voice2.wav`.

---

## What we found

### Streaming halves batch latency — but the 500ms target is out of reach

| Mode | Combined (Mean) | vs. Batch |
|------|---------------:|----------:|
| Batch (LLM sequential → TTS) | 8,774ms | — |
| Streaming (first sentence → TTS) | 4,324ms | **50.7% faster** |

Full pipeline with local STT added:
- Streaming TTFA: ~4,324ms + 60ms STT = **~4,384ms** (8.8× over 500ms target)

### LLM TTFT is the hard floor

| Metric | POC-0001 | POC-0003 |
|--------|---------|---------|
| LLM TTFT | 2,611ms | 2,719ms |

TTFT is stable, reproducible, and cannot be reduced by any streaming architecture. It's the time the remote server takes to produce the first token. To reach 500ms total TTFA, TTFT would need to drop to under ~300ms — requiring either a much faster model or local inference.

### TTS latency is strongly correlated with input length

| Input | TTS First Byte |
|-------|---------------:|
| Full response (1–2 sentences, batch) | 2,618ms mean |
| First sentence only (streaming) | 980ms mean |

A short sentence (~5-8 words) gets its first audio byte **2.7× faster** than a full paragraph. Keeping TTS input short is a permanent, LLM-independent optimization.

### Sentence boundary detection has a known false-positive issue

The naive `[.!?]\s` regex matched the `.` in decimal values like `2.4 seconds`, causing the first dispatched sentence to be a fragment (`"You are 2."` instead of `"You are 2.4 seconds behind car #45."`). The TTS still processed it and emitted audio, so the latency measurement is valid, but the audio content would be wrong in production.

---

## Decisions made

**The streaming chain architecture is correct — carry it forward.** The LLM→TTS streaming pattern reduces TTFA and stabilizes TTS latency (by always sending short input). This design should be used in the production Tauri client.

**The bottleneck is now LLM TTFT.** The same structural argument that motivated POC-0002 for STT applies here: the network round-trip to a remote LLM adds ~2.7s of irreducible latency. Local LLM inference on the racing PC is the logical next POC.

**Sentence splitter must be improved before production.** The splitter needs to avoid false positives on decimal numbers and abbreviations. Options: require uppercase after `. `, use a token-count heuristic, or use a library.

---

## Audio pipeline state after POC-0003

| Stage | Architecture | Latency | Status |
|-------|-------------|---------|--------|
| STT | Local `whisper-rs` Base.en + Vulkan | ~60ms | ✓ Solved (POC-0002) |
| LLM → TTS chain | Streaming per-sentence | ~4,324ms | Bottleneck: LLM TTFT |
| **Total TTFA** | | **~4,384ms** | 8.8× over 500ms target |

The bottleneck source is now entirely inside the LLM tier: `qwen3.5-9b-FLM` hosted on Lemonade takes ~2.7s to begin responding. This cannot be optimised architecturally.

---

## What POC-0004 should validate

**Local LLM inference on the racing PC.** Run a small (1–3B) language model locally on the Windows gaming rig (AMD Radeon 7900 / Vulkan) using `llama.cpp` or `candle`. Measure TTFT with local inference vs. Lemonade baseline.

Secondary questions:
- What is the smallest model that produces acceptable racing engineer responses?
- Does a 1–3B model's accuracy degrade enough to be noticeable vs. 9B?
- Can Vulkan GPGPU on the AMD 7900 hit TTFT <300ms for a 1–3B model?

If local LLM inference brings TTFT under ~300ms, the combined streaming pipeline would be:
- STT: ~60ms
- LLM TTFT: <300ms
- TTS first sentence: ~980ms
- **Total: ~1,340ms** — still over 500ms, but within reach of 1s which is a perceptible improvement over 4.4s

Further optimisation would then focus on TTS latency (a faster voice synthesis model, or a local TTS solution).

---

## Confidence

**High** that streaming is the right architecture. **High** that LLM TTFT is the blocking constraint. **Medium** that local LLM will solve it — depends on whether a small enough model can produce quality responses and fit within Vulkan VRAM on the 7900.
