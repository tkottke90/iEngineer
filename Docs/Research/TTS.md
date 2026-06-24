# Text-to-Speech (TTS) Research

## Requirements

- **Low latency** — speech needs to feel real-time in a racing context
- **Custom voice models** — ability to train or fine-tune a specific voice (e.g., a crew chief character)
- **Clear, intelligible speech** — must be understandable at speed; no mumbling or artifacts
- **Streaming support** — generate and begin playing audio before synthesis is complete
- **Self-hosted / open-source preferred** over SaaS/paid APIs

---

## Key Concepts

**Time-to-First-Audio (TTFA):** How long before the first audio chunk begins playing. Most critical for perceived latency.

**Real-Time Factor (RTF):** Ratio of synthesis time to audio duration. RTF < 1.0 = faster than real-time. RTF of 0.03 means 33x faster than playback speed.

**Streaming TTS:** Server generates audio in chunks and streams them to the client, allowing playback to begin before synthesis is done. Requires either autoregressive or chunked-causal architecture.

**Zero-shot voice cloning:** Cloning a voice from a short audio sample (3–10 seconds) with no fine-tuning. Quality varies.

**Fine-tuning / voice training:** Training the model on your specific voice dataset for better reproduction. Higher quality than zero-shot cloning.

---

## Top Open-Source Candidates

### 1. F5-TTS ⭐ *Recommended starting point*

- **Architecture:** Flow-matching diffusion (non-autoregressive)
- **Voice cloning:** Zero-shot from ~3 seconds of reference audio; fine-tuning supported
- **Speed:** ~3–5× real-time on RTX 4070
- **VRAM:** ~3–5 GB at FP16
- **Streaming:** Limited — non-autoregressive architecture generates the full sequence at once; chunked streaming is possible but not as natural as autoregressive models
- **Quality:** High clarity; comparable to XTTS v2
- **License:** MIT
- **Status:** Actively developed; rapidly growing community adoption in 2025–2026
- **Links:** [GitHub](https://github.com/SWivid/F5-TTS) | [Fine-tuning guide](https://instavar.com/blog/ai-production-stack/F5_TTS_Fine_Tuning_Voice_Cloning_Guide)

**Notes:** Best balance of quality, speed, and trainability at a low VRAM footprint. The non-autoregressive design is a trade-off — it produces consistent quality but true token-by-token streaming is harder than with autoregressive models.

---

### 2. Coqui XTTS v2

- **Architecture:** Autoregressive + diffusion vocoder
- **Voice cloning:** Zero-shot from 6 seconds; 17 languages
- **Speed:** ~7× real-time (RTF ≈ 0.15); streaming TTFA ~200ms
- **VRAM:** 4–6 GB
- **Streaming:** Native chunked streaming support with ~200ms time-to-first-chunk
- **Quality:** High; clear and natural
- **License:** Coqui Public License (requires commercial license for production use)
- **Status:** Coqui AI closed in 2024 but the model weights and community remain active
- **Links:** [HuggingFace](https://huggingface.co/coqui/XTTS-v2) | [GitHub](https://github.com/coqui-ai/TTS)

**Notes:** The licensing situation is a risk — commercial use requires a paid license. The streaming story is strong, and it remains one of the most well-documented models for self-hosting. Consider only if you're comfortable navigating the license.

---

### 3. Chatterbox (Resemble AI)

- **Architecture:** Modern transformer-based
- **Voice cloning:** Zero-shot from ~10 seconds of reference audio
- **Speed:** Sub-300ms inference latency on GPU
- **VRAM:** ~6 GB (RTX 3060 Ti or better)
- **Streaming:** Supported
- **Quality:** Benchmarked above ElevenLabs in some evaluations; very natural prosody
- **License:** MIT
- **Status:** Released 2025, actively maintained
- **Links:** [Resemble AI](https://www.resemble.ai/learn/models/chatterbox)

**Notes:** Strongest quality among the MIT-licensed options. Slightly higher VRAM requirement than F5-TTS. Good choice if audio naturalness is the top priority.

---

### 4. CosyVoice2

- **Architecture:** Transformer LLM (0.5B params, Qwen backbone) + chunk-aware causal flow-matching decoder
- **Voice cloning:** Zero-shot; fine-tuning on 50–100 hours for best results
- **Speed:** Streaming, real-time capable
- **Streaming:** Native chunk-aware causal streaming; works with vLLM 0.11+
- **Quality:** 30–50% fewer pronunciation errors vs CosyVoice 1.0; very low character error rate
- **Languages:** Chinese, English, Japanese, Korean, Chinese dialects
- **License:** Apache 2.0
- **Status:** Active development by Alibaba/FunAudioLLM
- **Links:** [GitHub](https://github.com/FunAudioLLM/CosyVoice) | [Paper](https://funaudiollm.github.io/pdf/CosyVoice_2.pdf)

**Notes:** Best streaming architecture of any open model — chunk-aware causal design was purpose-built for real-time. Fine-tuning primarily adjusts the LLM backbone, keeping the vocoder frozen. Strong English support, but Chinese is the primary target language.

---

### 5. Kokoro

- **Architecture:** Lightweight (82M params)
- **Voice cloning:** Not built-in — ships with fixed voice packs. Community extension (KokoClone) adds zero-shot cloning.
- **Speed:** 210× real-time on RTX 4090; ~33× average RTF. Works on CPU.
- **VRAM:** 1–2 GB
- **Streaming:** Supported
- **Quality:** Ranked #1 on TTS Arena; excellent English quality for its size
- **License:** Apache 2.0
- **Status:** Very active; most downloaded open TTS model as of 2026
- **Links:** [ocdevel comparison](https://ocdevel.com/blog/20250720-tts)

**Notes:** The speed and low VRAM requirements are exceptional. The lack of native voice cloning/training is the main gap for this use case. Could work with KokoClone for zero-shot cloning, but fine-tuning a custom voice is not well-supported out of the box.

---

### 6. Qwen3-TTS

- **Architecture:** Large LLM-based TTS (Alibaba Cloud)
- **Voice cloning:** Zero-shot from 3 seconds
- **Speed:** TTFA as low as 97ms; streams from first character input
- **Streaming:** Full streaming support
- **Quality:** High; 10 languages supported
- **License:** Open weights (Apache 2.0)
- **Links:** [GitHub](https://github.com/QwenLM/Qwen3-TTS)

**Notes:** The 97ms TTFA is exceptional and the streaming design is mature. Newer and less battle-tested than XTTS or F5-TTS. Worth watching.

---

## Serving Infrastructure

### AllTalk TTS

A self-hosted TTS server that wraps multiple engines (XTTS, F5-TTS, Piper, Parler, and others) behind a unified REST and streaming API. Includes a web UI for voice fine-tuning, DeepSpeed acceleration (2–3× speedup), and low-VRAM mode.

- Exposes `/tts/generate` and `/tts/stream` endpoints
- Can serve multiple engines; swap without rewriting the client
- Voice training UI built in
- Docker image available
- [GitHub](https://github.com/erew123/alltalk_tts)

**Relevance:** AllTalk is the fastest path to a production-ready TTS API on top of F5-TTS or XTTS v2, without building a custom server.

---

## Comparison Summary

| Model | VRAM | RTF | TTFA | Streaming | Voice Training | License |
|-------|------|-----|------|-----------|----------------|---------|
| F5-TTS | 3–5 GB | ~0.2–0.33 | ~200ms | Limited | Fine-tune supported | MIT |
| XTTS v2 | 4–6 GB | ~0.15 | ~200ms | Native | Fine-tune supported | Coqui (⚠️) |
| Chatterbox | ~6 GB | — | <300ms | Yes | Zero-shot cloning | MIT |
| CosyVoice2 | ~4 GB | Real-time | Streaming | Native chunk-causal | Fine-tune (LLM layer) | Apache 2.0 |
| Kokoro | 1–2 GB | ~0.03 | <100ms | Yes | ❌ (fixed voicepacks) | Apache 2.0 |
| Qwen3-TTS | — | — | ~97ms | Full | Zero-shot | Apache 2.0 |

---

## Recommendation for iRacing Engineer

For a real-time racing engineer voice assistant, the priority order is: **streaming latency → voice consistency → clarity → trainability**.

**Primary candidate: F5-TTS via AllTalk TTS server**
- MIT licensed, self-hostable on a gaming GPU (RTX 3060+)
- Fine-tuning lets you lock in a specific "crew chief" voice character
- AllTalk provides the REST/streaming API layer so the app doesn't need to manage inference directly
- Community is large, documentation is good

**If streaming latency is the top priority: CosyVoice2**
- The chunk-aware causal architecture was purpose-built for real-time streaming
- vLLM support means the inference server story is mature
- Fine-tuning is available but requires more data (50–100 hours for best results)

**Fallback / hybrid: Kokoro + KokoClone**
- If voice cloning requirements are minimal and you just need a fast, clear, distinct voice
- Near-zero latency and tiny VRAM footprint
- Less control over voice identity

---

## Decisions

| Question | Answer |
|----------|--------|
| Hardware | Dedicated server (GPU assumed — no resource constraints from the client machine) |
| Voice cloning approach | Zero-shot cloning from a reference clip is sufficient |
| Voice identity | A consistent voice *profile/character*, not a specific real person. How to create a voice matters; which voice is TBD. |
| TTFA target | ≤ 500ms |

### Impact on Recommendation

With a dedicated server and a 500ms TTFA target, **CosyVoice2 becomes the top candidate** — its chunk-aware causal streaming architecture will comfortably hit 500ms TTFA and the dedicated hardware removes the VRAM trade-off that made F5-TTS more attractive for constrained setups.

Zero-shot cloning also simplifies the workflow: record or source a 3–10 second reference clip with the desired voice character, pass it as the reference at inference time, and the model adopts that profile consistently. No training pipeline required.

**Revised priority order:**

1. **CosyVoice2** — purpose-built streaming, Apache 2.0, vLLM-compatible for dedicated server deployment, zero-shot cloning, 30–50% fewer pronunciation errors vs. v1
2. **F5-TTS** — strong fallback; simpler deployment, MIT, slightly less mature streaming story
3. **Chatterbox** — if highest naturalness is needed and streaming latency benchmarks hold at ≤500ms

### Voice Profile Approach

Zero-shot cloning via reference audio means voice design is a content/curation problem, not an engineering one:
- Source or record a clip of the target voice character (calm, authoritative, clear)
- Pass it as the reference sample on every inference call
- Swap the reference clip to change the voice — no retraining required

This keeps the voice identity flexible during development and lets non-engineers iterate on it independently.
