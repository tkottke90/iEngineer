# Implementation Plan: Racing Engineer — LLM + Push-to-Talk

**Branch**: `005-llm-push-to-talk` | **Date**: 2026-07-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/005-llm-push-to-talk/spec.md`

## Summary

M5 completes the voice loop. The driver can ask questions by push-to-talk, and the engineer reasons over live race state to answer and to volunteer richer briefings. Two new paths are added on top of the M4 rule-based engine:

1. **PTT query path (Tauri → hub)**: PTT held → mic captured (`audio/capture.rs`) → transcribed locally with `whisper-rs` base.en (POC-0002) → transcript published to hub on a new Redis pub/sub channel `engineer:query` → hub assembles context → OpenAI-compatible LLM (streaming, tool calling) → per-sentence TTS → `voice:audio` clips → Tauri plays (reusing the M4 pipeline).
2. **Proactive Tier 3 path (hub)**: pit-lane-entry / safety-car / post-sector triggers on `hub:events` → same context+LLM+TTS synthesizer → `voice:audio`.

New engine capabilities: five-trait OCEAN personality shaping the system prompt, `get_fuel_status()`/`get_tire_status()` LLM tools reading `getRaceState()`, context assembly with a token-budget ceiling + field truncation, driver override tracking (pit recommendation overridden when the recommended lap completes without a pit entry), per-type adaptive deference (default 2 overrides), per-session memory fed into context, a Postgres `engineer_events` audit log, and graceful degradation (LLM down → Tier 3 skipped, Tier 1/2 unaffected; PTT during outage → canned "reasoning engine unavailable").

**Key reuse**: `TtsClient`, `AudioStore`, `PriorityMessageQueue`, `voice:audio` pub/sub, and the Tauri `PlaybackQueue` are all M4 assets. A Tier 3 message is emitted as a *sequence* of per-sentence clips through the existing queue.

## Technical Context

**Language/Version**: TypeScript (Node.js 22) — hub-server (LLM reasoning, Tier 3 synthesis, audit); Rust (edition 2021) — Tauri client (STT, PTT, mic capture); TypeScript (Preact) — UI

**Primary Dependencies**:
- Hub (new): `openai` npm SDK (OpenAI-compatible client — streaming + tool calling; `baseURL` runtime-switchable), `pg` (node-postgres — `engineer_events` audit writer). Existing: `ioredis`, `undici`/fetch (Chatterbox), `@tkottke90/logger`, OpenTelemetry.
- Tauri (new): `whisper-rs` 0.14 (features: `metal` on macOS, `vulkan` on Windows/AMD per POC-0002); `tauri-plugin-global-shortcut` (global/unfocused PTT + Stream Deck key passthrough; requires OS accessibility permission). Existing: `cpal` (capture), `rodio` (playback), `redis` (pub/sub).

**Storage**:
- **Postgres** `engineer_events` audit table (NEW consumer of the existing `infra/` postgres service) — one row per LLM interaction (prompt, response, latency, tools called, outcome, timestamp) written **before** the engineer acts on the response.
- In-process per-session memory (`Map`/object) in the hub: recommendation log, override outcomes, deference state, fuel-calibration snapshot. Not persisted beyond the session (audit trail lives in Postgres).
- Redis KV `hub:config:personality` (JSON, five traits) written by Tauri on config save, read by the engineer — analogous to the M4 `hub:config:chattiness` key it supersedes.
- Whisper model file `ggml-base.en.bin` (~142 MB) bundled with / downloaded by the Tauri client.

**Testing**: mocha + chai (hub TypeScript units + integration); cargo test (Tauri Rust); **agent evaluations** (constitution VI) for personality-direction, tool-calling correctness, and override/deference behavior — prompt changes require evals, not unit tests alone.

**Target Platform**: macOS / Windows desktop (Tauri, STT in-client); local hub server (Node.js); homelab LLM (OpenAI-compatible) + Chatterbox TTS + Redis + Postgres.

**Project Type**: npm-workspaces monorepo (desktop client + hub server + shared packages).

**Performance Goals**: Tier 3 first-audio ≤ 5 s (p95) from PTT release (POC-0003 streaming ≈ 4.3 s combined). Local STT ≈ 60 ms GPU / ≈ 345 ms CPU for a short clip (POC-0002). Tier 1/2 latency unchanged (≤ 3 s).

**Constraints**: LLM reasoning MUST NOT block the Tier 1/2 rule path or telemetry ingestion (async, isolated). LLM unreachable ⇒ Tier 3 skipped, no hang past a configured timeout. Streaming per-sentence TTS with a hardened splitter (no decimal/abbreviation false splits). Context ≤ token-budget ceiling. Advise-only (no automatic actions).

**Scale/Scope**: Single driver, single active session. Tier 3 types: driver-query, pit-entry, safety-car, post-sector. Two LLM tools (extensible). Five personality traits.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|-----------|-------|--------|
| I. Real-Time Reliability | LLM path isolated from Tier 1/2 + telemetry (async, separate failure domain)? | ✅ Tier 3 synthesis is async; rule path and `hub:events` ingestion never await the LLM. LLM failure ⇒ Tier 3 skip only. |
| I. Real-Time Reliability | Voice within budget? | ✅ **Ratified (v1.2.0)**: Tier 1/2 keep the 3 s budget; Tier 3 (LLM in-path) ≤ 5 s (SC-001), now an explicit Principle I latency class validated by POC-0003. |
| I. Real-Time Reliability | Degraded mode = silence over wrong/late? | ✅ LLM down ⇒ Tier 3 dropped with structured log; PTT ⇒ brief canned line. No stale/late synthesized output. |
| II. Workspace Isolation | New shared types via `packages/types`? | ✅ Extend `packages/types/src/engineer.ts` (Tier 3, personality traits, tools, memory, audit). |
| II. Workspace Isolation | Hub `engineer/` + Tauri `stt/` self-contained; no cross-app imports? | ✅ Hub modules import only `packages/types`; Tauri STT is in-process. |
| III. Agent Autonomy | Advise-only (no automatic car/strategy action)? | ✅ FR-025; every Tier 3 output is spoken advice only. |
| III. Agent Autonomy | Prompts in source-controlled files under `apps/hub-server/prompts/` with purpose + I/O schema headers? | ✅ New `apps/hub-server/prompts/` dir; system prompt + per-Tier-3-type prompts, each with header. No inline prompt strings. |
| III. Agent Autonomy | LLM request+response logged to Postgres before acting? | ✅ `engineer_events` write precedes acting on the response (FR-022, SC-008). |
| III. Agent Autonomy | Prompt changes backed by evaluations? | ✅ Eval harness for personality/tool/override behavior (constitution VI). |
| IV. Local-First | LLM = OpenAI-compatible local endpoint, runtime-switchable, no hard-coded provider (Claude default remains switchable)? | ✅ `openai` SDK with configurable `baseURL`/model; provider selected at runtime. |
| IV. Local-First | STT self-hosted / offline? | ✅ **Ratified (v1.2.0)**: Technology Constraints table now names in-client **`whisper-rs`** (Metal/Vulkan), base.en, no cloud, no network hop (POC-0001/0002). |
| IV. Local-First | New infra dependency in `infra/docker-compose.yml` before code references it? | ✅ Postgres already in compose; M5 is its first consumer. No new service (Speaches stays out; STT is in-client). |
| V. Observability | LLM interactions (prompt+response+latency) → Postgres? | ✅ `engineer_events` (closes the constitution's M5 follow-up TODO). |
| V. Observability | No silent failures — every skipped decision emits a structured log? | ✅ empty-transcription, stt-failure, llm-unreachable, context-truncated, queue-cap-drop all logged. |
| VI. Test-Backed Change | Units for new modules + evals for agent decision paths + workspace build/typecheck/lint? | ✅ Required before merge (see Definition of Done). |
| VII. YAGNI | One agent only (Racing Engineer, not Stream Engineer)? | ✅ Stream Engineer untouched. |
| VII. YAGNI | Complexity justified, no speculative abstractions? | ✅ Two LLM tools (not a generic registry beyond need); per-session memory only (no cross-session store). |

**Constitution violations**: None outstanding. The two deviations (Tier 3 ≤5s latency budget; STT via `whisper-rs` instead of Speaches) were **ratified in constitution v1.2.0 (2026-07-02)** — Principle I now defines a Tier 3 latency class and the Technology Constraints table names `whisper-rs`. The `engineer_events` table is pre-authorized by the constitution's M5 follow-up TODO. Implementation may proceed against v1.2.0.

## Project Structure

### Documentation (this feature)

```text
specs/005-llm-push-to-talk/
├── plan.md              # This file
├── research.md          # Phase 0 — technology + architecture decisions
├── data-model.md        # Phase 1 — types, entities, state transitions
├── quickstart.md        # Phase 1 — validation scenarios
├── contracts/
│   ├── engineer-query-channel.md   # Redis engineer:query (Tauri → hub) + STT contract
│   ├── llm-tools.md                # get_fuel_status / get_tire_status tool schemas
│   ├── tier3-synthesis.md          # context assembly, streaming, sentence-split, voice:audio reuse
│   ├── personality-prompt.md       # 5-trait OCEAN model → system prompt construction
│   └── engineer-events-audit.md    # Postgres engineer_events schema + write contract
└── tasks.md             # Phase 2 — generated by /speckit-tasks
```

### Source Code

```text
packages/types/src/
└── engineer.ts                       # Extend: AlertTier→add 3; PersonalityTraits (5×1–5);
                                       #   Tier3Type, Tier3Message, ReasoningContext, LlmToolResult,
                                       #   RecommendationLogEntry, RecommendationOutcome, SessionMemory,
                                       #   DeferenceState, EngineerQuery, EngineerEvent(audit)

apps/hub-server/
├── prompts/                          # NEW — source-controlled prompts (header: purpose + I/O schema)
│   ├── system-base.md                # Engineer persona + safety/advise-only rules
│   ├── personality.md                # 5-trait construction fragment
│   ├── tier3-driver-query.md
│   ├── tier3-pit-entry.md
│   ├── tier3-safety-car.md
│   └── tier3-post-sector.md
├── migrations/
│   └── 001_engineer_events.sql       # NEW — engineer_events table
├── config/
│   └── engineer-config.json          # Extend: llm{baseUrl,model,provider,timeoutMs,tokenBudget},
│                                     #   personality defaults (5 traits), deferenceThreshold, queueDepthCap
└── src/
    ├── db/
    │   └── client.ts                 # NEW — pg Pool + migration runner
    ├── engineer/
    │   ├── llm-client.ts             # NEW — OpenAI-compatible streaming + tool-call loop
    │   ├── tools.ts                  # NEW — get_fuel_status/get_tire_status over getRaceState()
    │   ├── context-assembler.ts      # NEW — ReasoningContext + token budget + truncation
    │   ├── sentence-splitter.ts      # NEW — hardened boundary detection (POC-0003 fix)
    │   ├── tier3-synthesizer.ts      # NEW — orchestrate context→LLM→split→TTS→voice:audio
    │   ├── session-memory.ts         # NEW — recommendation log, calibration, deference state
    │   ├── override-tracker.ts       # NEW — window-close detection + outcome recording
    │   ├── engineer-events.ts        # NEW — Postgres audit writer
    │   ├── personality-config.ts     # Extend — 5-trait model; Energy=1 suppression (was Chattiness=Low)
    │   ├── message-queue.ts          # Extend — Tier 3 ordering (T1>T2>T3; driver-query ahead of commentary)
    │   └── racing-engineer.ts        # Extend — subscribe engineer:query; Tier 3 triggers; degradation
    └── server-init.ts                # Wire pg pool, llm client, synthesizer, override tracker

apps/tauri-client/src-tauri/
├── Cargo.toml                        # Add whisper-rs (metal/vulkan features)
└── src/
    ├── stt/
    │   ├── mod.rs                    # NEW
    │   └── whisper.rs                # NEW — load ggml-base.en; transcribe(Vec<f32>) → String
    ├── audio/capture.rs              # Extend — PTT-gated buffered capture for a query clip
    ├── hotkeys/ptt.rs               # Extend — press→start capture, release→transcribe→publish;
    │                                 #   global (unfocused) hotkey + Stream Deck passthrough
    └── engineer/
        └── query_publisher.rs        # NEW — publish EngineerQuery JSON to engineer:query channel

apps/tauri-client/src/pages/
└── Setup.tsx                         # Extend — personality (5 sliders) + PTT binding UI

packages/ui/src/components/
└── PersonalityPanel/index.tsx        # NEW — five 1–5 trait sliders with word labels
```

**Structure Decision**: Extends the M4 layout. The LLM/reasoning tier lives entirely in the hub (Node) reusing the M4 audio-delivery pipeline; STT lives entirely in the Tauri client (POC-0002). The two halves communicate over Redis pub/sub in both directions (`engineer:query` inbound, `voice:audio` outbound), symmetric with the existing telemetry/audio patterns — no direct app-to-app imports (Principle II).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Tier 3 latency 5 s vs constitution's 3 s | LLM reasoning (TTFT ≈ 2.7 s) is irreducible in this stack (POC-0003); a reasoned answer inherently exceeds 3 s | A 3 s Tier 3 budget is physically unachievable without local sub-300 ms LLM inference (POC-0004, not yet run). Tier 1/2 remain at 3 s; only the new LLM class relaxes. **Ratified in v1.2.0.** |
| STT via `whisper-rs` (in-client) vs Speaches (constitution tech table) | POC-0001 measured Speaches remote STT at 12 s (network upload dominates); POC-0002 measured in-client `whisper-rs` at ~60 ms | Speaches keeps the network hop that POC-0001 proved fatal to the latency budget. Still offline Whisper base.en (satisfies local-first intent). **Ratified in v1.2.0.** |
| New `pg` client + `engineer_events` in hub | Constitution V/III require LLM audit to Postgres; M5 introduces the first LLM path | No audit = violates the (now-active) observability gate. Console logs alone are insufficient for LLM forensics per the constitution rationale. Pre-authorized by the M5 follow-up TODO. |

## Implementation Phases

### Phase A: Shared types + config + migration (prerequisite)
1. Extend `packages/types/src/engineer.ts` with all new types (see data-model.md).
2. Extend `engineer-config.json` (`llm`, five-trait personality defaults, `deferenceThreshold`, `queueDepthCap`, `tokenBudget`, `ttfaTimeoutMs`).
3. Add `apps/hub-server/migrations/001_engineer_events.sql`.
4. Extend Tauri `AppConfig` with the five personality traits (default 3) and confirm PTT binding fields.
**Gate**: `npm run build && npm run typecheck` workspace-wide.

### Phase B: Hub — Postgres + audit writer
1. `db/client.ts` — pg Pool from env; run migrations on startup.
2. `engineer-events.ts` — `recordEvent(EngineerEvent)`; write-before-act.
**Gate**: unit test (mocked pg) for the write contract; integration test against a local Postgres.

### Phase C: Hub — LLM client, tools, context, splitter (pure-ish logic)
1. `tools.ts` — `getFuelStatus()`/`getTireStatus()` over `getRaceState()`; "not-yet-available" results.
2. `context-assembler.ts` — build `ReasoningContext`; enforce token budget; deterministic truncation + log.
3. `sentence-splitter.ts` — hardened boundary rule (POC-0003 decimals/abbreviations fix).
4. `llm-client.ts` — OpenAI-compatible streaming + tool-call loop; response ceiling; timeout; reachability result.
**Gate**: unit tests for tools (available/unavailable), truncation (over/under budget), splitter (decimal/abbrev cases). Eval: tool-calling correctness.

### Phase D: Hub — personality, Tier 3 synthesizer, message-queue
1. `personality-config.ts` — 5-trait model + Redis `hub:config:personality`; Energy=1 suppression.
2. `message-queue.ts` — Tier 3 ordering (T1>T2>T3; driver-query ahead of proactive commentary); no interrupt.
3. `tier3-synthesizer.ts` — context → LLM stream → split → per-sentence TTS clip → `voice:audio`; audit each interaction; degradation (skip + canned line).
**Gate**: units for suppression + queue ordering; integration: synthetic pit-entry ⇒ `voice:audio` sequence; LLM-down ⇒ skip + Tier 1/2 intact. Eval: personality direction.

### Phase E: Hub — override tracking, deference, session memory, wiring
1. `session-memory.ts` — recommendation log, calibration snapshot, deference state; feed context-assembler.
2. `override-tracker.ts` — pit recommendation `pending→overridden` on recommended-lap S/F crossing w/o pit entry; `→followed` on pit entry; per-type deference (default 2).
3. `racing-engineer.ts` — subscribe `engineer:query`; fire Tier 3 triggers; integrate memory/override; deference resets per session.
**Gate**: units for window-close and deference; integration: override recorded, recommendation not repeated (SC-006), deference shift (SC-007). Eval: override framing.

### Phase F: Tauri — STT + PTT capture + transcript publish
1. `Cargo.toml` — `whisper-rs` (metal/vulkan); model file provisioning.
2. `stt/whisper.rs` — load base.en; `transcribe(Vec<f32>, sample_rate) → String`.
3. `audio/capture.rs` — PTT-gated buffered capture; `hotkeys/ptt.rs` press/release wiring; global hotkey + Stream Deck passthrough; empty/non-speech ⇒ no publish (log).
4. `engineer/query_publisher.rs` — publish `EngineerQuery` to `engineer:query`.
**Gate**: `cargo test` for capture buffering + empty-transcript guard; manual: speak "Do we pit this lap?" ⇒ transcript on `engineer:query`.

### Phase G: UI — personality + PTT settings
1. `PersonalityPanel` (5 sliders, word labels) → writes `hub:config:personality` via existing config save; add to `Setup.tsx`.
2. PTT binding UI (hotkey + Stream Deck passthrough note).
**Gate**: manual per quickstart; typecheck/lint.

### Phase H: Infra + end-to-end
1. Confirm Postgres service running; migration applied. LLM endpoint reachable + OpenAI-compatible (tool calling + streaming verified).
**Gate**: full deploy test (SC-010): ask "Do we pit this lap?" → briefing < 5 s; override a pit recommendation → not repeated.

## Definition of Done

- [ ] Unit tests pass: `npm test` (hub), `cargo test` (Tauri).
- [ ] Agent evals pass: personality direction, tool-calling correctness, override/deference behavior.
- [ ] `npm run build && npm run typecheck` workspace-wide; ESLint + Prettier; rustfmt + clippy.
- [ ] `engineer_events` rows written for 100% of LLM interactions before acting (SC-008).
- [ ] LLM-down: Tier 1/2 unaffected; Tier 3 skipped with logs; PTT ⇒ canned line (SC-003).
- [ ] Deploy test (SC-010): sub-5 s briefing for "Do we pit this lap?"; overridden pit recommendation not repeated (SC-006).
- [ ] Constitution amendment ratified (or explicitly waived) for the Tier 3 budget + STT tech-table row.
