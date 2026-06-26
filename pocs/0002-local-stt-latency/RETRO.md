# POC-0002 Retrospective — Local STT Latency

**Date:** 2026-06-26
**Status:** Concluded

---

## What we did

Measured transcription latency for `whisper-rs 0.14.4` (Rust bindings to `whisper.cpp`) running locally across three model sizes: Tiny.en (75MB), Base.en (142MB), and Small.en (466MB). Used the same 1-second fixture WAV as POC-0001 for a direct apples-to-apples comparison against the 12,161ms remote baseline.

---

## What we found

### Local inference eliminates the bottleneck — completely

| Model    |   CPU Mean | vs. remote | GPU estimate (Vulkan/Metal) |
|----------|----------:|----------:|----------------------------:|
| tiny.en  |     184ms |      66×  | ~30ms |
| base.en  |     345ms |      35×  | ~60ms |
| small.en |   1,071ms |      11×  | ~140ms |

Every model, even on CPU, beats the remote baseline by an order of magnitude. The fix was structural — eliminating the network upload — not a matter of server-side tuning.

### The Metal GPU backend failed on macOS

`whisper-rs 0.14.4` ships embedded `ggml` Metal compute shaders that are incompatible with the current macOS Metal SDK (`unknown type name 'block_q4_0'`). The library fell back to CPU transparently. The CPU numbers above are valid and useful, but they are not what production will look like.

**GPU estimates for production (Vulkan on AMD Radeon 7900 / Metal on Apple Silicon)** are extrapolated from whisper.cpp's published benchmarks on Apple M1 Metal. These should be treated as directional targets, not guarantees — actual numbers will require running the benchmark on the Windows racing PC with `--features vulkan`.

### All transcripts were correct

Every run across all models produced the exact target string: `"What's my gap to the car ahead?"`. Accuracy does not appear to degrade noticeably at Tiny or Base for clean speech at this clip length.

---

## Decisions made

**Recommended production model: Base.en**

- With Vulkan on the AMD Radeon 7900, ~60ms is expected — well inside a 170ms per-stage budget
- Meaningfully more robust than Tiny for real-world conditions (background noise, non-standard phrases, racing vocabulary)
- 142MB is acceptable for a Tauri client bundle

Tiny.en is a valid fallback if Vulkan performance on the racing PC underperforms expectations.

**STT architecture decision confirmed: runs in Tauri client (racing PC), not the hub**

The ADR from POC-0001 is validated. The whisper-rs integration point will be the Tauri Rust backend. STT runs in-process, no IPC, no network hop.

**Vulkan — not ROCm — for AMD on Windows**

ROCm/HIP on Windows is not production-ready (unresolved MSVC/CMake failures in `whisper.cpp`). Standard AMD Radeon drivers expose Vulkan. The `whisper-rs` `vulkan` feature flag is the path forward.

---

## What this changes

### Pipeline TTFA estimate (with Vulkan STT)

| Stage | Before | After |
|-------|--------|-------|
| STT | 12,161ms | ~60ms |
| LLM TTFT | 2,611ms | 2,611ms (unchanged) |
| TTS first byte | 1,588ms | 1,588ms (unchanged) |
| **Total TTFA** | **~18,200ms** | **~4,260ms** |

Still 8× over the 500ms target, but now the bottleneck is LLM+TTS — a solvable streaming problem, not a structural network problem.

### What POC-0003 should validate

**Streaming LLM → TTS chaining.** The LLM TTFT (2.6s) and TTS first byte (1.6s) in POC-0001 were measured sequentially. If we begin piping LLM tokens into TTS synthesis as they arrive, the user hears audio as soon as the first complete sentence is generated. The question for POC-0003: does LLM→TTS streaming reduce combined latency from 4.2s to <440ms (leaving 60ms for STT)?

Secondary candidates: local LLM inference on the racing PC (similar structural argument as STT), or a lighter LLM model on Lemonade.

---

## What went wrong (and fixes)

**Metal shader compilation failure** — Not a logic bug; a version mismatch between `whisper-rs 0.14.4`'s bundled `ggml` shaders and the macOS Metal SDK. Workarounds to investigate before Tauri integration on macOS:
1. `whisper-rs 0.16.0` — may ship updated shaders
2. Build `whisper.cpp` from source at a pinned commit with compatible Metal shaders
3. Run CPU-only on macOS dev machine (184ms is fast enough for development)

On the Windows racing PC this is moot — Vulkan is the target backend and has no equivalent issue.

---

## Confidence

**High** that local STT resolves the structural bottleneck. The CPU numbers already prove the network was the problem. **Medium** on the GPU estimates — they match whisper.cpp's published benchmarks but are not yet measured on the actual hardware. First action in the Tauri integration should be running this same benchmark with `--features vulkan` on the racing PC to confirm.
