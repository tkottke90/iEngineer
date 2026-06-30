# Data Model: Race State Engine

**Feature**: `003-race-state-engine`  
**Date**: 2026-06-29

All types defined here map directly to `packages/types/src/`. Fields marked **[NEW]** are additions required by this milestone; fields marked **[EXISTS]** are already defined in the types package.

---

## Types Package Changes

### `packages/types/src/race-state.ts`

**DerivedSignals** — add `pitWindowOpen` **[NEW]**

```typescript
export interface DerivedSignals {
  safeWindowOpen: boolean;   // [EXISTS] 60Hz live signal
  cutWindowOpen: boolean;    // [EXISTS] stub = safeWindowOpen in M3
  activeBattles: ActiveBattle[];  // [EXISTS]
  pitWindowOpen: boolean;    // [NEW] Fuel+Tire model signal (FR-020a)
}
```

**CarState** — add `estimatedPitDuration` **[NEW]**

```typescript
export interface CarState {
  // ... all existing fields ...
  estimatedPitDuration: number | null;  // [NEW] pitExitTime - pitEntryTime (seconds)
}
```

### `packages/types/src/models.ts`

**FuelModel** — add `summary` and `timeRemaining` **[NEW]**

```typescript
export interface FuelModel {
  // ... all existing fields ...
  summary: string;             // [NEW] Pre-formatted briefing string (FR-013)
  timeRemaining: number | null; // [NEW] Fuel-equivalent time remaining (for time-based races)
}
```

---

## In-Memory State

The hub server maintains one `RaceState` object in memory, updated continuously. It is never persisted directly to disk — Redis KV is the read-through cache.

### RaceState (top-level)

```typescript
interface RaceState {
  session: SessionState;
  field: Record<number, CarState>;   // keyed by carIdx
  hero: HeroState | null;            // null when source === "observer"
  signals: DerivedSignals;
}
```

### SessionState

Derived from the `iracing:events:session` stream and `session:yaml` (future). In M3, seeded from the `SessionEvent` published by the Tauri client.

| Field | Source | Notes |
|-------|--------|-------|
| `sessionId` | `SessionEvent.ts` (used as unique key) | String representation of wall-clock timestamp from first event |
| `trackName` | `SessionEvent.track_name` | |
| `trackLengthMeters` | Session YAML `WeekendInfo.TrackLength` | Parsed from YAML (future); default 0 until YAML available |
| `sessionType` | `SessionEvent.session_type` | |
| `sessionPhase` | Derived from `SessionFlags` bitmask | State machine: PreSession → Formation → Racing ⇄ Caution → PostRace |
| `lapsTotal` | Session YAML `SessionInfo.SessionLaps` | null for time-based races |
| `lapsRemaining` | `sessionTelemetry.sessionLapsRemain` | null when -1 (time-based) |
| `timeRemaining` | `sessionTelemetry.sessionTimeRemain` | seconds |
| `flags` | `sessionTelemetry.sessionFlags` | Bitmask; use `SessionFlags` const for decoding |
| `weather` | Session YAML `WeekendInfo` | Stub zeros until YAML processor reads it |
| `sessionStartWallClock` | `SessionEvent.ts` | Unix ms of first active session event |
| `estimatedLapTime` | `carIdxEstTime[heroIdx]` from session telemetry | Seconds; defaults to 90 if unavailable; used by GapModel lapped-car detection threshold |

### CarState (per car, all cars)

Seeded from `iracing:events:session` driver list; updated at 15 Hz from `iracing:telemetry:session` CarIdx arrays.

| Field | Source | Update cadence |
|-------|--------|----------------|
| `carIdx` | Index into CarIdx arrays | Static (session lifetime) |
| `driverName` | SessionEvent / YAML DriverInfo | On-change |
| `carNumber` | SessionEvent / YAML DriverInfo | On-change |
| `teamName` | YAML DriverInfo | On-change |
| `carClassId` | YAML DriverInfo | Static |
| `lapDistPct` | `carIdxLapDistPct[carIdx]` from live stream | 60 Hz |
| `trackSurface` | `carIdxTrackSurface[carIdx]` | 15 Hz |
| `position` | `carIdxPosition[carIdx]` | 15 Hz |
| `classPosition` | `carIdxClassPosition[carIdx]` | 15 Hz |
| `lapCompleted` | `carIdxLapCompleted[carIdx]` | 15 Hz |
| `lastLapTime` | `carIdxLastLapTime[carIdx]` | 15 Hz |
| `bestLapTime` | `carIdxBestLapTime[carIdx]` | 15 Hz |
| `estimatedLapTime` | `carIdxEstTime[carIdx]` | 15 Hz |
| `gapToLeader` | `carIdxF2Time[carIdx]` | 15 Hz |
| `onPitRoad` | `carIdxOnPitRoad[carIdx]` | 15 Hz |
| `tireCompound` | `carIdxTireCompound[carIdx]` | 15 Hz |
| `fastRepairsUsed` | `carIdxFastRepairsUsed[carIdx]` | 15 Hz |
| `pitEntryTime` | Derived: sessionTime when `onPitRoad` flips true | On event |
| `pitExitTime` | Derived: sessionTime when `onPitRoad` flips false | On event |
| `lastPitLap` | Derived: `lapCompleted` at pit entry | On event |
| `lapsSinceLastPit` | Derived: `lapCompleted - lastPitLap` | 15 Hz |
| `estimatedPitDuration` | Derived: `pitExitTime - pitEntryTime` | On pit exit |

### HeroState (extends CarState)

Only populated when `source === "driver"`. Hero car identified by `playerCarIdx` from `SessionEvent`.

| Field | Source | Notes |
|-------|--------|-------|
| `fuelLevel` | `sessionTelemetry.fuelLevel` | Liters |
| `fuelUsePerHour` | `sessionTelemetry.fuelUsePerHour` | Live SDK burn rate |
| `brake` / `throttle` | `liveTelemetry.brake` / `liveTelemetry.throttle` | 60 Hz |
| `latAccel` / `longAccel` | `liveTelemetry.latAccel` / `liveTelemetry.longAccel` | 60 Hz |
| `speed` | `liveTelemetry.speed` | m/s, 60 Hz |
| `gear` | `liveTelemetry.gear` | 60 Hz |
| `waterTemp` / `oilTemp` | `sessionTelemetry.waterTemp` / `oilTemp` | 15 Hz |
| `incidentCount` | `sessionTelemetry.incidentCount` | 15 Hz |
| `lapDeltaToBest` | `sessionTelemetry.lapDeltaToBestLap` | 15 Hz |
| `lapCurrentTime` | `sessionTelemetry.lapCurrentLapTime` | 15 Hz |
| `safeWindowOpen` | Derived by Live Processor | 60 Hz |

---

## Derived Models

### FuelModel

Maintained by `FuelModelEngine`. Updated on each lap completion (`lapCompleted` increment detected).

| Field | Computation | Notes |
|-------|-------------|-------|
| `burnRatePerLap` | Rolling N-lap average of per-lap `fuelLevel` delta | N = 5 (configurable). Outlap + inlap excluded. |
| `burnRateConfidence` | `min(lapCount / N, 1.0)` | 0→1 as laps accumulate |
| `fuelRemaining` | Latest `fuelLevel` (Level 1) or estimated (Level 3) | |
| `lapsRemaining` | `fuelRemaining / burnRatePerLap` | null if time-based race |
| `timeRemaining` | `(fuelRemaining / burnRatePerLap) * avgLapTime` | For time-based races |
| `fuelToFinish` | `lapsRemaining_race * burnRatePerLap` | Uses `sessionLapsRemain` |
| `fuelDeficit` | `fuelToFinish - fuelRemaining` | Negative = surplus |
| `confidenceLevel` | `"low"` < 3 laps; `"medium"` 3–4; `"high"` 5+ | |
| `dataSource` | `"live"` (Level 1) or `"estimated"` (Level 3) | Level 2 = stub no-op in M3 |
| `lapsSinceCalibration` | Laps since last live `fuelLevel` read | |
| `summary` | Pre-formatted string, e.g. "Fuel good — 8 laps remaining, 2-lap buffer." | Built by model from above fields |

**Outlap/inlap detection**: A lap is an outlap if `lapsSinceLastPit === 0`. A lap is an inlap if `onPitRoad` is true at the end of the lap (detected by `onPitRoad` flip during the same lap). Both are excluded from the rolling average.

**Refuel detection**: On each pit exit, if `fuelLevel_current > fuelLevel_at_pit_entry`, a refuel is inferred. `fuelAtLapStart` baseline resets to `fuelLevel_current`. Rolling average is not reset (historical burn rate remains valid).

**Level 3 (observer mode)**: `fuelRemaining` = `carClassTankCapacity - (lapCompleted * avgBurnRatePerLap)`. Car class capacity sourced from hardcoded lookup table. `avgBurnRatePerLap` defaults to car class default if no Level 1 data exists.

### TireModel

Maintained by `TireModelEngine`. Updated on each lap completion.

| Field | Computation |
|-------|-------------|
| `compound` | `carIdxTireCompound[heroIdx]` |
| `lapAge` | Laps completed since last pit stop (`lapsSinceLastPit`) |
| `setsRemaining` | From SDK (not yet in `SessionTelemetryData`; default -1 in M3) |
| `paceDegradationTrend` | 3-lap rolling average of (lapTime - stintMedian). Excludes outlap/inlap. |
| `degradationSignal` | `nominal` (< 0.3s), `watch` (0.3–0.6s), `critical` (> 0.6s) |
| `degradationConfidence` | `"low"` < 3 laps in stint; `"medium"` 3–4; `"high"` 5+ |

**Stint median**: Median lap time (seconds) of all valid laps completed in the current stint (since last pit stop). "Valid" means: not an out-lap (`lapsSinceLastPit > 0`) AND not an in-lap (`onPitRoad` was not true at lap end). The current in-progress lap is excluded (not yet completed). Recomputed on each lap completion. If fewer than 2 valid laps exist, `paceDegradationTrend` is 0 and `degradationSignal` is `"nominal"` until enough data exists.

### GapModel (per adjacent pair)

Maintained by `GapModelEngine`. One `GapEntry` per adjacent position pair. Updated at 15 Hz.

| Field | Computation |
|-------|-------------|
| `leadCarIdx` | Car at position P |
| `trailCarIdx` | Car at position P+1 |
| `gapSeconds` | `carIdxF2Time[trailCarIdx]` (relative gap to car ahead) |
| `gapTrend` | Δ gap across last 3 lap completions of trailing car: `gapSeconds_now − gapSeconds_3_laps_ago` (negative = closing) |
| `closingRate` | `gapTrend / 3` (seconds/lap average); computed from **lap-over-lap gap snapshots** sampled at each `lapCompleted` increment of the trailing car — not from tick-level gap deltas. This means `closingRate` is updated at most once per lap completion, not 15 times per second. |
| `lapsToContact` | `gapSeconds / abs(closingRate)` if `closingRate < 0`; else null |
| `battleStatus` | State machine (see below) |

**Adjacency sort key**: Cars are sorted by `CarIdxPosition` ascending. Ties (duplicate position values) are broken by `carIdx` ascending (lower `carIdx` = ahead). This produces a stable ordering for adjacent-pair construction even during formation laps or timing anomalies.

**Battle status state machine**:

| From | To | Condition |
|------|----|-----------|
| `open` | `closing` | `gapSeconds ≤ 2.0` AND `closingRate < −0.2s/lap` |
| `closing` | `battle` | `gapSeconds ≤ 1.0` |
| `battle` | `resolved` | `gapSeconds > 1.5` for 2+ consecutive 15 Hz checks (~133ms debounce) |
| `resolved` | `open` | `gapSeconds > 2.0` |
| any | `open` | Car positions change (pair no longer adjacent) |

**`gap:pulling_away` event** (not a state arc): emitted when a pair in `battle` or `closing` state has `closingRate > +0.3s/lap` for at least 2 consecutive ticks. Does not change `battleStatus`. The +0.3s/lap threshold prevents single-tick gap fluctuations from generating spurious events.

**Lapped-car handling**: If `carIdxF2Time[trailCarIdx]` is negative or represents a full-lap gap, the pair is classified as `open`. Threshold: if `gapSeconds > (0.8 × estimatedLapTime)`, treat as lapped (90s default).

### DerivedSignals

Updated at 60 Hz (safe window) and 15 Hz (everything else).

| Field | Source | Update |
|-------|--------|--------|
| `safeWindowOpen` | Live Processor: LatAccel < 0.4g AND Throttle > 0.7 AND no brake > 0.05 in last 150m | 60 Hz |
| `cutWindowOpen` | Stub: equals `safeWindowOpen` in M3 (I3: no formal FR for this field; M6 deferral — zone-based cut window logic is out of scope until Stream Engineer milestone) | 60 Hz |
| `activeBattles` | GapModel: all pairs where `battleStatus` is `closing` or `battle` | 15 Hz |
| `pitWindowOpen` | `fuelDeficit ≤ 0` AND (`degradationSignal !== "nominal"` OR `lapAge > 5`) | Per lap completion |

---

## Safe Window — Rolling Distance Buffer

The Live Processor maintains a distance accumulator for the brake history check:

```
brakeDistanceBuffer: number   // meters since last Brake > 0.05 event
```

On each 60 Hz tick:
- `brakeDistanceBuffer += speed_ms × (1/60)` (distance this tick = speed × tick duration)
- If `Brake > 0.05`: reset `brakeDistanceBuffer = 0`
- Safe window condition 3: `brakeDistanceBuffer ≥ 150`

---

## SessionPhase State Machine

Transitions derived from `sessionFlags` bitmask on each 15 Hz tick.

```
PreSession  →  Formation   when startGo or startReady flag set
Formation   →  Racing      when green flag set and pace car not on track
Racing      →  Caution     when caution or cautionWaving flag set
Caution     →  Racing      when green flag set after caution cleared
Racing      →  PostRace    when checkered flag set
Caution     →  PostRace    when checkered flag set
```

On transition, emit `session:phase_change` event to event bus. **Ownership** (D1): `SessionProcessor` owns `session:phase_change` emissions driven by `sessionFlags` bitmask changes; `SessionEventProcessor` emits the same event type on `active: false` to signal PostRace. Both emitters MUST include `from` and `to` fields in the payload. To prevent double-emission, `SessionProcessor` MUST NOT emit `session:phase_change` when the phase transition was already triggered by `SessionEventProcessor` (guard: check if `sessionPhase` has already changed before emitting).

---

## Event Catalog (Redis Pub/Sub: `hub:events`)

All events use the `RaceEvent` envelope from `packages/types/src/events.ts`.

### Emitted by Session Processor (15 Hz evaluation)

| Event type | Trigger condition | Key payload fields |
|---|---|---|
| `session:phase_change` | SessionPhase state machine transition | `from`, `to` |
| `session:flag_yellow` | `caution` or `cautionWaving` flag set | — |
| `session:flag_green` | `green` flag set after caution cleared | — |
| `session:flag_checkered` | `checkered` flag set | — |
| `session:safety_car_deployed` | Pace car on track (inferred from `caution` + field spread) | — |
| `session:safety_car_cleared` | Pace car off track after caution | — |
| `hero:pit_entry` | `onPitRoad[heroIdx]` flips true | `lapNumber`, `lapDistPct` |
| `hero:pit_exit` | `onPitRoad[heroIdx]` flips false | `lapNumber`, `estimatedPitDuration` |
| `hero:position_change` | `position[heroIdx]` changes | `from`, `to` |
| `hero:blue_flag` | `blue` flag in `sessionFlags` | — |
| `hero:fuel_critical` | `FuelModel.lapsRemaining < 1.0` | `lapsRemaining`, `fuelRemaining` |
| `hero:pit_window_open` | `DerivedSignals.pitWindowOpen` transitions false→true | `lapAge`, `fuelDeficit` |
| `hero:pace_degradation` | `TireModel.degradationSignal` transitions to `watch` or `critical` | `signal`, `trend` |
| `competitor:pit_entry` | `onPitRoad[carIdx]` flips true (non-hero car) | `carIdx`, `lapNumber` |
| `competitor:pit_exit` | `onPitRoad[carIdx]` flips false (non-hero car) | `carIdx`, `lapNumber`, `estimatedPitDuration` |
| `competitor:position_change` | `position[carIdx]` changes (non-hero) | `carIdx`, `from`, `to` |
| `gap:closing` | `battleStatus` transitions to `closing` | `leadCarIdx`, `trailCarIdx`, `gapSeconds`, `lapsToContact` |
| `gap:battle` | `battleStatus` transitions to `battle` | `leadCarIdx`, `trailCarIdx`, `gapSeconds` |
| `gap:resolved` | `battleStatus` transitions to `resolved` | `leadCarIdx`, `trailCarIdx` |
| `gap:pulling_away` | Gap was `battle`/`closing`, now increasing | `leadCarIdx`, `trailCarIdx`, `gapDelta` |

### Emitted by Live Processor (60 Hz evaluation)

| Event type | Trigger condition | Notes |
|---|---|---|
| `hero:incident` | `longAccel` spike AND speed drop | Candidate: \|LongAccel\| > 3g followed by speed drop > 20 m/s within 0.5s |
