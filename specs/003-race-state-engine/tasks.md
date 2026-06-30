# Tasks: Race State Engine

**Input**: Design documents from `specs/003-race-state-engine/`

**Prerequisites**: plan.md ✅ | spec.md ✅ | research.md ✅ | data-model.md ✅ | contracts/hub-redis-outputs.md ✅

**Tests**: Included — required by Constitution Principle VI (NON-NEGOTIABLE) and SC-007 in spec.md.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: User story label — maps to spec.md priorities
- All paths relative to repo root

---

## Phase 1: Setup

**Purpose**: Project initialization — directory structure, dependencies, test tooling.

- [X] T001 Add `ioredis ^5.x` to dependencies in `apps/hub-server/package.json`
- [X] T002 Add `mocha ^10.x`, `chai ^4.x`, `@types/mocha`, `@types/chai`, `tsx ^4.x` to devDependencies in `apps/hub-server/package.json` (`tsx` is required for mocha to load TypeScript files directly)
- [X] T003 Add `test` and `test:integration` scripts to `apps/hub-server/package.json`: `"test": "mocha --require tsx 'tests/unit/**/*.test.ts'"` and `"test:integration": "mocha --require tsx 'tests/integration/**/*.test.ts'"` (quoted globs so mocha handles expansion cross-platform)
- [X] T004 Create directory structure in `apps/hub-server/`: `src/pipeline/`, `src/models/`, `src/state/`, `src/redis/`, `tests/unit/models/`, `tests/unit/pipeline/`, `tests/integration/`
- [X] T005 [P] Create inject helper scripts for validation (used in quickstart.md): `scripts/inject-session-telemetry.js`, `scripts/inject-pit-entry.js`, `scripts/inject-braking-sequence.js`. Each script MUST accept `--session-id`, `--hero-car-idx` CLI flags and write to Redis at the URL in `REDIS_URL` (default `redis://localhost:6379`). Full CLI flag schemas and Redis stream targets are documented in `specs/003-race-state-engine/quickstart.md` steps 3–7.

**Checkpoint**: `npm install` succeeds in `apps/hub-server/`; `npm test` runs and reports "0 passing" (no tests yet).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Types extension, Redis infrastructure, in-memory state shell, and hub server wiring. **Must complete before any user story phase begins.**

**⚠️ CRITICAL**: All user story phases depend on this foundation.

### Types Package Extension

- [X] T006 Add `pitWindowOpen: boolean` to `DerivedSignals` interface in `packages/types/src/race-state.ts`
- [X] T007 Add `estimatedPitDuration: number | null` to `CarState` interface in `packages/types/src/race-state.ts`
- [X] T008 Add `summary: string`, `timeRemaining: number | null`, and `fuelDeficit: number` to `FuelModel` interface in `packages/types/src/models.ts` (`fuelDeficit = fuelToFinish − fuelRemaining`; required by FR-029 pitWindowOpen logic)
- [X] T009 Run `npm run build && npm run typecheck` in `packages/types/` — confirm zero errors

### Redis Infrastructure

- [X] T010 Implement `apps/hub-server/src/redis/client.ts`: export `createConsumerConnection()` and `createCommandConnection()` as singleton ioredis instances configured from `REDIS_URL` env var (default `redis://localhost:6379`)
- [X] T011 Implement `apps/hub-server/src/redis/consumer.ts`:
  - `setupConsumerGroups()`: XGROUP CREATE for **all three streams** with `MKSTREAM`; catch `BUSYGROUP` error silently:
    - `iracing:telemetry:live` → group `hub:live-processor` (consumer `hub-server-1`)
    - `iracing:telemetry:session` → group `hub:session-processor` (consumer `hub-server-1`)
    - `iracing:events:session` → group `hub:session-event-processor` (consumer `hub-server-1`) ← FR-002, FR-004
    - Downstream groups for M4 (FR-004): `hub:racing-engineer` on BOTH `iracing:telemetry:session` AND `iracing:telemetry:live` (M4 needs session telemetry for race state + live telemetry for safe window)
    - Downstream groups for M6 (FR-004): `hub:stream-engineer` on `iracing:telemetry:live` only (M6 streams 60 Hz live data)
  - `reclaimPendingMessages(idleMs = 30_000)`: XAUTOCLAIM all three streams for messages idle > `idleMs` before switching to `>` mode; default 30,000ms (30s) so a quick crash-and-restart reclaims messages within seconds, not 1 hour — the configurable parameter enables unit testing without waiting (U1: 3,600,000ms default would fail SC-006 "no gap" for quick restarts)
  - `streamConsumerLoop(onLive, onSession, onSessionEvent)`: infinite async loop — `XREADGROUP ... BLOCK 50 STREAMS iracing:telemetry:live iracing:telemetry:session iracing:events:session > > >`, route entries to the appropriate callback by stream name, `XACK` after delivery; on startup call `onSessionEvent` once with the result of `XREVRANGE iracing:events:session + - COUNT 1` to seed initial SessionState (FR-002)

### In-Memory State Shell

- [X] T012 Implement `apps/hub-server/src/state/race-state.ts`:
  - Singleton `RaceState` object initialized to `{ session: null, field: {}, hero: null, signals: { safeWindowOpen: false, cutWindowOpen: false, pitWindowOpen: false, activeBattles: [] } }`
  - Typed mutation methods: `setSession()`, `updateCarState()`, `setHeroState()`, `updateSignals()`
  - `getSnapshot(): RaceState` — returns current in-memory state
  - `writeKvSnapshot(commandConn, sessionId)`: `SETEX hub:race-state:{sessionId} 7200 JSON`

### Event Bus

- [X] T013 Implement `apps/hub-server/src/pipeline/event-bus.ts`:
  - `publishEvent(event: RaceEvent, commandConn, sessionId)`: `PUBLISH hub:events JSON` + `LPUSH hub:events:ring:{sessionId} JSON` + `LTRIM 0 99` + `EXPIREAT +7200`
  - **FR-027 (REQUIRED)**: Emit structured log on EVERY publish call: `{ type, sessionId, sessionTime, emitLatencyMs }` where `emitLatencyMs` = wall-clock time from event detection to PUBLISH call; this field is mandatory — T036 audits for it but does not create it
  - Export `EventBus` class or module with `publish()` method

### Hub Server Entry Point Wiring

- [X] T014 Implement `apps/hub-server/src/server-init.ts`: export `startPipeline()` that creates Redis connections, calls `setupConsumerGroups()`, `reclaimPendingMessages()`, starts SessionEventProcessor, SessionProcessor consumer loop, and LiveProcessor interval; registers SIGTERM handler for graceful shutdown
- [X] T015 Call `startPipeline()` from the hub server's Node entry point: add a Vite plugin `configureServer` hook in `apps/hub-server/vite.config.ts` that calls `startPipeline()` on server startup (this is the correct hook point for `hono-preact` — the framework generates `dist/server/server-entry.js` from this config; `src/pages/home.server.ts` must NOT be modified). The plugin runs in both dev (`vite dev`) and production (`node dist/server/server-entry.js`) modes.

**Checkpoint**: Hub server starts without errors; `redis-cli XINFO GROUPS iracing:telemetry:live` shows `hub:live-processor` group; `GET /healthz` returns `ok`.

---

## Phase 3: User Story 2 — Derived Models Compute Correct Strategy Numbers (Priority: P1)

**Goal**: FuelModel, TireModel, and GapModel produce correct computed outputs from simulated lap data. Independently testable via unit tests before any processor integration.

**Independent Test**: `npm test` in `apps/hub-server/` passes all 13 model unit tests.

### Tests for User Story 2 (write first — must FAIL before implementation)

- [X] T016 [P] [US2] Write `apps/hub-server/tests/unit/models/fuel-model.test.ts` with 5 test cases covering FR-011–FR-015 (SC-002):
  1. **FR-012**: After 1 lap: `confidenceLevel === "low"`
  2. **SC-002/FR-013**: After 5 laps with burn rate 2.8 L/lap: `burnRatePerLap` within ±0.05 of 2.8 (hand-computed reference); assert `summary` contains lap count, the word `"good"` (`fuelDeficit < 0`), AND the `"-lap buffer"` substring (lap-based template, C4); also assert surplus=0 case returns `"tight"` and deficit case returns `"critical"` in summary
  3. **FR-012**: Outlap and inlap excluded from rolling average (average must ignore these laps)
  4. **FR-014**: Refuel detected (fuelLevel increase on pit exit) resets `fuelAtLapStart` without corrupting average
  5. **FR-015**: `SessionLapsRemain === -1`: `lapsRemaining === null`, `timeRemaining` populated, `summary` uses time-based template including `"{|bufferMinutes|}-minute buffer"` substring (C4)
- [X] T017 [P] [US2] Write `apps/hub-server/tests/unit/models/tire-model.test.ts` with 6 test cases:
  1. `degradationSignal === "nominal"` when trend < 0.3s
  2. `degradationSignal === "watch"` when trend 0.3–0.6s
  3. `degradationSignal === "critical"` when trend > 0.6s
  4. `degradationSignal === "watch"` when trend is exactly 0.6s (upper boundary — must NOT be `"critical"`)
  5. `degradationSignal === "watch"` when trend is exactly 0.3s (lower boundary — must NOT be `"nominal"`, per FR-017: `[0.3, 0.6]` is `watch`, boundary inclusive)
  6. Out-lap and in-lap excluded from stint median (stint median computed from valid laps only)
- [X] T018 [P] [US2] Write `apps/hub-server/tests/unit/models/gap-model.test.ts` with 4 test cases covering FR-018, FR-019, FR-020 (SC-003):
  1. **FR-019**: `battleStatus === "battle"` when gap ≤ 1.0s
  2. **FR-019**: `battleStatus === "resolved"` after 2+ consecutive checks with gap > 1.5s (2-tick debounce)
  3. **FR-020**: Lapped-car gap (`carIdxF2Time > 0.8 × estimatedLapTime`) classified as `"open"`, NOT `"battle"` — this must also pass when `carIdxF2Time` is negative (car has lapped)
  4. **FR-019**: `gap:pulling_away` event emitted (not a state machine arc) when `closingRate > +0.3 s/lap` for 2+ ticks in `battle`/`closing` state; `battleStatus` remains unchanged

**Confirm all tests FAIL before proceeding to implementation.**

### Implementation for User Story 2

- [X] T019 [P] [US2] Implement `apps/hub-server/src/models/fuel-model.ts` — `FuelModelEngine` class (SC-002 hand-computation validates output):
  - Constructor: `{ windowSize?: number, mode?: 'live' | 'observer', carClassId?: number }`
  - `onLapCompletion(fuelAtStart, fuelAtEnd, lapTime, isOutlap, isInlap)`: updates rolling N-lap average, recomputes all FuelModel fields
  - `onPitExit(currentFuelLevel)`: resets `fuelAtLapStart` baseline
  - Level 3 (observer): estimates from `carClassTankCapacity - (lapCompleted × defaultBurnRate)` using hardcoded lookup by `carClassId` from `apps/hub-server/src/models/car-class-defaults.ts`
  - Create `apps/hub-server/src/models/car-class-defaults.ts`: export `CAR_CLASS_DEFAULTS: Record<number, { tankCapacityLiters: number, defaultBurnRatePerLap: number }>`. Initial entries to include (iRacing carClassId integers, verify against iRacing SDK `CarClassID` values at implementation time): GT3 class (e.g., BMW M4 GT3 ≈ class 4074), GTE class (e.g., Ferrari 488 GTE ≈ class 3916), Dallara IR18 prototype (≈ class 67), and Mazda MX-5 Cup (≈ class 2523). Export a `getCarClassDefaults(carClassId: number)` helper that returns the entry or the fallback `{ tankCapacityLiters: 60, defaultBurnRatePerLap: 3.0 }` for unknown classes. **Acceptance criterion** (U3): before merging, confirm at least 4 `carClassId` entries against a live iRacing session or SDK docs; add a `// verified: YYYY-MM-DD` comment to each confirmed entry; unconfirmed IDs MUST use the fallback silently — no thrown errors.
  - Level 2 stub: immediate fall-through to Level 1 behavior (no Postgres reads)
  - `getSnapshot(): FuelModel`: returns all fields including `summary` string; if called before any `onLapCompletion()` event, returns valid zero/low-confidence FuelModel (not null) — `burnRatePerLap: 0`, `fuelDeficit: 0` (no deficit before any data), `confidenceLevel: "low"`, `summary: "Fuel status unknown — no lap data yet"` (U2: `fuelDeficit` must always be a number per T008 type definition — use 0 as the pre-data default)
- [X] T020 [P] [US2] Implement `apps/hub-server/src/models/tire-model.ts` — `TireModelEngine` class:
  - `onLapCompletion(lapTime, isOutlap, isInlap)`: adds to stint lap list, recomputes median, updates 3-lap rolling degradation trend
  - `onPitStop(newCompound)`: resets stint tracking
  - `getSnapshot(): TireModel`
- [X] T021 [P] [US2] Implement `apps/hub-server/src/models/gap-model.ts` — `GapModelEngine` class:
  - `update(field: Record<number, CarState>, sessionState: SessionState): GapEntry[]`: for each adjacent position pair, compute gap/trend/closingRate; apply battle state machine; return entries whose `battleStatus` changed
  - Lapped-car detection: `gapSeconds > 0.8 × sessionState.estimatedLapTime` → classify as `"open"` (90s fallback)
  - `gap:pulling_away` event: emit when pair is in `"battle"` OR `"closing"` and gap trend is increasing — per FR-019 this does NOT change `battleStatus`; only the `resolved` transition (gap > 1.5s for 2+ ticks) changes state

**Checkpoint**: `npm test` — all 13 model unit tests pass.

---

## Phase 4: User Story 1 — Race State Is Live During a Session (Priority: P1)

**Goal**: Hub server reads Redis Streams, builds live in-memory Race State, and writes KV snapshots. Verifiable by querying `hub:race-state:{sessionId}` after injecting synthetic telemetry.

**Independent Test**: Inject session event + 2 laps of telemetry → `redis-cli GET hub:race-state:{sessionId}` returns valid JSON with `hero.fuelLevel`, `field` entries, and `session.sessionPhase`.

### Implementation for User Story 1

- [X] T022 [US1] Implement `apps/hub-server/src/pipeline/session-event-processor.ts` — `SessionEventProcessor`:
  - Consumes `iracing:events:session` Redis Stream via the shared XREADGROUP consumer loop (same mechanism as SessionProcessor, not Pub/Sub); on startup, seed from `XREVRANGE iracing:events:session + - COUNT 1` to catch the latest session before live entries arrive
  - Parse `SessionEvent` JSON from entry `payload` field; update `SessionState` fields (`trackName`, `playerCarIdx`, `sessionType`, `sessionStartWallClock`)
  - When `active === false`: set `sessionPhase = "PostRace"`; set `playerCarIdx = null`
  - Emit `session:phase_change` event when phase changes
  - **Mid-race re-derive**: if `playerCarIdx` changes while `sessionPhase === "Racing"` (driver swap / car reset), update `HeroState` to track the new `carIdx` and emit `source:upgraded` if mode changes from observer to driver (FR-002, edge case from spec)
- [X] T045 [P] [US1] Write `apps/hub-server/tests/unit/pipeline/session-processor.test.ts` — `pitWindowOpen` unit tests (FR-029, SC-007; write first — must FAIL before T023):
  1. `pitWindowOpen === false` when `fuelDeficit > 0` (fuel short — must stop regardless of tires)
  2. `pitWindowOpen === true` when `fuelDeficit === 0` AND `lapAge > 5` (exactly on fuel and old tires)
  3. `pitWindowOpen === false` when `fuelDeficit < 0` AND `degradationSignal === "nominal"` AND `lapAge ≤ 5` (fuel surplus, tires fine)
- [X] T046 [P] [US1] Write FR-006 FieldState seed unit test in `apps/hub-server/tests/unit/pipeline/session-processor.test.ts` (write first — must FAIL before T023 implementation, per Constitution Principle VI): inject synthetic `DriverInfo` with 3 cars but send telemetry for only 1 car → assert all 3 `carIdx` keys appear in `FieldState`; the telemetry car's fields are updated; the other 2 are zero-valued `CarState` entries (not missing keys)
- [X] T023 [US1] Implement `apps/hub-server/src/pipeline/session-processor.ts` — `SessionProcessor` (covers FR-006, FR-007, FR-008, FR-009, FR-010, FR-029); **depends on T045 and T046 FAILing first**:
  - Invoked per `iracing:telemetry:session` batch entry from the consumer loop
  - Parse flattened fields: all `CarIdx*` arrays (via `JSON.parse`) + hero-only fields
  - **FR-006**: On first batch after session start, seed `FieldState` with zero-value `CarState` entries for ALL cars in `DriverInfo` (so cars that have not yet sent telemetry still appear in the field map); unit test for this behavior is owned by T046 — do not duplicate here
  - Update all `CarState` entries in `FieldState`; update `HeroState` when `playerCarIdx` is known
  - **Duplicate position guard**: if two or more cars share the same `CarIdxPosition` value, retain each car's last-known valid position; log `{ duplicatePosition, carIdxes }`
  - **FR-009**: Detect `sessionFlags` bitmask changes → advance `sessionPhase` state machine (`PreSession → Formation → Racing ⇄ Caution → PostRace`) per the transition table in `specs/003-race-state-engine/data-model.md` section "SessionPhase State Machine"
  - **FR-010 (D1)**: On every `sessionPhase` transition detected via `sessionFlags`, call `EventBus.publish()` with `session:phase_change`; guard: compare `previousPhase` against `RaceState.session.sessionPhase` (from `T012` singleton) — only emit if `SessionEventProcessor` has not already advanced the phase (i.e., `previousPhase === RaceState.session.sessionPhase` means no prior emit; skip otherwise)
  - Detect `CarIdxLapCompleted` increments for hero car → call `FuelModelEngine.onLapCompletion()` and `TireModelEngine.onLapCompletion()`; write `hub:fuel-model` and `hub:tire-model` KV snapshots (FR-008)
  - Detect pit road transitions (`CarIdxOnPitRoad` flip) for all cars
  - Detect position changes for all cars
  - Run `GapModelEngine.update()` → store results in `DerivedSignals.activeBattles`
  - **FR-029**: Evaluate `pitWindowOpen` from latest FuelModel + TireModel snapshots: `fuelDeficit ≤ 0 AND (degradationSignal !== "nominal" OR lapAge > 5)`; unit tests for this logic are owned by T045 — do not duplicate here
  - **FR-007**: Call `writeKvSnapshot()` to write `hub:race-state:{sessionId}` at end of each batch (2h TTL)
  - **FR-027 (REQUIRED)**: Emit structured log every cycle: `{ cycleLatencyMs, eventCount, sessionTime }` where `cycleLatencyMs` is mandatory on every cycle; T036 audits for it but does not create it. **Note**: zero-event-cycle logging (FR-028) is owned by T028 — do not duplicate it here
- [X] T024 [US1] Add HTTP API endpoints to `apps/hub-server/src/api.ts`:
  - `GET /api/race-state` → `c.json(getRaceState())`
  - `GET /api/fuel-model` → `c.json(getFuelModelSnapshot())`
  - `GET /api/tire-model` → `c.json(getTireModelSnapshot())`
  - `GET /api/events/recent` → `LRANGE hub:events:ring:{sessionId} 0 19` → parse JSON array
- [X] T025 [US1] Wire `FuelModelEngine`, `TireModelEngine`, `GapModelEngine` instances into `SessionProcessor` — construct once in `startPipeline()`, pass as dependencies; confirm model snapshots are written to KV after first lap completion

**Checkpoint**: Inject `iracing:events:session` + 5 `iracing:telemetry:session` entries via `node scripts/inject-session-telemetry.js` → `curl /api/race-state` returns JSON with `hero.fuelLevel` populated and `session.sessionPhase === "Racing"`.

---

## Phase 5: User Story 3 — Event Bus Notifies Consumers of Race Events (Priority: P1)

**Goal**: All race events are emitted to `hub:events` Pub/Sub channel and written to the ring buffer. Verifiable by subscribing to the channel and injecting triggering telemetry.

**Independent Test**: `redis-cli subscribe hub:events` + inject pit entry → receive `hero:pit_entry` event JSON within one processing cycle.

### Implementation for User Story 3

- [X] T026 [US3] Wire `EventBus.publish()` calls into `SessionProcessor` for all event types (FR-024, FR-025, FR-026):
  - **Event types**: use `specs/003-race-state-engine/contracts/hub-redis-outputs.md` section "Event Catalog" as the authoritative checklist for which events to implement. The inline list below is illustrative — if the contracts doc and this list differ, the contracts doc wins for event types.
  - **Envelope (FR-024)**: every event MUST use the standard envelope `{ type, sessionId, sessionTime, lapNumber, lapDistPct, payload }` regardless of what the contracts doc shows for examples.
  - **Dual publish (FR-024 + FR-025)**: for each event, call `commandConn.publish('hub:events', JSON)` AND `commandConn.lpush('hub:events:ring:{sessionId}', JSON)` + `ltrim(0, 99)` + `expireat(+7200)`. T013's `EventBus.publish()` encapsulates this — do not inline it.
  - Session events: `session:phase_change` (FR-010), `session:flag_yellow`, `session:flag_green`, `session:flag_checkered`, `session:safety_car_deployed`, `session:safety_car_cleared`
  - Hero events: `hero:pit_entry`, `hero:pit_exit`, `hero:position_change`, `hero:blue_flag`, `hero:fuel_critical`, `hero:pit_window_open`, `hero:pace_degradation`
  - Competitor events: `competitor:pit_entry`, `competitor:pit_exit`, `competitor:position_change`
  - Gap events: `gap:closing`, `gap:battle`, `gap:resolved`, `gap:pulling_away` (FR-019: fires when `closingRate > +0.3 s/lap` for 2+ ticks in `battle`/`closing` state)
  - Source/incident: `source:upgraded` (FR-030 — wired from SessionEventProcessor), `hero:incident` stub (FR-031 — wired from LiveProcessor)
- [X] T040 [US3] Implement `SessionEventProcessor` behavioral logic and unit tests in `apps/hub-server/tests/unit/pipeline/session-event-processor.test.ts` with 4 test cases covering FR-002, FR-030 (write tests first — must FAIL before implementation):
  1. **FR-030**: `source:upgraded` event emitted with payload `{ previousSource: "observer", newSource: "driver", lapNumber, sessionTime }` + `FuelModelEngine` transitions Level 3 → Level 1 when `SessionEvent` arrives with `active: true` and previous `source === "observer"`; on transition, `fuelAtLapStart` is initialized to `currentFuelLevel` at the moment of transition (the Level 3 estimated state is discarded — Level 1 starts fresh from the next observed `fuelLevel` reading, so `confidenceLevel` resets to `"low"` until 5 laps accumulate) (A2)
  2. **FR-002**: `sessionPhase` set to `"PostRace"` and `playerCarIdx` set to `null` when `SessionEvent` arrives with `active: false`; assert emitted `session:phase_change` event includes `from` and `to` fields (D1 — both `SessionProcessor` and `SessionEventProcessor` emit this event type; envelope must be consistent)
  3. **FR-002**: Mid-race hero re-derive: if `playerCarIdx` changes while `sessionPhase === "Racing"`, `HeroState` updates to track the new `carIdx` without resetting the session or corrupting `FieldState`
  4. **FR-002**: Startup seed: processor correctly initializes `SessionState` from a synthetic XREVRANGE result with no prior live entries received (track name, playerCarIdx, sessionType all populated)
- [X] T027 [US3] Register `hero:incident` as a valid event type in the EventBus schema/validation in `apps/hub-server/src/pipeline/event-bus.ts` — **schema-only stub**: add the type string to any event type allowlist or discriminated union; do NOT implement or call detection logic here. T030 (Phase 6) implements detection and calls `EventBus.publish()` with this type. T027 and T030 are independent — T027 has NO runtime code dependency on T030; they only share the event type string constant.
- [X] T028 [US3] Add no-event-cycle structured log to `SessionProcessor` when a cycle produces zero events (FR-028): `{ cycleLatencyMs, eventCount: 0, sessionTime }` — confirms no silent failures

**Checkpoint**: Subscribe to `hub:events`. Inject `scripts/inject-pit-entry.js` → receive `hero:pit_entry` event. `redis-cli LRANGE hub:events:ring:{sessionId} 0 4` → returns last 5 events. `GET /api/events/recent` → returns same events as JSON.

---

## Phase 6: User Story 4 — Safe Window Signal Flows at 60 Hz (Priority: P2)

**Goal**: Live Processor evaluates the three-signal safe window condition at 60 Hz and updates `DerivedSignals.safeWindowOpen`. Verifiable via unit tests and HTTP endpoint during a braking sequence replay.

**Independent Test**: All 5 LiveProcessor unit tests pass; `GET /api/race-state` returns `signals.safeWindowOpen: false` during injected braking sequence.

### Tests for User Story 4 (write first — must FAIL before implementation)

- [X] T029 [US4] Write `apps/hub-server/tests/unit/pipeline/live-processor.test.ts` with 7 test cases covering FR-021, FR-022, FR-023, FR-031 (write first — must FAIL before implementation):
  1. **FR-021**: `safeWindowOpen === false` when `|LatAccel| > 0.4g`
  2. **FR-021**: `safeWindowOpen === false` when `Throttle < 0.7`
  3. **FR-021/FR-022**: `safeWindowOpen === false` when brake event occurred within last 150m of travel — two sub-cases: (a) inject N ticks with `deltaTime_s = 1/60` and verify `brakeDistanceBuffer` accumulates to expected distance; (b) inject ticks with `deltaTime_s = 0.018s` (simulating `setInterval` drift above 1/60) and verify buffer accumulates to a different (larger) distance, confirming measured `deltaTime_s` is used not a hardcoded constant (A1)
  4. **FR-021**: `safeWindowOpen === true` when all three conditions satisfied simultaneously
  5. **FR-023**: `safeWindowOpen === false` when `source === "observer"` regardless of signal values (observer mode always returns false)
  6. **[stub]**: `cutWindowOpen === safeWindowOpen` in driver mode (confirms M6-deferred stub equality is maintained; not backed by an FR — this is a regression guard for the stub behavior)
  7. **FR-031**: `hero:incident` event emitted when `|LongAccel| > 3g` followed by speed drop `> 20 m/s` within 0.5s; no event emitted when only the `|LongAccel|` condition is met without the speed drop

**Confirm all 7 tests FAIL before proceeding.**

### Implementation for User Story 4

- [X] T030 [US4] Implement `apps/hub-server/src/pipeline/live-processor.ts` — `LiveProcessor`:
  - `latestLiveTelemetry` shared buffer updated by consumer loop (no blocking)
  - `start()`: initializes `this.lastTickMs = Date.now()` then calls `setInterval(() => { const now = Date.now(); const deltaTime_s = (now - this.lastTickMs) / 1000; this.lastTickMs = now; this.tick(deltaTime_s); }, 16)` — this captures measured elapsed time per tick so `brakeDistanceBuffer` accumulates accurate distance regardless of `setInterval` jitter (I1)
  - `tick(deltaTime_s: number)` (FR-021, FR-022, SC-004): reads buffer; evaluates `|LatAccel| < 0.4g`, `Throttle > 0.7`, `brakeDistanceBuffer >= 150`; updates `brakeDistanceBuffer += speedMs × deltaTime_s` where `speedMs` is iRacing `Speed` in **m/s** (do not divide by 3.6); resets buffer to 0 when `Brake > 0.05`; writes `safeWindowOpen` to `DerivedSignals`; sets `cutWindowOpen = safeWindowOpen` (stub)
  - Observer mode: `source === "observer"` → always write `safeWindowOpen = false`
  - `stop()`: clears interval
- [X] T031 [US4] Wire `LiveProcessor` consumer into the XREADGROUP loop: route `iracing:telemetry:live` entries to `latestLiveTelemetry` buffer (write only the most recent entry — no queue) in `apps/hub-server/src/redis/consumer.ts`

**Checkpoint**: `npm test` — all 22 unit tests pass (5 FuelModel + 6 TireModel + 4 GapModel + 7 LiveProcessor = 22). Inject `scripts/inject-braking-sequence.js` → `GET /api/race-state` returns `signals.safeWindowOpen: false` during braking, `true` after 150m clearance.

---

## Phase 7: User Story 5 — Hub Server Degrades Gracefully Under Failure (Priority: P2)

**Goal**: Hub server survives Redis connection drops and process restarts without requiring manual intervention.

**Independent Test**: Stop Redis for 5 seconds → restore → hub server resumes consuming without restart and without KV gaps.

### Implementation for User Story 5

- [X] T032 [US5] Add exponential backoff reconnection to `apps/hub-server/src/redis/client.ts`: configure ioredis `retryStrategy` with backoff starting at 1s, capped at 15s; log each reconnection attempt as structured entry `{ attempt, delayMs }`
- [X] T033 [US5] Add Redis connection error handling to `apps/hub-server/src/redis/consumer.ts`: on XREADGROUP error, log `{ error, streamName, retryIn }` and wait for backoff before next attempt; do NOT crash the process
- [X] T034 [US5] Verify XAUTOCLAIM restart handling in `apps/hub-server/src/redis/consumer.ts`: ensure `reclaimPendingMessages()` is called before switching to `>` mode on every startup; add log entry `{ reclaimedCount }` to confirm reclaim behavior

### Integration Test

- [X] T035 [US5] Write `apps/hub-server/tests/integration/redis-round-trip.test.ts` with three test cases (requires `REDIS_URL` env var; all skip with `this.skip()` if not set):
  1. **Round-trip** (SC-006): XADD one `iracing:telemetry:session` entry → assert `hub:race-state` KV key written within 200ms and `hub:events` Pub/Sub message received within 200ms of a pit-entry injection
  2. **Restart scenario** (SC-005): start consumer loop, XADD 2 entries, stop the loop (simulate crash) without sending XACK, restart consumer loop → assert XAUTOCLAIM reclaims the pending messages (log entry `{ reclaimedCount: 2 }` emitted) and both entries are processed exactly once (no duplicate events in ring buffer)
  3. **5-lap replay** (SC-001): XADD 5 sequential session telemetry entries each representing one lap completion at 15 Hz cadence → assert each KV snapshot write completes within 67ms of the corresponding XADD (measure wall-clock delta per entry); assert final `hub:fuel-model` snapshot has `confidenceLevel: "high"` and `burnRatePerLap` within ±0.05 of the injected burn rate

- [X] T041 [US5] Write unit tests for consumer infrastructure in `apps/hub-server/tests/unit/redis/consumer.test.ts`:
  1. **XAUTOCLAIM unit test**: mock ioredis XAUTOCLAIM response, verify `reclaimPendingMessages()` calls XAUTOCLAIM with a configurable `idleMs` parameter (not hardcoded 3600000); assert it returns the correct `reclaimedCount` and logs `{ reclaimedCount }`
  2. **XREVRANGE startup seed (C1/FR-002)**: mock ioredis XREVRANGE response, call `streamConsumerLoop()` startup path, assert XREVRANGE is called exactly once with args `iracing:events:session + - COUNT 1` before the first XREADGROUP call; assert the result is passed to the `onSessionEvent` callback
- [X] T042 [P] [US5] Add a performance note comment to `apps/hub-server/tests/integration/redis-round-trip.test.ts` case 3 (5-lap replay): the 5-entry test validates functional correctness; for load validation (SC-001 "100% of simulated session ticks" under realistic conditions), run `node scripts/inject-session-telemetry.js --laps 60 --rate 15` manually and confirm p99 KV write latency ≤ 67ms via hub server logs. Add this command to `specs/003-race-state-engine/quickstart.md` as a new manual validation step after step 9.
- [X] T043 [P] Verify downstream consumer groups from T011 are correctly created: run `redis-cli XINFO GROUPS iracing:telemetry:session` and `redis-cli XINFO GROUPS iracing:telemetry:live` and confirm `hub:racing-engineer` and `hub:stream-engineer` groups appear (FR-004). These groups have no consumers in M3 but must exist so M4 and M6 can consume without M3 code changes. (T011 creates them; this task verifies and adds them to the Phase 2 checkpoint.)

**Checkpoint**: `npm run test:integration` passes (with Redis running). Stop Redis via `redis-cli DEBUG SLEEP 5` → hub server logs reconnection attempts → resumes automatically.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Observability, full typecheck, and quickstart validation.

- [X] T036 [P] Verify all structured log entries in `SessionProcessor`, `LiveProcessor`, `SessionEventProcessor`, and `EventBus` include `emitLatencyMs` or `cycleLatencyMs` (FR-027): audit each `console.log` / logger call; add missing latency fields
- [X] T037 [P] Add OpenTelemetry span for Session Processor cycle latency: wrap the Session Processor tick body in a span `hub.session-processor.cycle` with attribute `eventCount`; use the OTel collector configured in `infra/config/otel/`
- [X] T044 [P] Add OpenTelemetry span for Live Processor cycle latency: wrap the Live Processor 60 Hz tick body in a span `hub.live-processor.cycle` with attribute `safeWindowOpen`; mirrors the Session Processor OTel pattern in T037 (FR-027 applies to all processors)
- [X] T038 Run `npm run build && npm run typecheck` workspace-wide — confirm zero TypeScript errors across `packages/types`, `packages/ui`, `apps/hub-server`, `apps/tauri-client`
- [X] T039 Run quickstart.md validation end-to-end: execute each numbered step in `specs/003-race-state-engine/quickstart.md` and confirm all items in the Validation Checklist pass; additionally verify that every event type in `specs/003-race-state-engine/contracts/hub-redis-outputs.md` Event Catalog can be triggered and observed in `hub:events` during the quickstart replay (catalog coverage check)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 — **BLOCKS all user story phases**
- **Phase 3 (US2 Models)**: Depends on Phase 2 (types + directory structure); can start as soon as T009 passes
- **Phase 4 (US1 Race State)**: Depends on Phase 3 completion (models must exist for processor to call)
- **Phase 5 (US3 Event Bus)**: Depends on Phase 4 (event bus wired into processor)
- **Phase 6 (US4 Safe Window)**: Depends on Phase 2 (Redis consumer) — can run in parallel with Phase 3/4/5
- **Phase 7 (US5 Degradation)**: Depends on Phase 2 (Redis client) + Phase 5 (full pipeline active)
- **Phase 8 (Polish)**: Depends on all user story phases complete

### User Story Dependencies

- **US2 (Models)**: Starts after Foundational (T009) — no dependency on other stories
- **US1 (Race State)**: Starts after US2 (models must exist) — depends on Phase 3
- **US3 (Event Bus)**: Starts after US1 (processor must be wired) — depends on Phase 4
- **US4 (Safe Window)**: Starts after Foundational (T015) — independent of US1/US2/US3 code
- **US5 (Degradation)**: Starts after US3 (full pipeline must be active for integration test)

### Within Each Phase

- Tests MUST be written and confirmed FAILING before model/processor implementation begins (Phases 3 and 6)
- Models before processors (Phase 3 before Phase 4)
- Processors before event bus wiring (Phase 4 before Phase 5)

### Parallel Opportunities

Within **Phase 3** (once T009 passes): T016, T017, T018 can run in parallel; then T019, T020, T021 in parallel

Within **Phase 2** (once T004 done): T006, T007, T008 in parallel; T010, T011, T012, T013 in parallel (different files)

**Phase 6 (US4)** can run in parallel with **Phase 4 (US1)** — `LiveProcessor` and `SessionProcessor` are independent files

---

## Parallel Example: Phase 3 (Model Unit Tests)

```bash
# Launch all three test suites simultaneously (write and confirm FAIL):
Task T016: "Write fuel-model.test.ts with 5 cases"
Task T017: "Write tire-model.test.ts with 6 cases"
Task T018: "Write gap-model.test.ts with 4 cases"

# Then launch all three implementations simultaneously:
Task T019: "Implement fuel-model.ts — FuelModelEngine class"
Task T020: "Implement tire-model.ts — TireModelEngine class"
Task T021: "Implement gap-model.ts — GapModelEngine class"
```

---

## Implementation Strategy

### MVP First (User Stories 1–3 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational — **CRITICAL, blocks everything**
3. Complete Phase 3: US2 Models (with tests)
4. Complete Phase 4: US1 Race State (processor + KV snapshots)
5. Complete Phase 5: US3 Event Bus (event emission wired)
6. **STOP and VALIDATE**: Inject synthetic telemetry → verify `hub:race-state` KV + `hub:events` Pub/Sub
7. Hub server is now a functional Race State Engine — M4 (Racing Engineer) can begin

### Full Delivery

Add Phase 6 (US4 Safe Window) + Phase 7 (US5 Degradation) + Phase 8 (Polish) after MVP validation.

---

## Notes

- All tasks target `apps/hub-server/` unless explicitly prefixed with `packages/types/`
- [P] tasks operate on different files with no cross-dependencies — safe to parallelize
- Story labels map: US1=Race State Live, US2=Derived Models, US3=Event Bus, US4=Safe Window, US5=Graceful Degradation
- Constitution Principle VI requires test-first for all agent decision paths — models qualify; confirm tests FAIL before implementing
- Commit after each checkpoint (end of each phase), not after individual tasks
- Integration tests (T035) require `REDIS_URL` env var; run `docker compose up -d redis` first
- **M9 Compliance Backlog (V1)**: Constitution Principle V requires a Postgres `event_log` audit table for all agent capabilities. M3 defers this to M9 (project-owner sign-off in spec.md Assumptions and plan.md Constitution Check). When M9 planning begins, create a `event_log` table migration task as the first item in the M9 task list to ensure the compliance debt is not silently dropped.
