# Tasks: Tier 2 Alert Completion — Competitor Pit, Gap, and Pace Alerts (+ Weather Telemetry Passthrough)

**Input**: Design documents from `/specs/007-tier2-alert-completion/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/alert-rules.md, quickstart.md

**Tests**: INCLUDED — Constitution VI makes test-first REQUIRED for agent decision paths (all five rules are decision paths). Every test task is written first and must FAIL before its implementation task. The weather passthrough (US4) is not a decision path, but its mapping tests follow the same write-first convention for consistency.

**Organization**: Grouped by user story. US1/US2/US3 are independent of each other once Phase 2 (Foundational) is done; US1 and US3 both edit `alert-rules.ts`, so run them sequentially or rebase carefully. US4 (weather — scope addition 2026-07-10, spec.md US4 / FR-015–FR-016 / SC-007, design in plan.md §Weather) is independent of Phase 2 entirely: it touches none of the engineer/alert files and can start any time after Phase 1.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 = competitor pit awareness, US2 = battle proximity, US3 = pace degradation, US4 = weather telemetry passthrough (stream overlay)

## Path Conventions

Monorepo per plan.md: `packages/types/src/`, `apps/hub-server/src/engineer/`, `apps/hub-server/tests/unit/engineer/`, `apps/hub-server/config/`. US4 adds: `apps/tauri-client/src-tauri/src/telemetry/`, `apps/hub-server/src/pipeline/`, `apps/hub-server/src/state/`, `apps/hub-server/tests/unit/pipeline/`.

---

## Phase 1: Setup

- [x] T001 Create feature branch `007-tier2-alert-completion` from `main`; its first commit is the 007 design artifacts currently uncommitted on `main` (`specs/007-tier2-alert-completion/`, constitution v1.2.3, the `CLAUDE.md` plan pointer, `.specify/feature.json`) — done: commit `ca68be3`, 2026-07-13

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: config surface, scoped dedup, and the `evaluateTier2` signature change that every story builds on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete — **except US4 (weather)**, which does not depend on this phase.

- [x] T002 [P] Add `relevantPositionRange: number` and `gapHysteresisMarginSeconds: number` to `EngineerConfig` in `packages/types/src/engineer.ts`; update the `gapThresholdSeconds` comment (no longer an unused M4 placeholder — consumed by the gap monitor from 007). Spec-qualify FR references in code comments while there: the existing comment's bare "FR-015" is spec 004's namespace (007's FR-015 is weather) — write them as "004 FR-015" / "consumed per 007 FR-004/FR-006" so cross-spec FR numbers can't collide
- [x] T003 [P] Add defaults `"relevantPositionRange": 3` and `"gapHysteresisMarginSeconds": 0.5` to `apps/hub-server/config/engineer-config.json`
- [x] T004 Harden `loadEngineerConfig` in `apps/hub-server/src/engineer/personality-config.ts`: default the two new fields when absent (FR-011 — untouched configs keep working); throw a descriptive error naming the field when present but invalid (`relevantPositionRange` not an integer ≥ 1; `gapHysteresisMarginSeconds` not finite > 0) — manual guide TC-21 expects fail-fast (depends: T002, T003)
- [x] T005 [P] Write FAILING tests for scoped dedup in `apps/hub-server/tests/unit/engineer/dedup-tracker.test.ts`: scoped keys independent per car/level; `recordCleared(type, scope)` removes only that key; `recordCleared(type)` removes all keys of the type incl. scoped; existing unscoped behavior unchanged (regression)
- [x] T006 Implement the scope dimension in `apps/hub-server/src/engineer/dedup-tracker.ts`: `dedupKeyFor(eventType, lapNumber, scope?)` (scoped-event-cleared strategy set per data-model.md), optional `scope` on `shouldFire`/`recordFired`/`recordCleared`; T005 tests go green (depends: T005)
- [x] T007 Change `evaluateTier2` signature to `(event, state: RaceState, config)` in `apps/hub-server/src/engineer/alert-rules.ts` (`signals` read as `state.signals`); update the call site in `apps/hub-server/src/engineer/racing-engineer.ts`, the existing tests in `apps/hub-server/tests/unit/engineer/alert-rules.test.ts`, and whichever behavior-named service suites break (`degradation.test.ts`, `proactive-briefings.test.ts`, `driver-query.test.ts`, `override.test.ts` — there is NO `racing-engineer.test.ts` yet; T010 creates it) — pure refactor, full existing suite stays green (depends: T002)

**Checkpoint**: Foundation ready — config fields exist, dedup supports scopes, rules can see RaceState. All existing M4/M5 tests green.

---

## Phase 3: User Story 1 — Competitor Pit Stop Awareness (Priority: P1) 🎯 MVP

**Goal**: Announce pit entry/exit for same-class cars within ±`relevantPositionRange` of the hero, once per visit, with burst coalescing (T2-02/T2-03, FR-001–003, FR-014).

**Independent Test**: manual guide TC-07 (identity skip, synthetic on Mac) and TC-09–TC-12 (live AI race); unit suites for relevance, coalescing, and clear-signal wiring pass on their own with US2/US3 untouched.

### Tests for User Story 1 (write first — must FAIL)

- [x] T008 [P] [US1] Write FAILING tests in `apps/hub-server/tests/unit/engineer/alert-rules.test.ts`: in-window competitor pit entry/exit fire with EXACT contract templates (`Car {n} pitting from P{pos}` / `Car {n} out of pits, P{pos}`); out-of-window → null + `alert_skipped {reason:'relevance'}`; different `carClassId` → skipped; degenerate class data (`carClassId ≤ 0` or `classPosition ≤ 0`) falls back to overall position; missing `state.field[carIdx]` or empty `carNumber` → null + `alert_skipped {reason:'identity-unresolved'}`; null `state.hero` (pre-session) → null + `alert_skipped {reason:'no-hero'}`; scoped dedup keys `competitor:pit_entry:{carIdx}` populated on the alert
- [x] T009 [P] [US1] Write FAILING tests in `apps/hub-server/tests/unit/engineer/message-queue.test.ts`: two queued `competitor:pit_entry` alerts dequeue as ONE with template `Cars {a} and {b} are pitting`; three+ use `{count} cars around you are pitting`; exits use their own templates; entries NEVER merge with exits; a Tier 1 alert queued alongside coalescible Tier 2 pit alerts dequeues FIRST and is never merged (FR-009 preemption survives coalescing); single alert passes through unchanged; merged alert counts as one dequeued item, with each alert's own `enqueuedAt` governing the 30s no-safe-window drop until the merge (a timed-out alert drops individually and is NOT resurrected by a later merge); `alerts_coalesced {eventType, mergedCount, carNumbers}` logged; ordering vs. personality suppression per contract §Coalescing contract (FR-014) item 5 — a merged alert subsequently Energy=1-suppressed logs `alerts_coalesced` then ONE `alert_suppressed` (the dispatcher-side half of this assertion may live in T010's service suite)
- [x] T010 [P] [US1] Write FAILING tests in NEW `apps/hub-server/tests/unit/engineer/racing-engineer.test.ts` (service-wiring suite — does not exist yet; model its harness on the existing behavior-named suites): `competitor:pit_exit` for car C clears `competitor:pit_entry:C` AND still evaluates as a T2-03 candidate (dual role — no early return); `competitor:pit_entry` clears `competitor:pit_exit:C`; second visit by the same car re-announces (per-visit re-arm)

### Implementation for User Story 1

- [x] T011 [US1] Implement T2-02/T2-03 in `apps/hub-server/src/engineer/alert-rules.ts`: relevance helper (class test + degenerate-data fallback per contract §Relevance window (T2-02/03)), identity resolution from `state.field`, contract templates, scoped dedup keys, structured `alert_skipped` logging (module may import `logger`) — T008 green (depends: T006, T007, T008)
- [x] T012 [US1] Wire per-car clear signals in `apps/hub-server/src/engineer/racing-engineer.ts` `onEvent`: competitor pit entry/exit clear each other's scoped key for that carIdx and continue into rule evaluation (do NOT early-return like the M4 hero clear signals); pass scoped args to `shouldFire`/`recordFired` — T010 green (depends: T010, T011)
- [x] T013 [US1] Implement dequeue-time coalescing in `apps/hub-server/src/engineer/message-queue.ts` `dequeueNext` per contract §Coalescing contract (FR-014) (same-eventType Tier 2 merge, coalesced templates, head supplies lapNumber/sessionTime, `alerts_coalesced` log; note the queue holds the `QueuedMessage` union — type-narrow to `QueuedAlert` before merging) — T009 green (depends: T009)

**Checkpoint**: US1 fully functional — synthetic TC-07 and live TC-09–TC-12 runnable; MVP deliverable.

---

## Phase 4: User Story 2 — Battle Proximity Awareness (Priority: P2)

**Goal**: Hero-scoped gap alerts with the threshold/dead-band hysteresis machine, direction-aware wording, and caution/pit-road suppression (T2-04/T2-05, FR-004–007).

**Independent Test**: `gap-alert-monitor.test.ts` suite passes standalone; live TC-13–TC-17. No dependency on US1/US3 code.

### Tests for User Story 2 (write first — must FAIL)

- [x] T014 [P] [US2] Write FAILING tests in NEW `apps/hub-server/tests/unit/engineer/gap-alert-monitor.test.ts`: crossing below T fires closing (both direction wordings, exact contract templates, gap to 1dp); **fresh slot starts disarmed — a gap already < T at first observation (green flag / post-overtake reset) fires nothing until first observed ≥ T (FR-004)**; widening fires only above T+M and only after a prior closing fire (initial wide gap stays silent; **an initial gap < T that widens past T+M without a closing fire also stays silent — FR-005**); dead-band oscillation (T…T+M) fires nothing; opposite-boundary re-arm permits a second closing alert; adjacency change (different carIdx) resets slot to disarmed; **cross-class adjacent car is skipped (slot reset, no evaluation, no per-tick log; degenerate class data falls back to evaluating — FR-007)**; null `RaceState.hero` resets both slots silently (standing non-battle condition); invalid gap (≤ 0, non-finite, or lapped-scale per data-model.md: g > 0.8 × `hero.estimatedLapTime`, 72s fallback) resets silently; during caution / hero-on-pit-road / adjacent-on-pit-road, evaluation CONTINUES but a would-fire crossing logs `gap_alert_suppressed {direction, reason}` (both fields, per contract §Structured logging contract (FR-012)) instead of enqueueing (same arm/disarm transitions as a fire — a gap compressing below T mid-caution MUST produce the log, per US2-AC7; never per tick), and the slot resets to disarmed when the suppression condition clears (no alert burst at the restart); enqueued alerts carry eventType `gap:closing`/`gap:pulling_away`, tier 2, `lapNumber` from `hero.lapCompleted`

### Implementation for User Story 2

- [x] T015 [US2] Implement NEW `apps/hub-server/src/engineer/gap-alert-monitor.ts`: `DirectionState` machine per data-model.md §GapAlertMonitor (ahead/behind slots, disarmed-at-init arming rule, arm/disarm transitions, same-class check with degenerate-data fallback, resets, suppression via continued hypothetical evaluation — would-fire crossings log instead of enqueue, slot resets to disarmed when the condition clears); reads `RaceState` (position-adjacent cars via `gapToLeader` deltas); emits `QueuedAlert`s through an injected enqueue callback (testable without Redis) — T014 green (depends: T004, T014)
- [x] T016 [US2] Wire the monitor into `apps/hub-server/src/engineer/racing-engineer.ts`: instantiate with config + `getRaceState`, invoke from `dispatchTick` before dequeue, route fired alerts through the existing enqueue/logging path; REMOVE the `gap:closing`/`gap:pulling_away` stub cases from `evaluateTier2` in `alert-rules.ts` with a pointer comment (monitor owns these types — contract §Compatibility notes) (depends: T015)
- [x] T017 [US2] Extend `apps/hub-server/tests/unit/engineer/racing-engineer.test.ts` (created in T010; create it here if US2 runs first): monitor is invoked on the dispatch tick and a fired gap alert flows through the TTS dispatch path (fake clip generator, as existing suites do); include a hub-side latency bound — an eligible Tier 2 alert is picked up within one dispatch tick (100ms cadence) of enqueue, with fake-clip-generator timestamps asserting the enqueue→publish path completes promptly, partially backing SC-002 ahead of the deferred live run; also cover the stale-trigger edge case — a gap alert held through a blackout zone delivers at the next safe window carrying its trigger-time gap value (depends: T016)

**Checkpoint**: US1 and US2 both independently functional.

---

## Phase 5: User Story 3 — Tire Pace Degradation Warning (Priority: P3)

**Goal**: Once-per-level-per-stint pace alerts from `hero:pace_degradation` transitions, re-armed at pit exit (T2-06, FR-008).

**Independent Test**: synthetic manual TC-03–TC-06 (fully testable on Mac, no iRacing); unit tests pass with US1/US2 untouched.

### Tests for User Story 3 (write first — must FAIL)

- [ ] T018 [P] [US3] Write FAILING tests in `apps/hub-server/tests/unit/engineer/alert-rules.test.ts`: `signal:'watch'` fires `Pace dropping — tires starting to go off` with dedup key `hero:pace_degradation:watch`; `signal:'critical'` with `trend: 2.34` fires `Pace critical — tires are done, 2.3 seconds off your early pace` (trend to 1dp — the value is rolling-window pace loss, not delta-to-best, hence the wording); unknown/nominal signal → null + `alert_skipped {reason:'invalid-signal'}` (defensive branch, per contract)
- [ ] T019 [P] [US3] Write FAILING test in `apps/hub-server/tests/unit/engineer/racing-engineer.test.ts` (created in T010; create it here if US3 runs first): repeat watch event deduplicated (`alert_deduplicated`); `hero:pit_exit` clears BOTH pace scopes alongside its existing pit-window clear, so a post-pit watch event fires again

### Implementation for User Story 3

- [ ] T020 [US3] Implement T2-06 in `apps/hub-server/src/engineer/alert-rules.ts`: consume `hero:pace_degradation` payload `{signal, trend}` (already transition-gated upstream — research.md R5), level-scoped dedup key, contract templates — T018 green (depends: T006, T007, T018; sequential with T011 — same file)
- [ ] T021 [US3] Add pace-scope clearing to the `hero:pit_exit` case in `apps/hub-server/src/engineer/racing-engineer.ts` (`recordCleared('hero:pace_degradation')`, all scopes) and scoped `shouldFire`/`recordFired` on the pace path — T019 green (depends: T019, T020)

**Checkpoint**: All three stories independently functional.

---

## Phase 6: User Story 4 — Live Weather for the Stream Overlay (Priority: P4)

**Goal**: Populate the placeholder `session.weather` with live sim weather so the `weather.html` OBS overlay can poll `GET /api/race-state` (CORS already enabled) — needed for an upcoming live stream (FR-015, FR-016, SC-007; design in plan.md §Weather telemetry passthrough). Straight passthrough: collector field set → session stream → pipeline mapping → existing KV snapshot. No new endpoints, no alerts, no forecast (plan §Weather non-goals).

**Independent Test**: unit suite for the mapping passes standalone; end-to-end, `curl http://<hub>/api/race-state | jq .session.weather` shows live values during any session (works in observer mode — weather vars are global, not hero-gated). Zero overlap with US1–US3 files; can run any time after Phase 1, before or in parallel with Phase 2.

### Tests for User Story 4 (write first — must FAIL)

- [ ] T022 [P] [US4] Write FAILING tests in `apps/hub-server/tests/unit/pipeline/session-processor.test.ts`: incoming weather fields map into `session.weather` via `updateWeather()` (visible in `getSnapshot()` and in the KV snapshot write); `Skies` 0–3 maps to `'Clear' | 'PartlyCloudy' | 'MostlyCloudy' | 'Overcast'` (out-of-range value falls back to `'Clear'`); a telemetry frame with weather fields ABSENT (older collector build) leaves the previous weather value untouched — never regresses to the placeholder — and the guard is PER FIELD (FR-016): a partial frame (e.g., `airTemp` present, `fogLevel` absent) updates only the fields it carries and preserves each absent one; unit passthroughs are 1:1 (`AirTemp`→`tempCelsius`, `TrackTempCrew`→`trackTempCelsius`, `RelativeHumidity`→`humidity`, `WindVel`→`windSpeedMs`, `WindDir`→`windDirRad`, `Precipitation`→`precipitation`, `FogLevel`→`fogLevel`)

### Implementation for User Story 4

- [ ] T023 [P] [US4] Extend `WeatherState` in `packages/types/src/race-state.ts`: add `trackTempCelsius`, `windDirRad`, `precipitation`, `fogLevel`; change `skies` from `string` to the typed union `'Clear' | 'PartlyCloudy' | 'MostlyCloudy' | 'Overcast'`. Doc-comment units/range/convention on EVERY field of the interface — the overlay consumer is out-of-repo, so these comments are its only unit contract: `tempCelsius` = AIR temp °C, `trackTempCelsius` °C, `humidity` 0–1 relative, `windSpeedMs` m/s, `windDirRad` radians (mark the from/to convention as sourced from the iRacing SDK, to be confirmed in T025's `enumerate_vars()` Windows check), `precipitation` 0–1, `fogLevel` 0–1 (existing fields keep their meaning per plan §Weather item 2)
- [ ] T024 [P] [US4] Extend `SessionTelemetryData` in `packages/types/src/telemetry.ts` with the raw optional weather fields (`airTemp`, `trackTempCrew`, `relativeHumidity`, `windVel`, `windDir`, `skies` (0–3), `precipitation`, `fogLevel`) — placed with the shared (non-hero-gated) fields and commented as global sim vars present in BOTH driver and observer mode
- [ ] T025 [P] [US4] Add the eight vars to `SESSION_RATE_FIELDS` in `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` (`AirTemp`, `TrackTempCrew`, `RelativeHumidity`, `WindVel`, `WindDir`, `Skies`, `Precipitation`, `FogLevel`) under a `// Weather` comment group; extend the existing field-name assertion tests in the same file (the `SESSION_RATE_FIELDS.contains(...)` pattern) — field names MUST be verified against `sdk.enumerate_vars()` capitalization per the existing test's warning, flagged for the next Windows session if not verifiable on Mac. During that Windows check, also confirm `WindDir`'s directional convention (wind-FROM vs wind-TO): `enumerate_vars()` verifies names/types only, so read the SDK variable's description string and cross-check against the in-sim weather display (wind arrow / readout) in the same session; record the confirmed convention in T023's `windDirRad` doc comment
- [ ] T026 [US4] Add `updateWeather(weather: WeatherState): void` mutator to `apps/hub-server/src/state/race-state.ts` beside the existing mutators (depends: T023)
- [ ] T027 [US4] Map incoming weather fields → `updateWeather()` in `apps/hub-server/src/pipeline/session-processor.ts` each session-telemetry cycle, BEFORE the existing `writeKvSnapshot` call (plan §Weather item 3): skies enum → union mapping, absent-field no-regress guard applied PER FIELD (FR-016 — each field updates independently; a partial frame touches only what it carries) — T022 green (depends: T022, T024, T026)
- [ ] T028 [P] [US4] Document the eight new fields on the `iracing:telemetry:session` stream in `apps/hub-server/src/docs/contracts/redis-streams.mdx` (Constitution II — the collector→hub boundary is the stream contract; plan §Constitution Check row II)
- [ ] T029 [US4] Add a weather test case section to `specs/007-tier2-alert-completion/manual-testing-guide.md`: Mac-side — hub unit suite + a synthetic session-telemetry frame with weather fields shows them in `curl /api/race-state | jq .session.weather`, AND `weather.html` opened directly via `file://` fetches `/api/race-state` without CORS errors (covers SC-007's `file://` case; testable on Mac against a synthetic frame); Windows/live-side (deferred like TC-09+) — observer session at a wet/overcast track shows non-placeholder values, and `weather.html` polling from OBS on `http://10.0.0.9` renders without CORS errors (depends: T027)

**Checkpoint**: Live weather flowing end to end — stream-overlay ready. Deliverable independently of US1–US3.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T030 [P] Add a supersession note to `specs/004-rule-based-alerts-voice/contracts/alert-rules.md`: T2-02…T2-06 reference rows superseded by `specs/007-tier2-alert-completion/contracts/alert-rules.md`; while there, re-read `ROADMAP.md`'s M4 Tier 2 description and confirm it is accurate with this feature merged (SC-006 — no stubbed rules remaining), correcting the wording if it drifted
- [ ] T031 [P] File a follow-up GitHub issue for the gap-model `gap:pulling_away` emission bug (re-fires every tick; triggers on *closing* rate — `apps/hub-server/src/models/gap-model.ts:114-118`), citing research.md R1; fix is deliberately out of 007's scope
- [ ] T032 Re-verify the synthetic payloads in `specs/007-tier2-alert-completion/manual-testing-guide.md` (Sections 2 & 5) against the implemented event handling; correct any drift in field names or clear-signal behavior. Also confirm the guide's grep commands can't conflate monitor-produced `gap:closing`/`gap:pulling_away` ALERT logs with the same-named BUS EVENTS still flowing from the gap model (different semantics — contract §Compatibility notes); add a disambiguating note to the guide if needed
- [ ] T033 Workspace gates (Constitution VI): `npm test -w apps/hub-server`, `npm run typecheck`, `npm run build`, ESLint/Prettier — all green, zero regressions in the M4/M5 engineer suites. US4 additionally requires the full Rust gate in `apps/tauri-client/src-tauri`: `cargo test`, `cargo clippy`, `cargo fmt --check` (Principle VI names all three — test alone is not the gate). If the collector target cannot build on Mac, the Windows run is a HARD PR exit criterion on BOTH paths (normal and fast) — record it in the 007 PR description like T034's linked-issue pattern; the PR does not merge without it
- [ ] T034 Execute manual-testing-guide.md Mac sections (TC-01–TC-08, TC-19–TC-22, and the US4 weather Mac case from T029) and record results in its Result Log; file a follow-up issue (sibling to T031's) tracking the deferred Section 3 live run (TC-09–TC-18, plus the US4 live weather check) to closure — it carries SC-002's 3-second latency validation and MUST be linked in the 007 PR description as a stated exit criterion for the milestone

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none
- **Foundational (Phase 2)**: after T001 — BLOCKS US1/US2/US3 (NOT US4). Internal: T004 ← (T002, T003); T006 ← T005; T007 ← T002
- **US1 (Phase 3)**: after Phase 2
- **US2 (Phase 4)**: after Phase 2 — independent of US1 except T016 touches `racing-engineer.ts`/`alert-rules.ts` (rebase if US1 in flight)
- **US3 (Phase 5)**: after Phase 2 — same-file caution with US1 (`alert-rules.ts`, `racing-engineer.ts`): run after US1 or coordinate
- **US4 (Phase 6)**: after Phase 1 ONLY — no dependency on Phase 2 or any other story; zero file overlap with US1–US3. Internal: T026 ← T023; T027 ← (T022, T024, T026); T029 ← T027. May be pulled ahead of everything else for the live-stream deadline
- **Polish (Phase 7)**: after all desired stories

### Within Each Story

Tests (FAIL first) → rule/module implementation → service wiring. Story complete before the next priority.

### Parallel Opportunities

- Phase 2: T002 ∥ T003 ∥ T005 (three files)
- US1 test authoring: T008 ∥ T009 ∥ T010 (three test files); then T011 → T012, with T013 ∥ T011 (different files)
- T014 (US2 tests) can be written in parallel with ALL of US1 (new file)
- US4: T022 ∥ T023 ∥ T024 ∥ T025 (four files, no interdependencies); T028 any time; the whole phase runs in parallel with Phases 2–5 (zero file overlap)
- Polish: T030 ∥ T031

### Parallel Example: User Story 1

```bash
# Author all three failing test suites together:
Task: "T008 relevance/identity/template tests in tests/unit/engineer/alert-rules.test.ts"
Task: "T009 coalescing tests in tests/unit/engineer/message-queue.test.ts"
Task: "T010 clear-signal wiring tests in tests/unit/engineer/racing-engineer.test.ts"
# Then implement: T011 (alert-rules) and T013 (message-queue) in parallel, T012 last.
```

### Parallel Example: User Story 4 (weather)

```bash
# All four opening tasks touch different files:
Task: "T022 mapping tests in tests/unit/pipeline/session-processor.test.ts"
Task: "T023 WeatherState extension in packages/types/src/race-state.ts"
Task: "T024 SessionTelemetryData fields in packages/types/src/telemetry.ts"
Task: "T025 SESSION_RATE_FIELDS in apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs"
# Then T026 → T027; T028 whenever; T029 last.
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Phases 1–2 (T001–T007)
2. Phase 3 (T008–T013)
3. **STOP and VALIDATE**: unit suite + synthetic TC-07; live TC-09–TC-12 at the next Windows session — competitor pit awareness alone is a drivable, demo-able increment

### Live-Stream Fast Path (US4 first)

US4 exists for a dated external commitment (upcoming live stream). If the stream date approaches before US1–US3 land: run T001 then jump straight to Phase 6 (T022–T029) — it is fully independent, touches no alert code, and delivers the overlay data end to end on its own. The collector change (T025) can only be verified live on Windows (`sdk.enumerate_vars()` field-name check + `cargo test`); on this fast path that Windows session is NOT deferrable — wrong var capitalization silently yields no weather, and it would surface for the first time on stream. Hard-schedule it before the stream date.

### Incremental Delivery

- Phase 2 → foundation (all existing tests still green — deployable as a no-op)
- US1 → pit awareness (MVP)
- US2 → battle proximity
- US3 → pace degradation
- US4 → live weather for the stream overlay (slot anywhere after Phase 1, per the fast path above)
- Phase 7 → docs, follow-up issues, gates, manual Mac run

Each story lands with its own tests and leaves prior stories untouched-and-green.

---

## Notes

- US1 and US3 both edit `alert-rules.ts` + `racing-engineer.ts`; the [P] markers never cross that boundary
- `racing-engineer.test.ts` has three potential creators (T010, or T017/T019 via their run-first contingency clauses) — whichever task actually creates the file states so in its commit message, so the other two read as extensions
- Gap alerts intentionally bypass the DedupTracker (monitor state IS the dedup — research.md R3); don't "fix" that during review
- `gap:closing`/`gap:pulling_away` EVENTS remain on the bus for other consumers; only their alert-rule cases are removed (T016)
- US4 spec anchor (drift resolved 2026-07-11): spec.md carries the weather story as US4 with FR-015 (live mapping + skies union), FR-016 (absent-field no-regress), and SC-007 (live-match + cross-origin readability); plan.md §Weather remains the design source
- `weather.html` itself lives outside this repo (streaming assets volume) and currently reads only URL params — it needs a small fetch-and-poll addition to consume `/api/race-state`; that client-side change is NOT a task here (out of repo scope, per plan §Weather item 4)
- Commit after each task or logical group; every checkpoint is a safe stopping point
