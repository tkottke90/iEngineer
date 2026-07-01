# Tasks: Rule-Based Alerts + Voice

**Input**: Design documents from `specs/004-rule-based-alerts-voice/`

**Prerequisites**: plan.md ✅ spec.md ✅ research.md ✅ data-model.md ✅ contracts/ ✅ quickstart.md ✅

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with other [P] tasks in the same phase (different files, no shared dependencies)
- **[Story]**: Which user story this task belongs to (US1–US5)
- Exact file paths are relative to repo root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Config files, infra wiring, and workspace-wide type foundation. No user story work can begin until T004 is complete.

- [X] T001 Add `packages/types/src/engineer.ts` — export `AlertTier`, `AlertEventType`, `QueuedAlert`, `AudioClipRef`, `EngineerFailureLog`, `RadioBlackoutZone`, `Chattiness`, `PersonalityConfig` (see data-model.md); `PersonalityConfig` MUST include `familiarity: 'Default'` and `aggression: 'Default'` fields as M5 stubs alongside `chattiness` (FR-012); `AlertEventType` is the subset of `EventType` that PRODUCES an alert (the T1-0x/T2-0x triggering types) — it MUST NOT include signal-only events like `hero:pit_exit`, `hero:blue_flag_cleared`, or `session:safety_car_cleared`, which are consumed as dedup-clear signals (they live in `EventType` in events.ts, not here)
- [X] T002 Add `hero:pit_limiter_active` and `hero:blue_flag_cleared` to the `EventType` union in `packages/types/src/events.ts`; the limiter-off signal uses the SAME `hero:pit_limiter_active` event type with `payload.active === false` (not a separate type — per T033); `hero:blue_flag_cleared` is a distinct event needed by T033 (blue-flag dedup-clear handler); BEFORE adding anything, run `grep -n 'pit_exit\|blue_flag_cleared\|pace_degradation\|competitor:pit\|gap:closing\|gap:pulling_away' packages/types/src/events.ts` to verify which types are already present; **this grep check is non-skippable**; then follow these conditional sub-steps: (a) if `hero:pit_exit` is absent — add it immediately and run `npm run typecheck` before continuing; `hero:pit_exit` is required in M4 for pit-window dedup reset (FR-016/T029); if absent, that task silently breaks; (b) if `hero:blue_flag_cleared` is absent — add it as part of this task; (c) if any other M5 types (`hero:pace_degradation`, `competitor:pit_entry`, `competitor:pit_exit`, `gap:closing`, `gap:pulling_away`) are absent — add them; (d) if all types are already present — confirm they are not commented out, then proceed; SCOPE: all additions in this task go to `EventType` in `events.ts` ONLY — do NOT add `hero:pit_exit`, `hero:blue_flag_cleared`, or the pit-limiter-off signal to `AlertEventType` in `engineer.ts` (they are dedup-clear signals, not alert producers — see T001)
- [X] T003 Re-export new engineer types from `packages/types/src/index.ts`
- [X] T004 Create `apps/hub-server/config/engineer-config.json` with defaults: `chatterboxUrl`, `chatterboxVoiceFile`, `fuelCriticalLapsRemaining`, `gapThresholdSeconds` (FR-015 — M4 placeholder only; gap-crossing rule returns null in M4), `audioIdleCleanupIntervalMs` (see data-model.md); do NOT add `audioClipTtlMs` to the JSON — it is a module constant (`AUDIO_CLIP_TTL_MS = 60_000`) defined in `audio-store.ts` (T017), not a user-configurable value; do NOT add `paceDegradationPctThreshold` or `paceDegradationRollingLaps` — pace degradation config is M5 (YAGNI; FR-015)
- [X] T005 [P] Create `apps/hub-server/config/radio-blackout-zones.json` with empty `{ "zones": [] }`
- [X] T006 [P] Uncomment `chatterbox` service in `infra/docker-compose.yml` and verify `chatterbox-models` volume is present
- [X] T007 Add `chattiness` field (type `String`, default `"Default"`), `familiarity` field (type `String`, default `"Default"`), and `aggression` field (type `String`, default `"Default"`) to `AppConfig` struct in `apps/tauri-client/src-tauri/src/state.rs` and update its `Default` impl; `familiarity` and `aggression` are M5 stubs with no behavioral wiring (FR-012); also verify `ptt_hotkey: String` with default `"F13"` is already present (confirmed in prior milestone) — add it if absent so T040's PTT test panel has a field to read
- [X] T008 Run `npm run build && npm run typecheck` workspace-wide — must pass before any Phase 2 work begins

**Checkpoint**: Types compile, config files exist, Chatterbox runs. All user story phases may now begin.

---

## Phase 2: Foundational — Hub Alert Engine (Blocking Core Logic)

**Purpose**: Pure business logic modules with no I/O. These are prerequisites for the Racing Engineer service (Phase 3+) and are fully unit-testable in isolation.

- [X] T009 [P] Implement `apps/hub-server/src/engineer/personality-config.ts` — `loadEngineerConfig(): EngineerConfig` (reads `config/engineer-config.json`), `loadBlackoutZones(): RadioBlackoutZone[]` (reads `config/radio-blackout-zones.json`; if file missing or JSON malformed, return `[]` and emit `{ msg: "[engineer] radio-blackout-zones.json missing or invalid — treating entire lap as safe window" }` to structured log — per FR-010 fallback), `shouldSuppressAlert(alert: QueuedAlert, chattiness: Chattiness): boolean`; NOTE: `shouldSuppressAlert()` is called by the dispatcher at dequeue time (T037) — do NOT wire it into the enqueue path in T020
- [X] T010 [P] Implement `apps/hub-server/src/engineer/alert-rules.ts` — pure functions: `evaluateTier1(event: RaceEvent, config: EngineerConfig): QueuedAlert | null`, `evaluateTier2(event: RaceEvent, signals: DerivedSignals, config: EngineerConfig): QueuedAlert | null`; M4 scope: implement T1-01 (`hero:fuel_critical`), T1-02 (`hero:blue_flag`), T1-03 (`session:safety_car_deployed`), T1-04 (`hero:pit_limiter_active`), and T2-01 (`hero:pit_window_open`) only; stub T2-02–T2-06 (competitor/gap/pace rules) as `return null` with a `// TODO M5` comment — do NOT implement logic for them in M4; NOTE: `hero:pit_exit` is not a rule stub and does not appear here — its handling is in T029 (pit-window dedup reset) per FR-016; render spoken text using the canonical templates from `contracts/alert-rules.md` (e.g., `"Fuel critical — ${Math.round(payload.lapsRemaining * 10) / 10} laps remaining"`); T1-01 does NOT compute fuel consumption — it reads `payload.lapsRemaining` (already computed by the M3 fuel model, a rolling per-lap burn average) directly from the `hero:fuel_critical` event; fire only when `payload.lapsRemaining` is a finite number AND `payload.lapsRemaining <= config.fuelCriticalLapsRemaining`; return null if `payload.lapsRemaining` is null/undefined/non-finite (per FR-014); there is NO `fuelLapsRemaining()` helper and no fuel-history array — that math lives in M3, not here
- [X] T011 [P] Implement `apps/hub-server/src/engineer/dedup-tracker.ts` — `DedupTracker` class: `shouldFire(eventType: AlertEventType, lapNumber: number): boolean`, `recordFired(eventType: AlertEventType, lapNumber: number): void`, `recordCleared(eventType: AlertEventType): void`; TWO KEY STRATEGIES per FR-006 (select by event type via an internal `PER_LAP_ALERTS = new Set(['hero:fuel_critical'])` constant): (1) **per-lap** alerts (`hero:fuel_critical`) use key `${eventType}:${lapNumber}` — a new lap yields a fresh key, so the alert re-enables automatically each lap with no `recordCleared()` needed; (2) **event-cleared** alerts (`hero:blue_flag`, `session:safety_car_deployed`, `hero:pit_limiter_active`, `hero:pit_window_open`) use key `${eventType}` only (NO lap number) — the alert fires once and stays suppressed across all subsequent laps until `recordCleared(eventType)` is called; this is what makes `hero:pit_window_open` fire exactly once per stint (reset by `hero:pit_exit` in T029) rather than every lap inside the window; `shouldFire`/`recordFired` MUST branch on `PER_LAP_ALERTS.has(eventType)` to choose the key format; `recordCleared(eventType)` removes ALL entries for that event type (a same-lap re-fire is then permitted if the condition re-triggers, e.g. blue flag shown → cleared → shown again on lap 5 fires each time); hero-only in M4 — carIdx dimension deferred to M5; M5 stub event types that will extend this tracker: `competitor:pit_entry`, `competitor:pit_exit`, `gap:closing`, `gap:pulling_away`, `hero:pace_degradation`
- [X] T012 [P] Implement `apps/hub-server/src/engineer/message-queue.ts` — `PriorityMessageQueue` class: internal Tier 1 head array + Tier 2 tail array; the constructor accepts an optional `now: () => number = () => Date.now()` clock function (injected so T015 can advance time deterministically); `enqueue(alert: QueuedAlert): void` stamps `enqueuedAt = this.now()` on each Tier 2 alert (Tier 1 prepends with no timeout; Tier 2 appends with timestamp); `dequeueNext(lapDistPct: number, zones: RadioBlackoutZone[]): QueuedAlert | null` (Tier 1 always dequeues; Tier 2 only if `isSafeWindow(lapDistPct, zones)` — if `!isSafeWindow`, check each Tier 2 head entry's age: if `this.now() - enqueuedAt >= 30_000`, drop it and emit `{ msg: "[engineer] Tier 2 alert dropped — no safe window within 30s", alertType, enqueuedAt }` to structured log, then try the next entry, per FR-017); zone boundary comparison in `isSafeWindow` MUST be inclusive on both ends (`lapDistPct >= z.lapDistPctStart && lapDistPct <= z.lapDistPctEnd`) — add an inline comment documenting this
- [X] T013 Write unit tests for `alert-rules.ts` in `apps/hub-server/tests/unit/engineer/alert-rules.test.ts` — fixture `RaceEvent` objects covering the five M4 active rules (T1-01–T1-04, T2-01); verify correct `QueuedAlert` shape and null return when condition not met; for T1-01 (fuel critical): (a) assert the rule uses `config.fuelCriticalLapsRemaining` as the threshold — not a hardcoded value (test with `fuelCriticalLapsRemaining: 2`, assert fires when `payload.lapsRemaining` is 1.5, and does NOT fire when `payload.lapsRemaining` is 2.5 — proves M4 re-thresholds on top of M3's event); (b) null/absent guard — assert the rule returns null when `payload.lapsRemaining` is `null`, `undefined`, or non-finite (per FR-014; M4 does no fuel math and must not fire without a value); (c) assert the spoken text string matches the canonical template from `contracts/alert-rules.md`; one test per M5 stub rule asserting `null` for `competitor:pit_entry` (T2-02), `competitor:pit_exit` (T2-03), `gap:closing` (T2-04), `gap:pulling_away` (T2-05), and `hero:pace_degradation` (T2-06)
- [X] T014 [P] Write unit tests for `dedup-tracker.ts` in `apps/hub-server/tests/unit/engineer/dedup-tracker.test.ts` — cover BOTH key strategies: (per-lap) `hero:fuel_critical` fires on lap 5, suppressed on repeat same lap 5, then fires again on lap 6 WITHOUT any `recordCleared()` call (proves per-lap auto-reset); (event-cleared) `hero:pit_window_open` fires on lap 10, suppressed on lap 11 AND lap 12 with no clear (proves persistent per-stint suppression across laps — this is the key regression guard for the two-strategy dedup design), then fires again after `recordCleared('hero:pit_window_open')`; condition-clear reset for the three flag alerts (`hero:blue_flag_cleared` → `recordCleared('hero:blue_flag')`; `hero:pit_limiter_active` payload.active===false → `recordCleared('hero:pit_limiter_active')`; `session:safety_car_cleared` → `recordCleared('session:safety_car_deployed')` — all wired in T033); same-lap re-fire permitted after an event-cleared reset
- [X] T015 [P] Write unit tests for `message-queue.ts` in `apps/hub-server/tests/unit/engineer/message-queue.test.ts` — Tier 1 dequeues before Tier 2; two simultaneous Tier 1 alerts enqueued and both dequeue in order without either being dropped (covers spec Edge Case 2); Tier 2 held during blackout zone; Tier 2 dequeues after zone clears; empty queue returns null; FR-017 30s timeout drop (inject a mock clock or a stubbed `now()` into `PriorityMessageQueue` so the test can advance time): enqueue a Tier 2 alert, advance the clock past 30s while `dequeueNext()` is called with a lapDistPct still inside a blackout zone, assert the alert is dropped (not returned) AND a structured warning log matching `{ msg: "[engineer] Tier 2 alert dropped — no safe window within 30s", ... }` is emitted (spy on the logger); also assert an alert enqueued at 29s is still delivered when the zone clears (boundary check)
- [X] T016 [P] Write unit tests for `personality-config.ts` in `apps/hub-server/tests/unit/engineer/personality-config.test.ts` — Chattiness Low suppresses Tier 2; Chattiness Default passes both tiers; Tier 1 never suppressed regardless of setting; add one negative assertion: `shouldSuppressAlert()` output is identical regardless of `familiarity` or `aggression` field values (e.g., set both to `"High"` and confirm Tier 2 suppression behavior is unchanged — stubs must not affect dispatch logic); also add these structured-log coverage cases: (a) FR-010 fallback — call `loadBlackoutZones()` with a path that does not exist or contains invalid JSON; assert return value is `[]` AND assert that a structured log message matching `{ msg: "[engineer] radio-blackout-zones.json missing or invalid — treating entire lap as safe window" }` was emitted (spy on console or inject a logger); (b) FR-011 fallback — simulate `hub:config:chattiness` Redis key absent or unrecognized; assert `shouldSuppressAlert()` defaults to `"Default"` behavior AND assert the `{ msg: "[engineer] Chattiness key absent or unrecognized", ... }` structured log was emitted exactly once (the `_chattinessWarnEmitted` guard should prevent repeat emission)

**Checkpoint**: `npm test` passes for all engineer unit tests. Core logic is verified without any I/O.

---

## Phase 3: User Story 1 — Fuel Critical Alert (Priority: P1) 🎯 MVP

**Goal**: Complete end-to-end path from `hero:fuel_critical` event → TTS → audio playback through Tauri within 3 seconds.

**Independent Test**: See quickstart.md Scenario 1 — publish synthetic `hero:fuel_critical` to Redis, confirm audio heard within 3 seconds.

### Implementation

- [X] T017 Implement `apps/hub-server/src/engineer/tts-client.ts` — `generateClip(text: string, config: EngineerConfig): Promise<Buffer>` via `POST /tts` with clone-mode body (see `contracts/chatterbox-tts.md`); on non-200 response, throw with message used for `EngineerFailureLog`
- [X] T018 Implement `apps/hub-server/src/engineer/audio-store.ts` — export `AUDIO_CLIP_TTL_MS = 60_000` as a module constant (not read from config); add a comment: `// COUPLING: must equal the hard-coded 60_000 in subscriber.rs (T024) — change both together or clips will be served after Tauri considers them stale`; `AudioStore` class: `store(buffer: Buffer): { audioId: string, clipUrl: string }` where `clipUrl` is a RELATIVE path `/api/audio/${audioId}` (NOT absolute — the hub cannot know the host/port the client reaches it by; the Tauri subscriber prepends its already-configured `hub_url` in T024, which also handles LAN IPs like `http://10.0.0.x:3000`); UUID key, in-memory Map entry with `storedAt` timestamp — `storedAt` and the `AudioClipRef.generatedAt` published in T020 MUST be the same `Date.now()` value so the TTL and the Tauri stale-clip check are anchored to the same instant; also export a module-level `getAudioStore()` accessor (set the singleton during server-init) so `api.ts` routes (T019/T039) can reach the same store; `get(audioId: string): Buffer | null` (returns null if evicted); TTL cleanup via `setInterval` every `audioIdleCleanupIntervalMs` that removes entries where `Date.now() - storedAt > AUDIO_CLIP_TTL_MS`; `destroy()` to clear interval on shutdown
- [X] T019 Add `GET /api/audio/:audioId` route in `apps/hub-server/src/api.ts` (the Hono app that already hosts `/api/race-state`, `/api/fuel-model`, etc. — NOT `routes.ts`, which is the hono-preact page-route table using `defineRoutes`); handler reads from the `AudioStore` and returns 200 + binary body with `Content-Type: audio/mpeg`, or 404 if not found; because `AudioStore` is an in-process singleton owned by `RacingEngineerService`, expose it to `api.ts` via a module-level accessor (mirror the existing `getSnapshot()` pattern — e.g. `getAudioStore()` in `audio-store.ts` that returns the instance set during server-init) rather than constructing a new store in the route
- [X] T020 [US1] Implement `apps/hub-server/src/engineer/racing-engineer.ts` — `RacingEngineerService` class: constructor takes Redis command conn + `AudioStore` + `PriorityMessageQueue` + `DedupTracker` + `RaceStateStore` (the same singleton already wired in hub-server) + config; `start()` subscribes to `hub:events` pub/sub channel; on each message: parse `RaceEvent`, evaluate rules (T1-01 reads `payload.lapsRemaining` directly from the `hero:fuel_critical` event — the M3 fuel model already computed it as a rolling per-lap burn average; the Racing Engineer keeps NO fuel history and does NO fuel math, so there are no `_lapFuelHistory`/`_lastFuelLevel`/`_lastLapNumber` fields and no lap-completion detection here), dedup check, enqueue (alerts enter the queue unconditionally after dedup — chattiness suppression is NOT applied here; it is applied by the dispatcher at dequeue time per T037); background dispatcher loop (setInterval 100ms) checks a `_generating` boolean flag — if true, skips the tick; if false, reads `raceState.getSnapshot().hero?.lapDistPct ?? 0` and calls `dequeueNext(lapDistPct, zones)` (the `?? 0` default treats lap start as a safe window until a real position is available); sets `_generating = true`, fires TTS asynchronously (do not await inside the interval callback) — the async chain MUST be wrapped in try/catch with `finally { this._generating = false; }` so `_generating` is ALWAYS cleared regardless of whether the error was caught or unexpected; stores clip, publishes `AudioClipRef` to `voice:audio`; on TTS error, emits `EngineerFailureLog` before the finally clears the flag
- [X] T021 [US1] Wire `RacingEngineerService` startup into `apps/hub-server/src/server-init.ts` — instantiate service after Redis connections are established; call `service.start()`; call `service.stop()` in `shutdown()`; the `start()` method MUST wrap the Redis pub/sub subscription in a try/catch — on failure emit `{ msg: "[engineer] Failed to subscribe to hub:events", reason: err.message }` to structured log and return without throwing (service is silently degraded, not crashed — per spec edge case: Redis unavailable → log error, no audio attempted)
- [X] T022 [US1] Create `apps/tauri-client/src-tauri/src/engineer/mod.rs` — declare `subscriber` and `playback_queue` submodules; export `spawn_engineer_task(app_handle, redis_url)` which forwards `app_handle` into `spawn_subscriber` so the subscriber can read `hub_url` from managed `AppConfig` state (needed to resolve relative clip URLs in T024)
- [X] T023 [US1] Implement `apps/tauri-client/src-tauri/src/engineer/playback_queue.rs` — `PlaybackQueue`: `tokio::sync::mpsc` channel of `String` (clip URLs); `PlaybackQueue::new()` returns sender handle + spawns receiver task that calls `AudioPlayback::play_url()` sequentially (blocks on each clip until complete; no interruption); if `play_url()` returns an OS-level error (e.g., no audio output device selected, device disconnected), log `{ msg: "[engineer] Audio playback failed", url, reason }` as a structured error and discard the clip — do NOT panic or propagate the error; the receiver loop MUST continue processing subsequent clips; include a `#[cfg(test)]` unit test (E3 coverage) that injects a play function returning `Err` for the first URL and `Ok` for the second, then asserts BOTH URLs are consumed from the channel (the loop did not halt on the error) and that the error was logged — structure `play_url` behind a small trait or function pointer so the test can substitute a failing stub; NOTE on priority: Tier 1 vs Tier 2 ordering is enforced at the hub's `PriorityMessageQueue` (T012) — once an `AudioClipRef` is published to `voice:audio` and enqueued here, all clips play FIFO with no reordering; this means a Tier 2 clip already dispatched will play before a Tier 1 that arrives afterward, which is acceptable (the hub gate prevents Tier 1 from being dispatched after a queued Tier 2 — the priority window is entirely hub-side)
- [X] T024 [US1] Implement `apps/tauri-client/src-tauri/src/engineer/subscriber.rs` — `spawn_subscriber(app_handle, redis_url, queue_tx)`: spawns `PubSubListener` on `voice:audio`; on each message parses `AudioClipRef` JSON; checks `generatedAt + 60_000 < now_ms` → log and discard if stale; add a comment: `// COUPLING: 60_000 must equal AUDIO_CLIP_TTL_MS in audio-store.ts (T018) — change both together`; resolves the relative `clip_url` (`/api/audio/:audioId`) against the configured `hub_url` from `AppConfig` (read via the managed Tauri state from `app_handle`) — e.g. `format!("{}{}", hub_url.trim_end_matches('/'), clip_url)` — so `play_url()` (reqwest) receives an absolute URL; sends the resolved absolute URL to the `PlaybackQueue` sender
- [X] T025 [US1] Register `engineer` module in `apps/tauri-client/src-tauri/src/lib.rs` — add `mod engineer;`; in `setup()` closure, spawn `engineer::spawn_engineer_task(app.handle().clone(), redis_url)`
- [X] T026 [US1] Verify `rodio` in `apps/tauri-client/src-tauri/Cargo.toml` has the `mp3` feature enabled (`rodio = { features = ["mp3"] }`)
- [X] T027 [US1] Write integration test in `apps/hub-server/tests/integration/engineer-round-trip.test.ts` — mock Chatterbox HTTP at the undici/fetch layer (mock returns instantly, eliminating real TTS latency); publish `hero:fuel_critical` to `hub:events`; assert `voice:audio` receives an `AudioClipRef` within 5 seconds (5s gives CI headroom; the mock removes TTS time so the actual hub-side latency is well under 1s — SC-001's 3s budget is validated in the live deploy test, not here); assert `GET /api/audio/:audioId` returns 200 with binary body; ALSO add a second test case (E2 coverage) that constructs `RacingEngineerService` with a Redis connection stub whose `subscribe()` rejects — assert `start()` does NOT throw, emits `{ msg: "[engineer] Failed to subscribe to hub:events", ... }`, and the process stays alive (service silently degraded per spec Redis-unavailable edge case / T021)

**Checkpoint**: Quickstart Scenario 1 passes. Fuel critical audio heard through Tauri within 3 seconds of Redis PUBLISH.

---

## Phase 4: User Story 2 — Pit Window Alert + Safe-Window Gate (Priority: P2)

**Goal**: Pit window alert fires at the correct lap; held during Radio Blackout Zone and released at next safe window.

**Independent Test**: See quickstart.md Scenarios 2 and 4 — pit window fires once, held in zone, re-fires after pit exit.

### Implementation

- [X] T028 [US2] Verify the dispatcher in `apps/hub-server/src/engineer/racing-engineer.ts` (T020) correctly reads `lapDistPct` from `raceState.getSnapshot()` on every tick before calling `dequeueNext()` — this is already implemented in T020; this task is a focused code-review checkpoint confirming the live snapshot is wired rather than a stale cached value
- [X] T029 [US2] Wire `hero:pit_exit` event handling in `RacingEngineerService` to call `DedupTracker.recordCleared('hero:pit_window_open')` — enabling pit window dedup reset per clarification
- [X] T030 [US2] Write integration test in `apps/hub-server/tests/integration/safe-window-gate.test.ts` — configure a blackout zone covering `lapDistPct` 0.4–0.6; publish `hero:pit_window_open` with `lapDistPct: 0.5`; assert no `voice:audio` message within 3 seconds; record `zoneExitPublishedAt = Date.now()`; simulate tick with `lapDistPct: 0.7`; assert `voice:audio` arrives and `Date.now() - zoneExitPublishedAt <= 3000` (SC-006 — the 3s clock is anchored to zone-exit publish time; the 100ms dispatcher interval consumes at most 100ms of this budget, leaving 2.9s headroom for TTS mock + pub/sub round-trip)
- [X] T031 [US2] Write integration test for pit window dedup reset in `apps/hub-server/tests/integration/pit-window-dedup.test.ts` — fire `hero:pit_window_open` (lap 10, inside the configured 10–15 window); assert alert fires; fire again (lap 11, still in window); assert suppressed — because `hero:pit_window_open` is an event-cleared alert its dedup key is `hero:pit_window_open` (no lap number), so it stays suppressed across laps without a clear (per FR-006 / T011 two-strategy design); fire again (lap 12, still in window, still no pit exit); assert STILL suppressed (this is the critical assertion — proves per-stint suppression, not per-lap); publish `hero:pit_exit`; fire `hero:pit_window_open` again (lap 13, inside the same configured window); assert fires (dedup reset by pit exit per FR-016)

**Checkpoint**: Quickstart Scenarios 2 and 4 pass. Pit window alert in live session audible at configured lap.

---

## Phase 5: User Story 3 — Tier 1 Alerts: Blue Flag, Safety Car, Pit Limiter (Priority: P2)

**Goal**: All three remaining Tier 1 alerts fire immediately, bypassing safe-window gate.

**Independent Test**: See quickstart.md Scenario 1 pattern — simulate each flag event independently; confirm immediate audio with no gate delay.

### Implementation

- [X] T032 [P] [US3] Verify `alert-rules.ts` T1-02 (`hero:blue_flag`), T1-03 (`session:safety_car_deployed`), T1-04 (`hero:pit_limiter_active`) rules are complete and return correct `QueuedAlert` with `tier: 1` — these were implemented in T010; this task is a focused review + smoke test using quickstart.md redis-cli steps
- [X] T033 [US3] Wire all three Tier 1 dedup-clear handlers in `apps/hub-server/src/engineer/racing-engineer.ts` — add to the `hub:events` subscriber's event dispatch: (a) `session:safety_car_cleared` → `dedupTracker.recordCleared('session:safety_car_deployed')`; (b) `hero:blue_flag_cleared` → `dedupTracker.recordCleared('hero:blue_flag')`, enabling re-fire if the flag is re-shown; (c) `hero:pit_limiter_active` with `payload.active === false` → `dedupTracker.recordCleared('hero:pit_limiter_active')`, enabling re-fire on limiter toggle (same event type as T1-04, different payload value — per T002 decision); add handlers if missing
- [X] T034 [US3] Extend `apps/hub-server/tests/unit/engineer/message-queue.test.ts` (created in T015) with a Tier 1 blackout-zone bypass test: enqueue one Tier 2 then one Tier 1 while a blackout zone is active; assert Tier 1 dequeues first

**Checkpoint**: All four Tier 1 alert types (fuel critical, blue flag, safety car, pit limiter) fire immediately via quickstart redis-cli steps.

---

## Phase 6: User Story 4 — Chattiness Personality Setting (Priority: P3)

**Goal**: Chattiness=Low suppresses all Tier 2 alerts; Tier 1 alerts unaffected.

**Independent Test**: See quickstart.md Scenario 5 — set Chattiness to Low; trigger Tier 2 alert; confirm no audio; Tier 1 still fires.

### Implementation

- [X] T035 [US4] Add `chattiness` field to Tauri settings UI in `apps/tauri-client/src/pages/Setup.tsx` — dropdown with "Default" and "Low" options; persists via `save_config` Tauri command
- [X] T036 [US4] Wire Chattiness write to hub: in Tauri's `save_config` command handler (`apps/tauri-client/src-tauri/src/commands.rs`), after persisting `AppConfig`, write `SET hub:config:chattiness <"Low"|"Default">` to Redis — this is the Tauri→hub sync channel for the Chattiness preference
- [X] T037 [US4] Wire `shouldSuppressAlert()` into the dispatcher's dequeue tick (not at enqueue time) — read `hub:config:chattiness` from Redis immediately before calling `dequeueNext()`; wrap the GET in try/catch — if the key is absent, its value is not `"Low"` or `"Default"`, OR the Redis GET itself throws (timeout/connection error), default to `"Default"` and emit `{ msg: "[engineer] Chattiness key absent, unrecognized, or unreadable", reason: "chattiness-key-fallback", fallback: "Default" }` to structured log (per FR-011); a Redis read failure MUST NOT crash or stall the dispatcher — it falls back to Default and continues — use a `_chattinessWarnEmitted` boolean flag on `RacingEngineerService` so this warning logs at most once per hub startup (not once per 100ms tick — cold start would otherwise flood logs); then call `shouldSuppressAlert(alert, chattiness)` and discard if suppressed; this ensures mid-race Chattiness changes take effect without re-evaluating the queue; add a structured log line when an alert is suppressed: `{ msg: "[engineer] Alert suppressed", alertType, reason: "Chattiness:Low" }`

**Checkpoint**: Quickstart Scenario 5 passes — zero Tier 2 audio with Chattiness=Low; Tier 1 fires normally.

---

## Phase 7: User Story 5 — Audio Device Test Panel (Priority: P3)

**Goal**: Driver can verify audio output, mic input, and PTT without starting a race session.

**Independent Test**: See quickstart.md Scenario 6 — open Settings → Audio; all three sub-tests complete independently.

### Implementation

- [X] T038 [P] [US5] Add `test_audio_playback` Tauri command in `apps/tauri-client/src-tauri/src/commands.rs` — calls hub `POST /api/audio/test` (T039), which owns the fixed test phrase server-side; the command does NOT hold its own phrase text — it just triggers the endpoint and enqueues the returned relative `clipUrl` (resolved against `hub_url`) via `PlaybackQueue`; returns `Ok(())` or `Err(String)`; always route through the hub endpoint — do NOT call Chatterbox directly, as that would bypass `AudioStore` TTL tracking and structured logging (Principle V)
- [X] T039 [US5] Add `POST /api/audio/test` endpoint in `apps/hub-server/src/api.ts` (same Hono app as T019 — NOT `routes.ts`) — synthesizes a fixed test phrase ("Racing engineer online. Audio check.") via `TtsClient`, stores it via the shared `AudioStore` accessor (from T019), returns `{ clipUrl }` JSON; test-only shortcut that does NOT use the `voice:audio` pub/sub channel
- [X] T040 [US5] Implement `packages/ui/src/components/AudioDeviceTestPanel/index.tsx` — three sections: (1) "Play Test Clip" button → if no output device configured, show "No audio device configured" and disable button; otherwise invoke `test_audio_playback` Tauri command, show loading state; if no response within 30 seconds, transition to error state ("Audio synthesis failed — check Chatterbox service"); on success show success state briefly before resetting to idle; (2) Mic level meter → extract Web Audio setup into `packages/ui/src/hooks/useMicLevel.ts` (custom hook returning `{ level: number | null, error: string | null }`); hook lives in `packages/ui/src/hooks/` — Web Audio / `getUserMedia` is browser presentation infrastructure, not domain business logic, which is consistent with Principle II (no further review needed; this is the final location); `level` is normalized 0.0–1.0 (RMS or peak amplitude); component consumes the hook and renders a live bar whose fill = `level`; the bar visibly moves when `level` rises above a small resting baseline (~0.05) — this is the observable criterion for US5 AC2 (formal automated assertion deferred to M5); if permission is denied or mic is unavailable (`error !== null`), show "Microphone unavailable" and render the bar disabled; (3) PTT test → listens for PTT hotkey event (existing `ptt_hotkey` field in `AppConfig`), shows "PTT detected" on press
- [X] T041 [US5] Export `AudioDeviceTestPanel` from `packages/ui/src/index.ts`
- [X] T042 [US5] Add `AudioDeviceTestPanel` section to `apps/tauri-client/src/pages/Setup.tsx` — import from `@iracing-engineer/ui`; place in an "Audio" settings section below device selectors

**Checkpoint**: Quickstart Scenario 6 passes — Play Test Clip heard, mic meter responds, PTT press confirmed. No active race session needed.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Hardening, logging completeness, and deploy-test readiness.

- [X] T043 Add structured log lines to `RacingEngineerService` for: alert enqueued (`[engineer] Alert enqueued`), dedup-suppressed (`{ msg: "[engineer] Alert deduplicated", alertType, lapNumber }` — satisfies Principle V no-silent-failures for dedup decisions), clip generated (`[engineer] Clip generated`), `AudioClipRef` published (`[engineer] Clip published`); include `alertType`, `tier`, `lapNumber`, `audioId` fields where applicable
- [X] T044 [P] Add structured log lines to Tauri `subscriber.rs` and `playback_queue.rs`: clip received, stale clip discarded, playback started, playback complete or errored
- [X] T045 [P] Verify `PersonalityConfig` in `packages/types/src/engineer.ts` (T001) exposes `familiarity` and `aggression` fields, and that `AppConfig` in `apps/tauri-client/src-tauri/src/state.rs` (T007) has the corresponding Rust stubs — both sides are implemented in earlier tasks; this task is a final cross-check before deploy test (no new code expected)
- [X] T046 Verify `infra/docker-compose.yml` Chatterbox service is reachable: `docker compose up -d && curl -sf http://10.0.0.12:8004/openapi.json` (or confirm port binding)
- [ ] T047 [P] Run full quickstart.md validation (all 7 scenarios) and mark each as passed/failed; for Scenario 6 (audio device test panel), explicitly verify SC-005: from panel open to confirmed clip playback MUST complete in under 60 seconds — record the elapsed time; automated timing assertion deferred to M5 but the manual check MUST be recorded here
- [ ] T048 Deploy test: live iRacing practice session — confirm pit window alert and fuel critical alert heard through speakers at correct conditions (see quickstart.md Deploy Test section); note: this is the only SC-001 validation covering the full end-to-end path (event → TTS → pub/sub → Tauri fetch → playback start ≤ 3s); automated end-to-end timing assertion deferred to M5; also validate SC-006: configure at least one Radio Blackout Zone in `radio-blackout-zones.json`, trigger a Tier 2 alert inside the zone, confirm audio plays within 3 seconds of exiting the zone (this is the only real-Chatterbox validation of SC-006)
- [X] T049 [P] Run `npm run build && npm run typecheck` workspace-wide; `cargo clippy -- -D warnings`; confirm zero errors

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (Setup) → must complete T001–T007 before any other phase
Phase 2 (Foundational) → depends on Phase 1 (needs types from T001–T003)
Phase 3 (US1) → depends on Phase 2 (needs alert-rules, dedup-tracker, message-queue)
Phase 4 (US2) → depends on Phase 3 (extends RacingEngineerService from T020–T021)
Phase 5 (US3) → depends on Phase 2; can run in parallel with Phase 4
Phase 6 (US4) → depends on Phase 3 (needs service wired); parallel-safe with Phase 4/5
Phase 7 (US5) → depends on T017–T019 (needs TTS client + audio store + hub route)
Phase 8 (Polish) → depends on all story phases complete
```

### User Story Dependencies

- **US1 (Fuel Critical)**: Full end-to-end path — prerequisite for US2–US4
- **US2 (Pit Window + Gate)**: Extends US1's service; needs `raceState.getSnapshot()` wired
- **US3 (Blue Flag, Safety Car, Pit Limiter)**: Core rules already in Phase 2; wiring only
- **US4 (Chattiness)**: Needs US1 service; UI + suppression filter
- **US5 (Audio Test Panel)**: Needs T017–T019 (TTS + audio store + hub route); otherwise independent of US1–US4

### Parallel Opportunities within Phases

**Phase 2** — T010, T011, T012 can all run in parallel (different files)

**Phase 3** — T017, T018 can run in parallel (different files); T022, T023, T024 can run in parallel (different Rust files)

**Phase 7** — T038, T039, T040 can run in parallel (Rust command, hub route, UI component)

---

## Parallel Execution Examples

### Phase 2: Foundational (3 parallel tracks)

```
Track A: T009 → T016
Track B: T010 → T013
Track C: T011 → T014; T012 → T015
```

### Phase 3: US1 (hub and Tauri in parallel)

```
Track A (hub):   T017 → T018 → T019 → T020 → T021 → T027
Track B (tauri): T022 → T023 → T024 → T025 → T026
```

---

## Implementation Strategy

### MVP First (US1 — Fuel Critical End-to-End)

1. Complete Phase 1 (Setup) — T001–T008
2. Complete Phase 2 (Foundational) — T009–T016
3. Complete Phase 3 (US1) — T017–T027
4. **STOP and VALIDATE**: Quickstart Scenario 1 — fuel critical audio heard
5. This is the minimum viable engineer: one alert, fully wired, end-to-end

### Incremental Delivery

- US1 ✅ → hear first alert through speakers
- US2 adds pit window + safe-window gate → strategic value
- US3 wires remaining Tier 1 alerts → regulatory safety coverage
- US4 adds Chattiness → UX tuning
- US5 adds test panel → setup confidence

---

## Notes

- [P] tasks touch different files — no coordination needed
- Constitution check gates: `npm run build && npm run typecheck` after Phase 1; `cargo clippy` before Phase 8 sign-off
- The Chatterbox server is at `http://10.0.0.12:8004` (homelab) — not localhost; ensure network reachability before Phase 3 integration testing
- `rodio` MP3 feature must be enabled (T026) — Chatterbox returns MP3 in clone mode per POC-0001
- Dedup key format (two strategies per FR-006, hero-only in M4): per-lap alerts (`hero:fuel_critical`) key on `${eventType}:${lapNumber}`; event-cleared alerts (blue flag, safety car, pit limiter, pit window) key on `${eventType}` only. carIdx dimension added in M5 when competitor gap/pace alerts activate
- All structured logs use `console.log(JSON.stringify({...}))` pattern consistent with hub-server codebase
