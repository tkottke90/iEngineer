# Tasks: Racing Engineer — LLM + Push-to-Talk

**Input**: Design documents from `specs/005-llm-push-to-talk/`

**Prerequisites**: plan.md ✅ spec.md ✅ research.md ✅ data-model.md ✅ contracts/ ✅ quickstart.md ✅

**Tests**: INCLUDED — Constitution VI (NON-NEGOTIABLE) requires automated tests for all agent decision paths and **evaluations** (not unit tests alone) for prompt/personality changes. Test and eval tasks are embedded in each phase.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with other [P] tasks in the same phase (different files, no shared dependencies)
- **[Story]**: Which user story this task belongs to (US1–US7)
- Exact file paths are relative to repo root

## Story priority map (from spec.md)

| Story | Priority | Theme |
|-------|----------|-------|
| US1 | P1 🎯 MVP | On-demand PTT voice query |
| US7 | P1 | Graceful degradation when LLM unreachable |
| US2 | P2 | Proactive Tier 3 briefings |
| US3 | P2 | Personality shapes the engineer's voice |
| US4 | P2 | Driver override tracking |
| US5 | P3 | Adaptive deference after repeated overrides |
| US6 | P3 | Session memory informs reasoning |

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Shared types, config, migration, dependencies, and infra wiring. No story work begins until T010 passes.

- [ ] T001 Extend `packages/types/src/engineer.ts` per data-model.md: change `AlertTier` to `1 | 2 | 3`; **replace** `PersonalityConfig` with the five OCEAN traits (`openness`/`warmth`/`energy`/`conscientiousness`/`assertiveness`, each `1|2|3|4|5`); add `Tier3Type`, `Tier3Message`, `LlmToolResult`, `ReasoningContext`, `RecommendationOutcome`, `RecommendationLogEntry`, `SessionMemory`, `DeferenceState`, `EngineerQuery`, `EngineerEvent`. Keep the existing M4 exports (`QueuedAlert`, `AudioClipRef`, `EngineerFailureLog`, `RadioBlackoutZone`, `EngineerConfig`). Remove the `Chattiness` type (superseded by `energy`) only after confirming no remaining M4 references outside code updated in T016.
- [ ] T002 [P] Extend `EventType` in `packages/types/src/events.ts` for M5 proactive triggers. Verified current state: `hero:pit_entry` and `session:safety_car_deployed` **already exist** (M4) — do NOT duplicate. Add exactly one new type: **`hero:lap_complete`** (emitted when the hero completes a lap; the post-sector commentary trigger — sector-level granularity is deferred, so post-sector commentary fires at lap boundaries in M5, cadence-gated by `postSectorMinLapGap` which is measured in laps). Run `npm run typecheck` after.
- [ ] T003 Re-export all new engineer types from `packages/types/src/index.ts`.
- [ ] T004 Extend `apps/hub-server/config/engineer-config.json`: add `llm: { baseUrl, model, provider: "openai-compatible", timeoutMs, maxResponseTokens, tokenBudget }`, `personality` (all five traits default `3`), `deferenceThreshold: 2`, `queueDepthCap` (e.g. `3`), `postSectorMinLapGap` (e.g. `2`). Do not hard-code provider anywhere else (Constitution IV).
- [ ] T005 [P] Add `apps/hub-server/migrations/001_engineer_events.sql` exactly per `contracts/engineer-events-audit.md` (table + `idx_engineer_events_session`).
- [ ] T006 [P] Add hub deps in `apps/hub-server/package.json`: `openai` (OpenAI-compatible client) and `pg` + `@types/pg`; run `npm install` at repo root (workspaces).
- [ ] T007 [P] Add `whisper-rs = "0.14"` to `apps/tauri-client/src-tauri/Cargo.toml` with `metal` (macOS) / `vulkan` (Windows) feature flags mirroring `pocs/0002-local-stt-latency/Cargo.toml`; document the model-file requirement (`ggml-base.en.bin`) in a comment. Also add the Tauri **global-shortcut plugin** (`tauri-plugin-global-shortcut`) to `Cargo.toml` + register it in `lib.rs`, and note the macOS/Windows OS **accessibility permission** required for global (unfocused) key capture — needed by T034 (FR-003).
- [ ] T008 Extend `AppConfig` in `apps/tauri-client/src-tauri/src/state.rs`: replace the M4 `chattiness`/`familiarity`/`aggression` String stubs with five `u8` personality fields (default `3`); update the `Default` impl; confirm `ptt_hotkey: String` (default `"F13"`) is present.
- [ ] T009 [P] Wire hub Postgres connection env (`DATABASE_URL` or discrete vars) in `apps/hub-server` startup config; confirm the `postgres` service is enabled in `infra/docker-compose.yml` (already present) and reachable.
- [ ] T010 Run `npm run build && npm run typecheck` workspace-wide + `cargo check` (tauri) — must pass before Phase 2.

**Checkpoint**: Types compile, config/migration/deps in place. Foundational work may begin.

---

## Phase 2: Foundational — Hub Reasoning / Delivery / Audit Engine (Blocking Prerequisites)

**Purpose**: The shared hub-side engine that turns *(trigger + context)* into spoken Tier 3 audio, with audit, personality, token budget, and streaming TTS. **⚠️ Every Tier 3 story depends on this phase.** Reuses M4 `TtsClient`, `AudioStore`, `voice:audio`, and the Tauri `PlaybackQueue`.

- [ ] T011 Implement `apps/hub-server/src/db/client.ts` — pg `Pool` from env; `runMigrations()` that applies `migrations/*.sql` idempotently on startup; export a `getPool()` accessor.
- [ ] T012 Implement `apps/hub-server/src/engineer/engineer-events.ts` — `recordEvent(partial): Promise<string>` INSERTs a provisional row **before** the LLM response is acted upon; `finalizeEvent(id, { response, latencyMs, toolsCalled, outcome })` UPDATEs it. On pre-write failure, degrade to skip-with-log (fail-closed on audit) per `contracts/engineer-events-audit.md` (FR-022).
- [ ] T013 [P] Tests for `engineer-events.ts` in `apps/hub-server/tests/unit/engineer/engineer-events.test.ts` (mocked pg: assert write-before-act ordering + fail-closed) and an integration test against a local Postgres (row shape + index).
- [ ] T014 [P] Create `apps/hub-server/prompts/system-base.md` with header (purpose + input/output schema per Constitution III): engineer persona, **advise-only** safety rule (never instruct automatic actions — FR-025), brevity, tool-use guidance.
- [ ] T015 [P] Create `apps/hub-server/prompts/personality.md` with header — scaffold of the five-trait construction fragment (full 1–5 mapping completed in US3/T051). No inline prompt strings elsewhere.
- [ ] T016 Extend `apps/hub-server/src/engineer/personality-config.ts` — load `PersonalityConfig` (5 traits) from Redis KV `hub:config:personality` (fallback to `engineer-config.json` defaults + warning log on absent/malformed); replace M4 `shouldSuppressAlert(..., chattiness)` with an `energy`-based gate: **`energy === 1` suppresses Tier 2 and Tier 3 commentary** (supersedes `chattiness==='Low'`). Update all M4 call sites (`racing-engineer.ts` dispatcher).
- [ ] T017 [P] Tests for `personality-config.ts` in `apps/hub-server/tests/unit/engineer/personality-config.test.ts` — Energy=1 suppresses Tier 2/T3 commentary; Energy≥2 passes; malformed/absent Redis key → defaults + single warning log; Tier 1 never suppressed.
- [ ] T018 [P] Implement `apps/hub-server/src/engineer/tools.ts` — `getFuelStatus()` and `getTireStatus()` over the injected `getRaceState()` snapshot, returning `LlmToolResult` with `available:false`+reason when data is missing (pre-flying-lap / uncalibrated), per `contracts/llm-tools.md` (FR-007/008).
- [ ] T019 [P] Tests for `tools.ts` in `apps/hub-server/tests/unit/engineer/tools.test.ts` — available path returns the race-state values; unavailable path returns `available:false` with reason (no fabrication).
- [ ] T020 [P] Implement `apps/hub-server/src/engineer/sentence-splitter.ts` — hardened boundary rule per research R6: split on `[.!?]` + space only when not preceded by a digit and followed by uppercase/EOS; hold trailing fragment until complete/stream-end (POC-0003 fix).
- [ ] T021 [P] Tests for `sentence-splitter.ts` in `apps/hub-server/tests/unit/engineer/sentence-splitter.test.ts` — "You are 2.4 seconds behind" yields ONE sentence (not "You are 2."); abbreviations ("No. 45") not split; multi-sentence streams split correctly.
- [ ] T022 Implement `apps/hub-server/src/engineer/context-assembler.ts` — build `ReasoningContext` from the race-state snapshot + `SessionMemory` excerpt; enforce `config.llm.tokenBudget` with deterministic priority-ordered truncation (drop oldest/lowest-priority first); set `truncated:true` and emit a `context-truncated` structured log when applied (FR-011/012, SC-009). Token estimate via char/word heuristic (no tokenizer dep).
- [ ] T023 [P] Tests for `context-assembler.ts` in `apps/hub-server/tests/unit/engineer/context-assembler.test.ts` — under-budget passes untruncated; over-budget truncates below ceiling + emits log; oldest memory dropped first.
- [ ] T024 Implement `apps/hub-server/src/engineer/session-memory.ts` — `SessionMemory` holder (recommendation log, fuelCalibration, `DeferenceState`) keyed per session; `reset()` on new session. Enriched by US4/US5/US6; this task provides the scaffold consumed by T022.
- [ ] T025 Implement `apps/hub-server/src/engineer/llm-client.ts` — OpenAI-compatible client (`openai` SDK, `baseURL`/model from config); streaming chat completion + tool-call loop (execute `tools.ts`, append results, continue); enforce `maxResponseTokens` ceiling and `timeoutMs`; return a discriminated result `{ ok, text, toolsCalled, latencyMs } | { unreachable } | { timedOut }` (never throws into the rule path) per research R1/R11.
- [ ] T026 [P] Tests for `llm-client.ts` in `apps/hub-server/tests/unit/engineer/llm-client.test.ts` — mocked stream happy path; tool-call loop invokes the tool and continues; timeout → `timedOut`; connection error → `unreachable`; response ceiling enforced.
- [ ] T027 Extend `apps/hub-server/src/engineer/message-queue.ts` — add Tier 3 to `PriorityMessageQueue`: dispatch order **T1 > T2 > T3**; within T3, `driver-query` ahead of proactive commentary; preserve M4 no-interrupt + Tier 2 30s-timeout rules; a Tier 1 arriving mid-stream preempts only *pending* (not-yet-dispatched) T3 clips (FR-015, research R10).
- [ ] T028 [P] Tests for the Tier 3 queue changes in `apps/hub-server/tests/unit/engineer/message-queue.test.ts` — T3 dequeues behind T1 and T2; driver-query ahead of commentary; in-progress clip never interrupted; existing M4 assertions still pass.
- [ ] T029 Implement `apps/hub-server/src/engineer/tier3-synthesizer.ts` — orchestrate the happy path per `contracts/tier3-synthesis.md`: suppression check → deference check (stub until US5) → `context-assembler` → prompt build (`system-base` + `personality` + per-type file) → **audit pre-write** (`recordEvent`) → `llm-client` stream → `sentence-splitter` → per-sentence `TtsClient.generateClip` → `AudioStore` → publish `AudioClipRef` on `voice:audio` (enqueue as Tier 3) → `finalizeEvent`. Runs async off the event handler (never blocks the rule path — Constitution I).
- [ ] T030 [P] Integration test for the synthesizer in `apps/hub-server/tests/integration/tier3-synthesizer.test.ts` — feed a synthetic context; assert a `voice:audio` sequence is published and exactly one `engineer_events` row (`outcome=synthesized`) is written (mock Chatterbox + LLM at their boundaries).
- [ ] T031 Wire the engine in `apps/hub-server/src/server-init.ts` — construct pg pool + run migrations, llm-client, personality-config, session-memory, engineer-events, tier3-synthesizer; inject into `RacingEngineerService`.

**Checkpoint**: `npm test` passes for all foundational units + the synthesizer integration test. The reasoning engine can synthesize Tier 3 audio from a trigger. Story phases may begin.

---

## Phase 3: User Story 1 — On-Demand PTT Voice Query (Priority: P1) 🎯 MVP

**Goal**: Driver holds PTT, asks "Do we pit this lap?", hears a race-state-aware synthesized answer within 5 s of release.

**Independent Test**: quickstart.md Scenario 1 (and Scenario 2 for the empty-capture guard).

### Implementation

- [ ] T032 [US1] Implement `apps/tauri-client/src-tauri/src/stt/whisper.rs` (+ `stt/mod.rs`, register in `lib.rs`) — load `ggml-base.en.bin` once; `transcribe(samples: Vec<f32>, sample_rate: u32) -> Result<String>` via `whisper-rs` (metal/vulkan).
- [ ] T033 [US1] Extend `apps/tauri-client/src-tauri/src/audio/capture.rs` — PTT-gated buffered capture: accumulate mono f32 samples (resample if needed via existing `resampler.rs`) while PTT is held, flush the buffer on release for transcription.
- [ ] T034 [US1] Extend `apps/tauri-client/src-tauri/src/hotkeys/ptt.rs` — on `PttPressed` start capture; on `PttReleased` stop → `whisper::transcribe` → if transcript is empty/whitespace/non-speech, **do not publish**, emit `{ reason: "empty-transcription" }` log (FR-004); on STT error emit `{ reason: "stt-failure" }` (FR-005). Use the Tauri **global-shortcut plugin** (registered in T007) to bind PTT as a **global (unfocused) OS shortcut** so it works while the sim is focused; verify the OS accessibility permission is granted (fail with a clear settings log if denied). Stream Deck maps a key handled by the same global path — no bespoke integration (FR-003, research R12).
- [ ] T035 [US1] Implement `apps/tauri-client/src-tauri/src/engineer/query_publisher.rs` — publish `EngineerQuery` JSON `{ queryId, transcript, sessionId, capturedAtMs }` to the `engineer:query` Redis pub/sub channel (reuse `redis/pubsub.rs`), per `contracts/engineer-query-channel.md`.
- [ ] T036 [P] [US1] `cargo test` in `apps/tauri-client/src-tauri/` — capture accumulates only while held; empty/non-speech transcript produces no publish (guard); STT failure does not panic.
- [ ] T037 [US1] Create `apps/hub-server/prompts/tier3-driver-query.md` (header + task framing) — instruct the engineer to answer the driver's question using tools for any fuel/tire figures; concise, spoken.
- [ ] T038 [US1] Extend `apps/hub-server/src/engineer/racing-engineer.ts` — subscribe to `engineer:query`; enforce single in-flight query + FIFO `queueDepthCap` (overflow drop + `queue-cap-drop` log, Q4); dispatch each query to `tier3-synthesizer` with `type: 'driver-query'`.
- [ ] T039 [P] [US1] Integration test in `apps/hub-server/tests/integration/driver-query.test.ts` — publish an `EngineerQuery` ("Do we pit this lap?") → assert a `voice:audio` answer is produced, the fuel/tire tools were called, and spoken figures match the tool results (SC-002); assert queue-cap-drop on overflow.
- [ ] T040 [P] [US1] Eval in `apps/hub-server/tests/eval/tool-calling.eval.ts` — fuel/tire questions reliably trigger the corresponding tool and never fabricate figures across a representative prompt set (Constitution VI).
- [ ] T041 [US1] Whisper model provisioning — bundle or first-run-download `ggml-base.en.bin` for the Tauri client (mirror `pocs/0002` `fixtures/models/download.sh`); document in the client README.

**Checkpoint**: Full PTT → STT → LLM(+tools) → TTS → playback loop works; empty captures produce no answer. MVP demoable (Scenarios 1–2).

---

## Phase 4: User Story 7 — Graceful Degradation (Priority: P1)

**Goal**: LLM unreachable ⇒ Tier 3 skipped, Tier 1/2 unaffected; PTT during outage ⇒ brief canned line; auto-recovery.

**Independent Test**: quickstart.md Scenario 8.

**Depends on**: Foundational + US1 (driver-query path for the canned-line case).

- [ ] T042 [US7] Verify/harden the `llm-client.ts` reachability/timeout contract already implemented in T025 (do not re-implement): add explicit tests/guards that failures return `unreachable`/`timedOut` and never throw into the rule path, and that the rule engine and `hub:events` handler never `await` the LLM (Constitution I). Extends T044's isolation check.
- [ ] T043 [US7] Extend `tier3-synthesizer.ts` degradation branch: on `unreachable`/`timedOut` write `EngineerEvent.outcome = skipped-llm-unreachable` + `llm-unreachable` log; **driver-query** ⇒ synthesize a canned "Reasoning engine unavailable" clip via `TtsClient` (no LLM); **proactive** types ⇒ silent skip (log only); recovery is automatic on the next attempt (FR-023/024, Q5).
- [ ] T044 [US7] Add/verify an isolation guard: a code path/test asserting Tier 1/2 dispatch is on a separate async path from Tier 3 synthesis (no shared awaited promise).
- [ ] T045 [P] [US7] Integration test in `apps/hub-server/tests/integration/degradation.test.ts` — with the LLM boundary forced unreachable: Tier 1/2 alerts still delivered (SC-003), every Tier 3 trigger skipped with a log, a driver-query yields the canned line without hanging past `timeoutMs`, `engineer_events` row `outcome=skipped-llm-unreachable`; restoring the LLM resumes synthesis with no restart.

**Checkpoint**: Reliability guarantee verified (Scenario 8).

---

## Phase 5: User Story 2 — Proactive Tier 3 Briefings (Priority: P2)

**Goal**: Pit-entry, safety-car, and post-sector briefings are synthesized at the right moments.

**Independent Test**: quickstart.md Scenario 3.

- [ ] T046 [P] [US2] Create `apps/hub-server/prompts/tier3-pit-entry.md` (header + framing: what to expect this stop, given strategy).
- [ ] T047 [P] [US2] Create `apps/hub-server/prompts/tier3-safety-car.md` (header + framing: implications for position/strategy).
- [ ] T048 [P] [US2] Create `apps/hub-server/prompts/tier3-post-sector.md` (header + framing: short commentary).
- [ ] T049 [US2] Extend `racing-engineer.ts` triggers on `hub:events`: `hero:pit_entry` → synthesize `pit-entry`; `session:safety_car_deployed` → keep the immediate M4 Tier 1 alert AND additively synthesize `safety-car` (FR-016); `hero:lap_complete` (from T002) → synthesize `post-sector` gated by `postSectorMinLapGap` (laps) and suppressed at Energy=1.
- [ ] T050 [P] [US2] Integration tests in `apps/hub-server/tests/integration/proactive-briefings.test.ts` — pit-entry event → `voice:audio`; safety-car → Tier 1 alert dispatched before the Tier 3 briefing; Energy=1 suppresses post-sector; no in-progress clip interrupted.

**Checkpoint**: Proactive briefings work (Scenario 3).

---

## Phase 6: User Story 3 — Personality Shapes the Voice (Priority: P2)

**Goal**: All five OCEAN traits (1–5) measurably shape output; driver configures them in the UI.

**Independent Test**: quickstart.md Scenario 4.

- [ ] T051 [US3] Complete `apps/hub-server/prompts/personality.md` — full 1–5 word-anchored instruction fragments for all five traits per `contracts/personality-prompt.md`; ensure `tier3-synthesizer` composes all five into every system prompt (FR-017).
- [ ] T052 [P] [US3] Implement `packages/ui/src/components/PersonalityPanel/index.tsx` — five 1–5 sliders with word labels per level; presentation-only (no business logic, Constitution II).
- [ ] T053 [US3] Add `PersonalityPanel` to `apps/tauri-client/src/pages/Setup.tsx`; wire save to write `PersonalityConfig` to Redis `hub:config:personality` via the existing config-save path (and `AppConfig` from T008).
- [ ] T054 [P] [US3] Eval in `apps/hub-server/tests/eval/personality.eval.ts` — for each trait, hold the other four + race state constant, vary 1→5, assert output moves in the intended direction (SC-005, Constitution VI).

**Checkpoint**: Personality is configurable and behaviorally active (Scenario 4).

---

## Phase 7: User Story 4 — Driver Override Tracking (Priority: P2)

**Goal**: A pit recommendation overridden (recommended lap completed without a pit entry) is detected; the engineer stops repeating it and pivots to the driver's decision.

**Independent Test**: quickstart.md Scenario 5.

- [ ] T055 [US4] Implement `apps/hub-server/src/engineer/override-tracker.ts` — watch `hub:events`; a pit `RecommendationLogEntry` transitions `pending→overridden` when the car completes the recommended lap (start/finish crossing) without a pit entry, `pending→followed` on a pit entry within the window (FR-019, Q2); persist outcomes into `session-memory`.
- [ ] T056 [US4] Extend `tier3-synthesizer.ts`/`racing-engineer.ts` — record a `RecommendationLogEntry` when the engineer emits a pit recommendation; after `overridden`, suppress re-issuing that type within the window context and frame subsequent related speech around the driver's decision (FR-019).
- [ ] T057 [P] [US4] Unit tests in `apps/hub-server/tests/unit/engineer/override-tracker.test.ts` — S/F crossing without pit entry → overridden; pit entry within window → followed; state transitions match data-model.
- [ ] T058 [P] [US4] Integration test in `apps/hub-server/tests/integration/override.test.ts` — after an override, the same pit recommendation is not re-issued within the window (SC-006); later speech reflects staying out.

**Checkpoint**: Override detection + no-repeat works (Scenario 5).

---

## Phase 8: User Story 5 — Adaptive Deference (Priority: P3)

**Goal**: After `deferenceThreshold` (default 2) overrides of a recommendation type in a session, the engineer shifts that type to information mode; direct PTT requests still get direct answers; resets per session.

**Independent Test**: quickstart.md Scenario 6.

**Depends on**: US4 (override outcomes feed deference counts).

- [ ] T059 [US5] Extend `session-memory.ts` `DeferenceState` — per-type `overrideCountByType`; when a type reaches `deferenceThreshold`, add it to `deferredTypes`; `reset()` clears deference on new session (FR-021, Q3).
- [ ] T060 [US5] Extend `tier3-synthesizer.ts` deference check (stubbed in T029) — for a `deferredType`, synthesize in **information mode** (no directive; use a prompt variant) UNLESS the request is a `driver-query` (direct ask still gets a recommendation).
- [ ] T061 [P] [US5] Tests in `apps/hub-server/tests/integration/deference.test.ts` — reaching the threshold shifts unsolicited output to information mode; a direct PTT "should I pit?" still returns a recommendation; a new session resets to recommendation mode (SC-007).

**Checkpoint**: Adaptive deference works per type (Scenario 6).

---

## Phase 9: User Story 6 — Session Memory Informs Reasoning (Priority: P3)

**Goal**: The engineer's answers reflect this session's recommendation log, override outcomes, and fuel-calibration updates.

**Independent Test**: quickstart.md Scenario 7.

- [ ] T062 [US6] Extend `session-memory.ts` — capture the latest M3 fuel-calibration snapshot (from the `hub:fuel-model:${sessionId}` KV / model) and surface the recommendation log + override outcomes as a memory excerpt.
- [ ] T063 [US6] Ensure `context-assembler.ts` includes the memory excerpt in `ReasoningContext` for driver-query and briefings (within the token budget; truncation from T022 applies).
- [ ] T064 [P] [US6] Integration test in `apps/hub-server/tests/integration/session-memory.test.ts` — a recommendation made earlier is referenced in a later PTT answer (consistent with the log); forcing over-budget context emits `context-truncated` and stays within the ceiling (SC-009).

**Checkpoint**: Memory-informed reasoning works (Scenario 7).

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T065 [P] Run all quickstart.md scenarios (1–8) end-to-end against local infra.
- [ ] T066 Deploy test (SC-010): live/simulated stint — ask "Do we pit this lap?" and hear a briefing < 5 s; override a pit recommendation and confirm it is not repeated.
- [ ] T067 [P] Update hub docs (`apps/hub-server/src/docs/data-model.mdx` and/or a new contracts page) to cover `engineer_events`, the Tier 3 pipeline, and `engineer:query`; note whisper model provisioning.
- [ ] T068 Workspace gates: `npm test` (hub) + `cargo test` (tauri) + `npm run build && npm run typecheck` + ESLint/Prettier + rustfmt/clippy — all green.
- [ ] T069 [P] Confirm all agent evals green (tool-calling T040, personality T054) and add any missing override-framing eval.
- [ ] T070 Governance: verify implementation aligns with constitution **v1.2.0** — the Tier 3 ≤5 s latency budget (Principle I) and in-client `whisper-rs` STT (Technology Constraints) were ratified 2026-07-02; confirm no further drift before merge.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)** → no deps.
- **Foundational (P2)** → depends on Setup; **blocks all user stories**.
- **US1 (P3 phase)** → depends on Foundational.
- **US7** → depends on Foundational + US1 (canned-line path).
- **US2** → depends on Foundational.
- **US3** → depends on Foundational (+ US1/US2 to have output to shape, but independently testable via any trigger).
- **US4** → depends on Foundational.
- **US5** → depends on **US4** (override counts).
- **US6** → depends on Foundational (+ US4 to have a richer log to surface, but testable with any logged recommendation).
- **Polish** → depends on all targeted stories.

### Within each story

- Tests/evals are authored alongside implementation and must pass at the checkpoint.
- Models/types (Setup) → shared engine (Foundational) → story handlers → integration/eval.

### Parallel opportunities

- Setup: T005, T006, T007, T009 in parallel (different files); T002 parallel with config tasks.
- Foundational: T014/T015 (prompts), T018/T020 (tools/splitter), and their tests (T017/T019/T021/T023/T026/T028) are largely parallel — but T022 (context) needs T024 (memory scaffold), T029 (synthesizer) needs T016/T018/T020/T022/T025/T027, and T031 needs everything.
- US1: T036 (cargo) ∥ T039/T040 (hub). US2: T046/T047/T048 prompts in parallel. Polish: T065/T067/T069 in parallel.
- Once Foundational completes, US1/US2/US3/US4/US6 can proceed in parallel (US5 after US4, US7 after US1).

---

## Parallel Example: Foundational prompt + pure-logic tasks

```bash
Task: "Create prompts/system-base.md"                     # T014
Task: "Create prompts/personality.md scaffold"            # T015
Task: "Implement engineer/tools.ts"                       # T018
Task: "Implement engineer/sentence-splitter.ts"           # T020
# then their tests in parallel: T017, T019, T021, T023, T026, T028
```

## Parallel Example: User Story 1

```bash
Task: "cargo test capture + empty-transcript guard"       # T036
Task: "Integration test engineer:query → voice:audio"     # T039
Task: "Eval tool-calling correctness"                     # T040
```

---

## Implementation Strategy

### MVP first (US1)

1. Phase 1 Setup → 2. Phase 2 Foundational (the big blocking phase) → 3. Phase 3 US1 → **STOP & VALIDATE** Scenarios 1–2 → demo the voice loop.

### Incremental delivery

Foundational → US1 (MVP) → US7 (reliability) → US2 (proactive) → US3 (personality) → US4 (override) → US5 (deference) → US6 (memory) → Polish. Each story is an independently testable increment.

### Notes

- [P] = different files, no incomplete-task dependencies.
- Constitution VI is non-negotiable: prompt/personality changes require **evals** (T040, T054, T069), not unit tests alone.
- Every LLM interaction writes an `engineer_events` row before acting (SC-008) — verify in each integration test.
- Commit after each task or logical group; stop at any checkpoint to validate a story independently.
- Ratify the two constitution deviations (T070) before merging to `main`.
