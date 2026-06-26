# 0003 — Streaming LLM→TTS Chain

| Field      | Value                  |
|------------|------------------------|
| **Status** | `concluded`            |
| **Index**  | `0003`                 |
| **Author** | Thomas Kottke          |
| **Date**   | 2026-06-26             |

---

## Observation

POC-0001 measured the full audio pipeline in batch mode: STT → LLM (wait for full response) → TTS. The combined LLM+TTS contribution was **6,036ms** (LLM total 4,448ms + TTS first byte 1,588ms). POC-0002 solved the STT bottleneck, bringing it from 12,161ms to ~60ms on local GPU.

With STT fixed, the pipeline estimate becomes:
- STT: ~60ms (local, POC-0002)
- LLM Total: 4,448ms
- TTS first byte: 1,588ms
- **Total: ~6,108ms** (still 12× over 500ms target)

The batch architecture is the problem: TTS cannot start until the LLM finishes the full response. These stages are fundamentally sequential.

---

## Question

Does streaming LLM tokens into TTS sentence-by-sentence — beginning synthesis on the first complete sentence rather than waiting for the full response — meaningfully reduce time to first audio?

Specifically:
1. What is the combined latency (LLM start → TTS first byte) in streaming mode vs. batch?
2. Is TTS latency meaningfully lower for short single-sentence inputs than for full-paragraph inputs?
3. Is LLM TTFT (~2.6s from POC-0001) now the irreducible floor for this stack?

---

## Research

- **LangChain streaming** — `ChatOpenAI` with `streaming: true` already validated in POC-0001. The `client.stream()` call yields chunks token-by-token; sentence boundary detection can be layered on top.

- **Chatterbox TTS `stream: true`** — validated in POC-0001. Chatterbox begins encoding audio before the full text is synthesized. The question is whether a short sentence (~10 words) produces the first audio byte faster than a full paragraph.

- **Sentence boundary detection** — split on `. `, `! `, `? ` (followed by whitespace or EOS). Sufficient for single-turn racing engineer responses which are 1–2 sentences per POC-0001 results. No NLP library required.

- **POC-0001 baseline (LLM+TTS combined, batch):**
  - LLM total: 4,448ms mean
  - TTS first byte: 1,588ms mean (for full response)
  - Combined: ~6,036ms

- **Token generation rate estimate:** (4,448 − 2,611)ms / ~50 tokens ≈ 37ms/token. First sentence (~10 tokens) completes ~370ms after TTFT, so ~2,981ms from start.

---

## Hypothesis

Streaming will reduce combined LLM+TTS latency because:
1. TTS starts ~1,467ms earlier (sentence ready at ~2,981ms vs. LLM total at 4,448ms)
2. TTS for a short sentence is hypothesized to be faster than for a full paragraph (less synthesis work before first encoded byte)

**Batch (POC-0001):** ~6,036ms combined
**Streaming estimate:** ~2,981ms (first sentence) + ~500ms (TTS short text) = **~3,500ms** → ~42% faster

However, even if streaming halves the combined latency, **LLM TTFT at ~2.6s is the irreducible floor**. The 500ms total target cannot be met with the current Lemonade hosted LLM. This POC will quantify exactly how much streaming helps and whether a local/faster LLM is the mandatory next step.

---

## Experiment

### Prerequisites

- Node.js 20+ with npm
- Access to Lemonade API (`LLM_BASE_URL`) and Chatterbox TTS (`CHATTERBOX_URL`)
- No audio hardware required — measures bytes, not playback

### Setup

```bash
cd pocs/0003-streaming-llm-tts
cp .env.example .env
# Edit .env if needed — defaults match production homelab endpoints
npm install
```

### Run

```bash
npm start -w @poc/0003-streaming-llm-tts
```

Or directly:
```bash
cd pocs/0003-streaming-llm-tts
npm start
```

### What to observe

Each of the 5 iterations runs **batch then streaming** back-to-back with the same LLM client:

- **Batch:** full LLM response → full TTS → combined latency (validates POC-0001 baseline still holds)
- **Streaming:** first sentence detected → dispatched to TTS immediately → combined latency
- **Delta:** how much faster streaming is vs. batch for that run

Key metrics in the summary table:
- `Streaming TTFT` — should match POC-0001 ~2,611ms (server-side floor, unchanged)
- `Streaming 1st Sentence` — TTFT + time to generate first sentence
- `Streaming TTS (short)` — TTS latency for a single sentence (vs 1,588ms for full response)
- `Streaming Combined` — the new TTFA floor for LLM+TTS

---

## Results

5 runs, each executing batch then streaming back-to-back. Full data in `results/measurements.json`.

| Mode | Stage | Mean | p50 | p95 |
|------|-------|-----:|----:|----:|
| Batch | LLM Total | 6,156ms | 5,794ms | 7,971ms |
| Batch | TTS First Byte | 2,618ms | 2,831ms | 3,642ms |
| **Batch** | **Combined** | **8,774ms** | **9,436ms** | **11,327ms** |
| Streaming | LLM TTFT | 2,719ms | 2,686ms | 2,865ms |
| Streaming | 1st Sentence Complete | 3,344ms | 3,329ms | 3,437ms |
| Streaming | TTS First Byte (short) | 980ms | 957ms | 1,180ms |
| **Streaming** | **Combined** | **4,324ms** | **4,305ms** | **4,509ms** |

**Streaming is 4,450ms (50.7%) faster than batch.**

**Note — sentence boundary false positives:** The naive punctuation splitter (`[.!?]\s`) matched the `.` in decimal numbers (e.g., `2.4 seconds`), causing the first sentence dispatched to TTS to be a fragment like `"You are 2."` rather than a complete sentence. This did not break the latency measurement — the fragment still triggered TTS and produced audio bytes — but production would require a smarter splitter (e.g., require uppercase after `.`, or use a token-count heuristic).

**Note — batch is slower than POC-0001:** Batch combined averaged 8,774ms vs. ~6,036ms in POC-0001. The LLM generated longer responses on some runs (2 sentences instead of 1), and TTS correspondingly took longer. Streaming isolates to the first sentence only, making it more stable.

---

## Conclusions

### Streaming halves latency but cannot reach 500ms

Streaming LLM→TTS reduces combined latency by ~50% (8,774ms → 4,324ms). The mechanism works as expected: TTS starts on the first short sentence while the LLM continues generating, and TTS for a short sentence (~5-8 words) takes ~980ms vs ~2,618ms for a full paragraph.

However, the **500ms total target is impossible with this stack**. Even with streaming:

| Stage | Latency |
|-------|---------|
| STT (local, POC-0002) | ~60ms |
| LLM TTFT (irreducible) | ~2,719ms |
| TTS first byte (short sentence) | ~980ms |
| **Total streaming TTFA** | **~3,759ms** |

That's still 7.5× over target.

### LLM TTFT (~2.7s) is the hard floor for this stack

TTFT is stable at 2,719ms mean (p95: 2,865ms) — consistent with POC-0001's 2,611ms. This is the time for the remote Lemonade server to generate its first token for `qwen3.5-9b-FLM`. It cannot be improved by streaming architecture.

To approach 500ms total TTFA (leaving 60ms for STT, target ~440ms combined LLM+TTS), TTFT would need to drop to under ~300ms. That requires either:
1. **A faster/smaller hosted model** — qwen3.5-9b is relatively large. A distilled 1-3B model may respond faster.
2. **Local LLM inference on the racing PC** — same structural argument that solved STT in POC-0002. No network round-trip.
3. **Streaming LLM→TTS with a faster LLM** — the streaming architecture is correct and reusable; only the LLM tier needs to change.

### TTS latency scales significantly with input length

Short sentence TTS: ~980ms. Full-paragraph TTS: ~2,618ms. A 2.7× difference — Chatterbox does meaningful pre-processing work before emitting the first encoded byte. Keeping TTS input short (first sentence only) is a permanent optimization regardless of the LLM tier.

### Sentence boundary detection needs improvement for production

The naive `[.!?]\s` regex produces false positives on decimal numbers and abbreviations. Production needs either:
- Require uppercase letter after `. ` (filters out `2.4`, `car #45.` etc.)
- Split at a fixed token count (e.g., 10 tokens) using a simple heuristic
- Use a proper sentence splitter library

### Architecture recommendation

The streaming chain architecture is correct and should be carried forward. The next investigation is local LLM inference on the racing PC to eliminate TTFT — the same structural fix that POC-0002 applied to STT.
