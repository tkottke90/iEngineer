# Implementation Plan: Race State Engine

**Branch**: `003-race-state-engine` | **Date**: 2026-06-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-race-state-engine/spec.md`

---

## Summary

Build the hub server's telemetry processing pipeline: consume the Redis Streams published by the Tauri client, construct and maintain a live in-memory Race State (SessionState, FieldState, HeroState), run three derived models (Fuel, Tire, Gap) and a 60 Hz Safe Window signal, emit all race events to a Redis Pub/Sub event bus, and snapshot Race State to Redis KV for downstream consumers (Racing Engineer M4, Stream Engineer M6, overlays M8).

The pipeline uses two ioredis connections (consumer for XREADGROUP, command for PUBLISH/SET), two independent processing loops (60 Hz Live Processor, 15 Hz Session Processor), and a YAML Processor triggered on session state changes. All behavioral logic is unit-tested with mocha + chai before any event bus consumers are built.

---

## Technical Context

**Language/Version**: TypeScript 5.6 (hub server) + Node.js 22

**Primary Dependencies**:
- `ioredis` — Redis Streams consumer groups, KV operations, Pub/Sub publish
- `hono` + `@hono/node-server` — existing hub server framework (HTTP endpoints for Race State reads)
- `packages/types` — shared type contracts (RaceState, FuelModel, TireModel, GapModel, RaceEvent)

**New Dependencies** (to be added to `apps/hub-server/package.json`):
- `ioredis` ^5.x — Redis client with XREADGROUP support

**Test Dependencies** (devDependencies):
- `mocha` ^10.x
- `chai` ^4.x
- `@types/mocha`, `@types/chai`

**Storage**: Redis (Streams consumer, KV snapshots, Pub/Sub, List ring buffer) — no Postgres in M3

**Testing**: mocha + chai (unit); mocha + ioredis (integration, requires running Redis)

**Target Platform**: Node.js 22, local LAN, single-instance process

**Performance Goals**:
- Session Processor cycle: ≤ 67ms (15 Hz budget)
- Live Processor tick: ≤ 2ms per callback (60 Hz, setInterval(fn, 16))
- Event emission latency: ≤ one processing cycle from triggering telemetry tick

**Constraints**:
- Two ioredis connections only (consumer + command); no connection pool complexity
- Level 2 Fuel Model: stub no-op; no Postgres reads in M3
- `cutWindowOpen` stub: equals `safeWindowOpen` until M6
- `setsRemaining` in TireModel: -1 sentinel (SDK field not yet in SessionTelemetryData)

**Scale/Scope**: Single session at a time; up to 64 cars (CarIdx max); no horizontal scaling

---

## Constitution Check

*GATE: Must pass before implementation. All items ✅ pass.*

| Principle | Check | Status |
|-----------|-------|--------|
| **I. Real-Time Reliability** | Separate consumer groups for Live and Session Processors. Live Processor (60 Hz) and Session Processor (15 Hz) run independently. No LLM calls in M3. LLM consumers (M4+) will use their own Redis consumer groups (FR-004). | ✅ Pass |
| **II. Workspace Isolation** | All new types added to `packages/types` (not inline in hub-server). Hub server imports via `packages/types`, not direct relative imports. No cross-app imports. | ✅ Pass |
| **III. Agent Autonomy** | No agent decisions in M3. Models expose computed outputs; no autonomous actions taken. Audit log requirement satisfied by FR-027/028 structured logging. | ✅ Pass |
| **IV. Local-First Infrastructure** | All dependencies are local: Redis (Docker Compose), Node.js process. No cloud APIs. | ✅ Pass |
| **V. Observability** | FR-027: structured log per event emitted. FR-028: structured log per no-event cycle. OpenTelemetry traces added for processing cycle latency. Gate: event audit via Redis ring buffer (`hub:events:ring:{sessionId}`, last 100 events, 2h TTL), not Postgres. **Project-owner sign-off**: Postgres `event_log` table is explicitly deferred to M9 (Persistence Layer). The Redis ring buffer satisfies the M3 audit requirement because Postgres is not yet provisioned and the ring buffer provides a 100-event catchup window sufficient for all M3 consumers. This deferral was reviewed and accepted as part of M3 scoping. | ✅ Pass |
| **VI. Test-Backed Change** | All behavioral logic (FuelModel, TireModel, GapModel, LiveProcessor safe window) covered by mocha + chai unit tests before integration. Integration tests for Redis round-trip. `npm run build` and `npm run typecheck` must pass. | ✅ Pass |
| **VII. YAGNI** | Level 2 Fuel Model stubbed (not implemented). `cutWindowOpen` stubbed. `setsRemaining` stubbed. `pitWindowOpen` simple formula (no competitor logic). No Postgres schema. No horizontal scaling. | ✅ Pass |

---

## Project Structure

### Documentation (this feature)

```text
specs/003-race-state-engine/
├── plan.md              ← this file
├── research.md          ← Redis consumer groups, 60Hz loop, connection architecture
├── data-model.md        ← All entities, field sources, update cadences, derived computations
├── quickstart.md        ← Validation scenarios using inject scripts and redis-cli
├── checklists/
│   └── requirements.md
└── contracts/
    └── hub-redis-outputs.md   ← KV keys, event bus channel, ring buffer, HTTP endpoints
```

### Source Code

```text
packages/types/src/
├── race-state.ts        ← ADD: pitWindowOpen to DerivedSignals; estimatedPitDuration to CarState
└── models.ts            ← ADD: summary, timeRemaining to FuelModel

apps/hub-server/
├── package.json         ← ADD: ioredis dep; mocha+chai devDeps; test scripts
├── src/
│   ├── api.ts           ← ADD: GET /api/race-state, /api/fuel-model, /api/tire-model, /api/events/recent
│   ├── pipeline/
│   │   ├── live-processor.ts      ← 60 Hz: safe window signal, incident detection
│   │   ├── session-processor.ts   ← 15 Hz: race state update, model refresh, event detection
│   │   ├── session-event-processor.ts      ← On new `iracing:events:session` stream entry: parse SessionEvent, update SessionState
│   │   └── event-bus.ts           ← PUBLISH to hub:events + LPUSH/LTRIM hub:events:ring:{sessionId}
│   ├── models/
│   │   ├── fuel-model.ts          ← FuelModel computation (Level 1 + Level 3; Level 2 stub)
│   │   ├── tire-model.ts          ← TireModel computation (pace degradation, stint median)
│   │   └── gap-model.ts           ← GapModel per adjacent pair, battle state machine
│   ├── state/
│   │   └── race-state.ts          ← In-memory RaceState, mutation methods, KV snapshot write
│   └── redis/
│       ├── client.ts              ← ioredis connection factory (consumerConn, commandConn)
│       └── consumer.ts            ← XREADGROUP loop, XAUTOCLAIM restart handler, XACK
│
└── tests/
    ├── unit/
    │   ├── models/
    │   │   ├── fuel-model.test.ts  ← 5 cases (burn rate, outlap exclusion, refuel, time-race, Level 3)
    │   │   ├── tire-model.test.ts  ← 6 cases (3 thresholds + 2 boundary values + outlap exclusion)
    │   │   └── gap-model.test.ts   ← 4 cases (battle, resolved, lapped-car, pulling_away — pulling_away is an event not a state arc per FR-019)
    │   └── pipeline/
    │       └── live-processor.test.ts  ← 5 cases (3 false conditions, 1 true, 1 observer-false)
    └── integration/
        └── redis-round-trip.test.ts   ← Inject telemetry → assert event in ring buffer
```

**Structure decision**: New code lives exclusively in `apps/hub-server/src/` under four new subdirectories (`pipeline/`, `models/`, `state/`, `redis/`). The existing `src/api.ts`, `src/routes.ts`, `src/pages/` are untouched except for the `/api/*` route additions to `api.ts`. This preserves the hono-preact page architecture while adding the pipeline as an isolated background service layer.

---

## Implementation Phases

### Phase A — Types Package Extension (prerequisite for all other phases)

Update `packages/types` to add fields required by this milestone. Build and typecheck before proceeding.

1. `packages/types/src/race-state.ts`: Add `pitWindowOpen: boolean` to `DerivedSignals`; add `estimatedPitDuration: number | null` to `CarState`.
2. `packages/types/src/models.ts`: Add `summary: string` and `timeRemaining: number | null` to `FuelModel`.
3. Run `npm run build && npm run typecheck` in `packages/types/`.

**Gate**: All existing consumers of these types still compile (there are none yet in M3, but `packages/ui` may reference them).

---

### Phase B — Redis Infrastructure (consumer + command connections)

1. Add `ioredis` to `apps/hub-server/package.json` dependencies.
2. Implement `src/redis/client.ts`: `createConsumerConnection()` and `createCommandConnection()` — both create `new Redis(config)` from environment variables (`REDIS_URL`, default `redis://localhost:6379`). Export singleton instances.
3. Implement `src/redis/consumer.ts`:
   - `setupConsumerGroups()`: XGROUP CREATE for **all three streams** with `MKSTREAM` and starting offset `$`. Idempotent (catch `BUSYGROUP` error): `iracing:telemetry:live` (group `hub:live-processor`), `iracing:telemetry:session` (group `hub:session-processor`), `iracing:events:session` (group `hub:session-event-processor`). Also creates downstream M4/M6 groups `hub:racing-engineer` and `hub:stream-engineer` on the two telemetry streams (FR-004).
   - `reclaimPendingMessages(idleMs = 30_000)`: XAUTOCLAIM all three streams for idle > `idleMs`; default 30,000ms (30s) so a quick crash-and-restart reclaims unacked messages within seconds (SC-006 "no gap" guarantee). The parameter is configurable for unit testing (T041).
   - `streamConsumerLoop(onLive, onSession, onSessionEvent)`: infinite async loop calling `XREADGROUP ... BLOCK 50 STREAMS iracing:telemetry:live iracing:telemetry:session iracing:events:session > > >`. On each batch: parse entries, route to the appropriate callback by stream name, XACK. On startup: call `onSessionEvent` once with `XREVRANGE iracing:events:session + - COUNT 1` to seed initial SessionState.

**Gate**: Consumer groups appear in `redis-cli XINFO GROUPS iracing:telemetry:live`.

---

### Phase C — In-Memory State + Event Bus

1. Implement `src/state/race-state.ts`:
   - Singleton `RaceState` object with typed mutation methods (e.g., `updateCarState(carIdx, fields)`, `setHeroState(hero)`, `updateSignals(signals)`).
   - `writeKvSnapshot(commandConn, sessionId)`: `commandConn.setex('hub:race-state:...' , 7200, JSON.stringify(state))`.
2. Implement `src/pipeline/event-bus.ts`:
   - `publishEvent(event: RaceEvent)`: `PUBLISH hub:events JSON` + `LPUSH hub:events:ring:{sessionId} JSON` + `LTRIM 0 99` + `EXPIREAT +7200`. Single async function, commandConn.
   - Structured log on each publish: `{type, sessionId, sessionTime, emitLatencyMs}`.

**Gate**: `redis-cli subscribe hub:events` receives a test event published from a unit test.

---

### Phase D — Models (unit-tested first)

Write the unit tests for each model **before** implementing the model. All tests must be in `tests/unit/models/`.

**FuelModel** (`src/models/fuel-model.ts`):
- `FuelModelEngine` class, constructed with `{ windowSize: number }` (default 5).
- `onLapCompletion(fuelAtStart, fuelAtEnd, lapTime, isOutlap, isInlap)` — updates rolling average, recomputes all outputs.
- `onPitExit(currentFuelLevel)` — reset `fuelAtLapStart` baseline.
- `getSnapshot(): FuelModel` — current state including `summary` string.
- Level 3 path: `new FuelModelEngine({ mode: 'observer', carClassId })` — no live fuel reads; uses hardcoded capacity lookup.
- Level 2: `onLapCompletion` checks for a historical prior; if `mode === 'blended'` and no Postgres connection available (M3: always), falls through to Level 1 behavior.

**TireModel** (`src/models/tire-model.ts`):
- `TireModelEngine` class.
- `onLapCompletion(lapTime, isOutlap, isInlap)` — updates stint lap list, computes median, updates `paceDegradationTrend`.
- `onPitStop(newCompound)` — resets all stint tracking.
- `getSnapshot(): TireModel`.

**GapModel** (`src/models/gap-model.ts`):
- `GapModelEngine` class managing a `Map<string, GapEntry>` keyed by `"${lead}-${trail}"`.
- `update(field: Record<number, CarState>, sessionState: SessionState): GapEntry[]` — sort cars by `CarIdxPosition` ascending (stable: lower `carIdx` wins ties per FR-018), form adjacent pairs, compute gap/trend/closingRate. Return entries whose `battleStatus` changed (for event emission). Also return entries that triggered a `gap:pulling_away` event (closingRate > +0.3s/lap for 2+ ticks in `battle`/`closing` state).
- Lapped-car detection: `gapSeconds > 0.8 × sessionState.estimatedLapTime` (defaults to 90s if unavailable).

**Gate**: All unit tests pass before Phase E begins.

---

### Phase E — Processors

**LiveProcessor** (`src/pipeline/live-processor.ts`):
- Maintains a `latestLiveTelemetry` buffer (updated by consumer loop on each XREADGROUP batch, without blocking).
- `start()`: calls `setInterval(tick, 16)`.
- `tick()`: reads `latestLiveTelemetry`, evaluates three safe window conditions, updates `brakeDistanceBuffer`, writes `safeWindowOpen` to in-memory `RaceState.signals`. Emits `hero:incident` event if LongAccel spike pattern detected.
- Observer mode: if `source === "observer"`, always writes `safeWindowOpen = false` (no zones configured in M3).

**SessionEventProcessor** (`src/pipeline/session-event-processor.ts`):
- Triggered by new entries on `iracing:events:session` stream (connection and session events from Tauri).
- Parses `SessionEvent` payload, updates `SessionState` (track, playerCarIdx, sessionType, sessionStartWallClock).
- If session becomes inactive (`active: false`), sets `sessionPhase = PostRace`.

**SessionProcessor** (`src/pipeline/session-processor.ts`):
- Triggered by new entries on `iracing:telemetry:session` stream, via the consumer loop.
- Per tick:
  1. Parse session telemetry fields (CarIdx arrays + hero-only fields).
  2. Update all `CarState` entries in `FieldState`.
  3. Detect pit road transitions (onPitRoad flip) → emit `hero:pit_entry` / `hero:pit_exit` / `competitor:pit_entry` / `competitor:pit_exit`.
  4. Detect position changes → emit `hero:position_change` / `competitor:position_change`.
  5. Detect flag changes → emit session flag events + update `SessionPhase`.
  6. Run `GapModelEngine.update(field)` → emit gap transition events.
  7. On `lapCompleted` increment for hero car: run `FuelModelEngine.onLapCompletion()` + `TireModelEngine.onLapCompletion()` → write KV snapshots.
  8. Evaluate `pitWindowOpen` from latest FuelModel + TireModel.
  9. Update `DerivedSignals.activeBattles` from Gap Model.
  10. Write Race State KV snapshot.
  11. Emit structured log for this cycle (event count, latency).

**Gate**: inject one `iracing:telemetry:session` entry via redis-cli → verify `hub:race-state` KV key is written and `hub:events` channel receives the correct event.

---

### Phase F — HTTP API Endpoints

Add to `src/api.ts` (existing Hono app):

```typescript
app.get('/api/race-state', (c) => c.json(getRaceState()))
app.get('/api/fuel-model', (c) => c.json(getFuelModel()))
app.get('/api/tire-model', (c) => c.json(getTireModel()))
app.get('/api/events/recent', async (c) => {
  const events = await commandConn.lrange(`hub:events:ring:${currentSessionId}`, 0, 19)
  return c.json(events.map(e => JSON.parse(e)))
})
```

All four endpoints serve from in-memory state or Redis with no blocking.

---

### Phase G — Hub Server Entry Point

Wire up the pipeline in `apps/hub-server/src/server-init.ts`. This file exports a `startPipeline()` function called from the hub server's Node entry point (wired into `apps/hub-server/vite.config.ts` or the existing server entry). **Do not add pipeline startup logic to `src/pages/home.server.ts`** — that is the Hono/Preact page handler and must remain unmodified.

1. Create Redis connections.
2. Setup consumer groups (idempotent).
3. Reclaim pending messages.
4. Start SessionEventProcessor (subscribe to session events).
5. Start SessionProcessor consumer loop.
6. Start LiveProcessor interval.
7. Register graceful shutdown: on SIGTERM, stop intervals, close Redis connections, flush any pending logs.

---

### Phase H — Integration Tests

`tests/integration/redis-round-trip.test.ts`:
- Starts consumer loop in-process against a real Redis.
- Injects synthetic `iracing:telemetry:session` entries directly via XADD.
- Asserts: correct `hub:race-state` KV written within 200ms; correct `hub:events` Pub/Sub message received.
- Requires `REDIS_URL` env var to be set; skipped if not present.

---

## Complexity Tracking

No constitution violations. All additions are immediately consumed within this milestone. No speculative infrastructure.

---

## Definition of Done

- [ ] `packages/types` updated and all TypeScript compiles (`npm run build && npm run typecheck` workspace-wide)
- [ ] All unit tests pass: ≥ 32 test cases across FuelModel (5), TireModel (6), GapModel (4), LiveProcessor (7), SessionEventProcessor (4), SessionProcessor pitWindowOpen/T045 (3), SessionProcessor FR-006 FieldState seed/T046 (1), consumer unit tests (T041, ≥2) — no skips
- [ ] Integration test: telemetry → KV snapshot round-trip passes against live Redis
- [ ] `hub:race-state`, `hub:fuel-model`, `hub:tire-model` KV keys written after 5 injected laps
- [ ] Event bus emits `hero:pit_entry` when `CarIdxOnPitRoad` flips for hero car
- [ ] `GET /api/race-state` returns valid JSON matching `RaceState` shape
- [ ] Hub server resumes from correct offset after process restart (no duplicated events)
- [ ] All structured log entries include `emitLatencyMs` (FR-027)
- [ ] `npm run build` passes in `apps/hub-server/`
