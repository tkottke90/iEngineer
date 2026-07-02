# Contract: Tier 3 Synthesis Pipeline

Reuses the M4 audio-delivery pipeline (`TtsClient`, `AudioStore`, `voice:audio`, Tauri `PlaybackQueue`). A Tier 3 message is delivered as a **sequence of per-sentence clips**.

## Triggers
| Type | Trigger source |
|------|----------------|
| `driver-query` | `EngineerQuery` on `engineer:query` |
| `pit-entry` | pit-lane-entry event on `hub:events` |
| `safety-car` | safety-car deployment on `hub:events` (Tier 1 alert still fires immediately, independently — FR-016) |
| `post-sector` | `hero:lap_complete` on `hub:events` (lap boundary; sector granularity deferred), cadence ≥ `postSectorMinLapGap` laps, suppressed at Energy=1 |

## Pipeline (per trigger)
1. **Suppression check** — Energy=1 ⇒ suppress `post-sector` (and Tier 2) commentary; skip with log.
2. **Deference check** — if the relevant recommendation type is in `deferredTypes`, synthesize in information mode (no directive) unless `driver-query`. (FR-021)
3. **Context assembly** — `context-assembler.ts` → `ReasoningContext` within `tokenBudget` (truncate + log if over). (FR-011/012)
4. **Prompt build** — `system-base.md` + `personality.md` (5-trait fragment) + per-type prompt file + context. (FR-013)
5. **Audit pre-write** — insert `EngineerEvent` (outcome provisional) BEFORE the LLM acts / before speaking. (FR-022)
6. **LLM stream** — `llm-client.ts` streams tokens; tool-call loop as needed; enforce `maxResponseTokens` + `timeoutMs`.
7. **Sentence split** — `sentence-splitter.ts` emits each completed sentence (hardened boundary; no decimal/abbrev fragments).
8. **Per-sentence TTS** — `TtsClient.generateClip(sentence)` → `AudioStore` → publish `AudioClipRef` on `voice:audio`.
9. **Enqueue/ordering** — clips enter `PriorityMessageQueue` as Tier 3; dispatch order **T1 > T2 > T3**; within T3, `driver-query` ahead of proactive commentary; **no in-progress clip is ever interrupted** (FR-015).
10. **Audit finalize** — update `EngineerEvent` with response, latency, tools, outcome (`synthesized`).

## Degradation (FR-023/024)
- LLM unreachable/timeout at step 6 ⇒ abort synthesis; `EngineerEvent.outcome = skipped-llm-unreachable`; log `{ reason:"llm-unreachable", type }`.
  - `driver-query` ⇒ speak canned "Reasoning engine unavailable" (no LLM).
  - proactive types ⇒ silent skip (log only).
- Tier 1/2 rule alerts are produced on a separate path and are unaffected by any Tier 3 failure. (SC-003)
- Recovery is automatic on the next trigger (per-attempt reachability; no restart). (FR-024)

## Non-blocking guarantee
- Synthesis runs async off the `hub:events` handler; the rule engine and telemetry ingestion never await the LLM. (Constitution I)
