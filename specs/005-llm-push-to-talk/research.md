# Phase 0 Research: Racing Engineer — LLM + Push-to-Talk

All Technical Context unknowns are resolved below. Each item: **Decision / Rationale / Alternatives considered**.

## R1. LLM client (hub, Node)

- **Decision**: Use the official `openai` npm SDK configured with a runtime `baseURL` (homelab Lemonade OpenAI-compatible endpoint) and model name from `engineer-config.json`; provider is switchable (Claude API remains an option via config). Use its streaming (`stream: true`) + tool-calling APIs.
- **Rationale**: POC-0003 validated OpenAI-compatible streaming against Lemonade. The `openai` SDK is the de-facto OpenAI-compatible client, supports streaming deltas and the tool-call loop, and honors a custom `baseURL` — satisfying constitution IV ("no hard-coded provider, runtime-switchable"). Keeps the streaming-per-sentence architecture POC-0003 proved.
- **Alternatives**: LangChain `ChatOpenAI` (POC-0003 used it, but adds a heavy dependency for one call site — YAGNI); raw `fetch` against `/v1/chat/completions` (reimplements SSE parsing + tool-call accumulation, more error-prone); Anthropic SDK directly (breaks the "OpenAI-compatible" brief and runtime-switchability).

## R2. STT engine + location

- **Decision**: `whisper-rs` 0.14 (base.en, `metal` on macOS / `vulkan` on Windows AMD) running in-process in the Tauri client. Fallback model tiny.en if Vulkan underperforms.
- **Rationale**: POC-0002 measured ~60 ms GPU / ~345 ms CPU in-client vs POC-0001's ~12 s for remote Speaches — the network upload was the bottleneck. base.en is the recommended production model (accuracy vs size). Runs synchronously in the Rust backend, no IPC/network hop.
- **Deviation flagged**: constitution tech table lists "Whisper via Speaches"; this is an intentional POC-driven change (see plan Complexity Tracking; amendment recommended).
- **Alternatives**: Speaches remote (rejected — 12 s latency); cloud STT (violates local-first); small.en (higher accuracy but ~140 ms GPU, unnecessary for short clear phrases).

## R3. Transcript delivery Tauri → hub

- **Decision**: New Redis pub/sub channel `engineer:query` carrying an `EngineerQuery` JSON `{ transcript, sessionId, capturedAtMs, queryId }`, published by the Tauri client, subscribed by `RacingEngineerService`.
- **Rationale**: Symmetric with the existing outbound `voice:audio` pub/sub and the telemetry publisher pattern; keeps app-to-app decoupling (Principle II); no new transport. The hub already holds a subscribed connection pattern (`racing-engineer.ts` duplicates its connection).
- **Alternatives**: Hub HTTP POST endpoint (adds a request/response path the client doesn't otherwise need; pub/sub is fire-and-forget and matches existing code); Redis Streams (durability unneeded for a live voice query; pub/sub is lower overhead).

## R4. LLM tools (function calling)

- **Decision**: Two tools, `get_fuel_status()` and `get_tire_status()`, implemented over the hub's injected `getRaceState()` snapshot (fuel from `FuelModelEngine`/hero state, tires from `TireModelEngine`/hero state). Each returns a structured JSON result including an `available: boolean` and, when false, a reason (e.g., pre-first-flying-lap).
- **Rationale**: `RacingEngineerService` already receives `getRaceState: () => RaceState`; tools read the same source the rule engine uses — single source of truth, no fuel/tire math duplicated (mirrors the M4 FR-014 principle). FR-008 requires well-formed "not-yet-available" results.
- **Alternatives**: Let the LLM infer fuel/tire from raw context (rejected — FR-007 forbids fabrication; tools guarantee consistency, SC-002); direct DB/Redis reads inside the tool (rejected — `getRaceState()` is the established accessor).

## R5. Context assembly + token budget

- **Decision**: `context-assembler.ts` builds a structured `ReasoningContext` from the race-state snapshot + a session-memory excerpt, enforcing a configurable `tokenBudget` ceiling with deterministic priority-ordered truncation (drop oldest/lowest-priority memory first: post-sector history → older recommendations → verbose telemetry fields), logging a `context-truncated` event when applied. Token estimate via a cheap char/word heuristic (≈ 4 chars/token) — no tokenizer dependency.
- **Rationale**: FR-012 requires a hard ceiling with deterministic truncation and a log. A heuristic estimate is sufficient to stay comfortably under a model's context window while leaving response room; exact tokenization is overkill for a single-turn budget guard (YAGNI).
- **Alternatives**: Exact tokenizer (`tiktoken`/`gpt-tokenizer`) — adds a dependency for marginal precision; no ceiling / send-everything — risks context-window overflow and cost (rejected).

## R6. Streaming sentence splitter

- **Decision**: Hardened boundary rule: split on `[.!?]` + whitespace **only when** not preceded by a digit (decimals like `2.4`) and the next non-space char is uppercase or end-of-stream; treat common abbreviations as non-boundaries. Dispatch each completed sentence to TTS immediately; hold a trailing fragment until completed or stream end.
- **Rationale**: POC-0003 found the naive `[.!?]\s` regex fragmented on decimals ("You are 2." from "2.4 seconds"). Keeping TTS input to one short sentence is a permanent latency win (~980 ms vs ~2.6 s first byte).
- **Alternatives**: NLP sentence library (heavier, unnecessary for 1–2 sentence answers); fixed token-count chunking (can split mid-clause, worse prosody); no splitting/batch (rejected — doubles latency per POC-0003).

## R7. Postgres audit (`engineer_events`)

- **Decision**: Add `pg` (node-postgres) with a Pool in `db/client.ts`; a plain-SQL migration `001_engineer_events.sql` run on startup. `engineer-events.ts` exposes `recordEvent()` writing prompt, response, latency, tools-called, outcome, tier3 type, session id, timestamp **before** the engineer acts on the response.
- **Rationale**: Constitution III/V now require Postgres LLM audit (M5 gate active; pre-authorized by the constitution's follow-up TODO). `pg` is the minimal, well-understood driver; raw SQL migration avoids an ORM for a single table (YAGNI).
- **Alternatives**: Drizzle/Prisma/Kysely (ORM overhead for one table — rejected); log-only to console/OTel (insufficient for the forensic-reproducibility rationale the constitution states); Redis persistence (not durable/queryable for post-session forensics).

## R8. Personality model → prompt construction

- **Decision**: Five OCEAN-based traits, each integer 1–5 with word anchors (per spec Personality Config), stored in `hub:config:personality` (Redis KV) and `engineer-config.json` defaults (all 3). `prompts/personality.md` maps each trait level to a descriptive instruction fragment composed into `prompts/system-base.md`. Energy=1 (Tranquil) is the hard suppression gate (supersedes M4 `chattiness==='Low'`); the other trait effects are prompt-shaping.
- **Rationale**: Word-anchored levels give the LLM concrete, evaluable direction (the user's stated goal) while remaining a small config surface. Constitution III requires source-controlled prompt files with headers; personality construction is a behavioral change requiring evals (VI).
- **Alternatives**: Free numeric 0–10 (harder to write discrete evals — rejected in clarify Q1); two-level per trait (too coarse); inline prompt strings (violates III).

## R9. Override detection + adaptive deference

- **Decision**: `override-tracker.ts` watches `hub:events` for the recommended-lap start/finish crossing and pit-entry events. A pit recommendation is `pending→overridden` when the car completes the recommended lap without a pit entry, `pending→followed` on a pit entry within the window. Deference is per recommendation type, default 2 overrides (configurable), resetting each session; in deference mode the type is presented as information (no directive) unless the driver directly asks via PTT.
- **Rationale**: Directly encodes clarify Q2/Q3. Lap/pit-entry events already flow on `hub:events` (M4 uses `hero:pit_exit`); no new telemetry needed. Per-type deference avoids over-generalizing (Q3).
- **Alternatives**: Time-boxed window (rejected in Q2 — lap-based matches M4 dedup); global deference (rejected in Q3 — silences unrelated advice).

## R10. Tier 3 queue ordering + concurrent PTT

- **Decision**: Extend `PriorityMessageQueue` to three tiers: dispatch order T1 (head) > T2 > T3; within T3, on-demand driver-query ahead of proactive commentary. No clip is ever interrupted (M4 rule preserved). Concurrent PTT: single in-flight query; additional presses queue FIFO up to a configurable `queueDepthCap`, excess dropped with a `queue-cap-drop` log.
- **Rationale**: FR-015 (Tier 3 behind pending Tier 1, no interrupt) + clarify Q4 (FIFO queue, single in-flight, bounded). A Tier 3 message is a *sequence* of per-sentence clips enqueued as they synthesize; a Tier 1 alert arriving mid-stream preempts the not-yet-played Tier 3 clips at dispatch (queue reorders pending only).
- **Alternatives**: Supersede newest (rejected in Q4); unbounded queue (rejected — rapid presses stack); Tauri-side reordering (M4 already dispatches FIFO post-queue — ordering is enforced hub-side).

## R11. Graceful degradation + PTT-during-outage

- **Decision**: `llm-client.ts` returns a reachability/timeout result rather than throwing into the rule path. On unreachable/timeout: Tier 3 triggers are skipped with a `llm-unreachable` log; a PTT query yields a brief **canned** TTS line ("Reasoning engine unavailable") via the existing `TtsClient` (no LLM), plus a log. Recovery is automatic on the next trigger/query (stateless reachability check per attempt).
- **Rationale**: Encodes clarify Q5 + FR-023/024 + constitution I (silence/degrade over crash; path isolation). Canned line reuses TtsClient so it works with the LLM fully down.
- **Alternatives**: Silent (rejected in Q5 — indistinguishable from broken mic); non-LLM fallback answer reading raw tools (deferred — more scope; canned line is the pinned Q5 answer).

## R12. Global PTT hotkey + Stream Deck passthrough

- **Decision**: Use a global (OS-level, unfocused) shortcut for PTT so activation works while the sim is focused; Stream Deck maps a key that the same global handler receives (passthrough of a keyboard key, not a bespoke integration). Extend the existing `hotkeys/ptt.rs` listener.
- **Rationale**: FR-003 requires activation without client focus; racing keeps focus on the sim. Stream Deck sends standard key events, so a global key handler covers both hardware and Stream Deck with one path.
- **Alternatives**: Window-focused hotkey (rejected — client isn't focused during racing); Stream Deck WebSocket plugin (over-engineered vs key passthrough — YAGNI).

## Open items deferred to implementation (not blocking)

- Exact `tokenBudget` value and per-field truncation priority list — tuned in Phase C against the chosen model's context window.
- Whisper model provisioning (bundle vs first-run download) — packaging detail in Phase F.
- Post-sector commentary cadence value (min laps/seconds between) — config default set in Phase D, governed by Energy.
