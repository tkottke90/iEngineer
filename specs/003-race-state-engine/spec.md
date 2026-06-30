# Feature Specification: Race State Engine

**Feature Branch**: `003-race-state-engine`

**Created**: 2026-06-29

**Status**: Draft

**Input**: User description: "Lets start to build out the Race State Engine (M3 in our Roadmap) next."

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Race State Is Live During a Session (Priority: P1)

A driver starts a race session in iRacing while the hub server is running. Without any manual intervention, the hub server reads the telemetry streams being published by the Tauri client and constructs a continuously updated picture of the race: session phase, all car positions, the hero car's fuel and tire state, and gap relationships between adjacent cars.

**Why this priority**: This is the data foundation. Every downstream feature — Racing Engineer alerts, Stream Engineer cuts, overlays — consumes Race State. Without it, nothing else can be built. It is the first thing that must be provably correct.

**Independent Test**: Start the hub server, run a mock telemetry replay into Redis, and query the Race State KV snapshot. Verify that it correctly reflects the injected data across at least one full simulated lap.

**Acceptance Scenarios**:

1. **Given** the Tauri client is publishing `telemetry:live` and `telemetry:session` to Redis, **When** the hub server starts, **Then** it begins consuming from both streams and updates an in-memory Race State within 100ms of the first message.
2. **Given** a session is active, **When** a new `telemetry:session` message arrives, **Then** the hub writes a Race State KV snapshot to Redis (`hub:race-state:{sessionId}`) within one processing cycle (≤ 67ms, the 15 Hz budget).
3. **Given** no telemetry has arrived for 5 seconds, **When** queried, **Then** the hub's Race State retains the last known values rather than resetting to zero or null.

---

### User Story 2 — Derived Models Compute Correct Strategy Numbers (Priority: P1)

After a few laps of driving, the Fuel Model reports a reliable burn rate and projects how many laps remain on the current load. The Tire Model reports the pace degradation trend relative to the stint median. Both models are updated automatically on each lap completion without any user action.

**Why this priority**: The Fuel and Tire Models are the computational core of the Racing Engineer. If these numbers are wrong, the engineer will give bad advice. Correctness must be validated before any consumer is built on top.

**Independent Test**: Inject a sequence of 5 simulated lap completions with known fuel readings into Redis. Query the Fuel Model snapshot and verify that burn rate, laps remaining, and confidence level match expected values calculated by hand.

**Acceptance Scenarios**:

1. **Given** the hero car completes its first lap with a known `FuelLevel` delta, **When** the Fuel Model processes the lap completion, **Then** the model records the per-lap burn for that lap and reports `confidenceLevel: "low"` (insufficient data for rolling average).
2. **Given** the hero car has completed 5 laps with consistent fuel readings, **When** the Fuel Model is queried, **Then** it reports `burnRateConfidence > 0.8`, a `lapsRemaining` value consistent with the rolling average, and `dataSource: "live"`.
3. **Given** the hero car's last 3 laps are 0.7s slower than the stint median, **When** the Tire Model evaluates, **Then** `degradationSignal` is `"critical"` and `paceDegradationTrend` is approximately `+0.7`.
4. **Given** `source === "observer"` (no live fuel read), **When** the Fuel Model runs, **Then** it operates at Level 3 fidelity, `dataSource: "estimated"`, and `confidenceLevel: "low"`.

---

### User Story 3 — Event Bus Notifies Consumers of Race Events (Priority: P1)

When a meaningful race event occurs — a car enters the pits, a gap closes to battle range, the session phase changes — the hub server emits a structured event to Redis Pub/Sub. Downstream services (Racing Engineer, Stream Engineer) subscribe to the event bus and receive notifications without polling Race State directly.

**Why this priority**: The event bus is the integration contract between the Race State Engine and all consumers. Getting the event payload structure right now prevents a refactor cascade when consumers are built in M4+.

**Independent Test**: Subscribe to the Redis Pub/Sub channel. Inject telemetry that represents a hero car pit entry (CarIdxOnPitRoad flipping from false to true). Verify that a `hero:pit_entry` event is emitted within one processing cycle with the correct payload.

**Acceptance Scenarios**:

1. **Given** `CarIdxOnPitRoad[heroIdx]` transitions from `false` to `true`, **When** the Session Processor runs, **Then** a `hero:pit_entry` event is published to the event bus with `sessionId`, `sessionTime`, `lapNumber`, and `lapDistPct` populated.
2. **Given** two adjacent cars have a gap of 0.8 seconds, **When** the Gap Model evaluates, **Then** a `gap:battle` event is emitted with `leadCarIdx`, `trailCarIdx`, `gapSeconds`, and `battleStatus: "battle"`.
3. **Given** the Session YAML changes to indicate a new session phase, **When** the YAML Processor detects the change, **Then** a `session:phase_change` event is emitted with `from` and `to` phase values.
4. **Given** a consumer subscribes to the event bus after missing some events, **When** querying, **Then** the consumer can reconstruct recent history from the Redis event ring buffer (`hub:events:ring:{sessionId}`, last 100 events). Recovery is limited to the most recent 100 events; full historical replay beyond that window requires Postgres (deferred to M9).

---

### User Story 4 — Safe Window Signal Flows at 60 Hz (Priority: P2)

The Live Processor evaluates the three-signal safe window condition on every `telemetry:live` tick and updates a boolean signal. This signal gates Tier 2 message delivery in the Racing Engineer and is accessible without polling raw telemetry.

**Why this priority**: Safe window accuracy is a correctness requirement for the Racing Engineer. It must be tested with a representative telemetry trace before any message gating logic depends on it. P2 because it is only consumed by the Racing Engineer (M4), which is not built in this milestone.

**Independent Test**: Inject a synthetic 60 Hz trace for one full lap (including a braking zone and a mid-straight section). Verify that `safeWindowOpen` is `false` in the braking zone and `true` in the mid-straight.

**Acceptance Scenarios**:

1. **Given** `|LatAccel| > 0.4g` on the current tick, **When** the Live Processor evaluates, **Then** `safeWindowOpen` is `false`.
2. **Given** `Throttle < 0.7` on the current tick, **When** the Live Processor evaluates, **Then** `safeWindowOpen` is `false`.
3. **Given** a `Brake > 0.05` event occurred within the last 150 meters of travel, **When** the Live Processor evaluates, **Then** `safeWindowOpen` is `false`.
4. **Given** all three conditions are satisfied (`|LatAccel| < 0.4g`, `Throttle > 0.7`, no recent heavy braking), **When** the Live Processor evaluates, **Then** `safeWindowOpen` is `true`.
5. **Given** `source === "observer"` with no Radio Blackout Zones configured for the current track, **When** the Live Processor evaluates, **Then** `safeWindowOpen` is `false` (no Tier 2 delivery permitted until zones are configured).

---

### User Story 5 — Hub Server Degrades Gracefully Under Failure (Priority: P2)

If Redis becomes temporarily unavailable, or the Tauri client stops publishing (iRacing closed), the hub server continues running and resumes processing when the connection is restored — without requiring a manual restart.

**Why this priority**: Graceful degradation is an explicit design principle. The hub must survive transient infrastructure failures that will inevitably occur during real race sessions.

**Independent Test**: Start the hub server consuming from Redis. Stop the Redis connection for 5 seconds, then restore it. Verify the hub server resumes consuming without operator intervention and without losing the current Race State.

**Acceptance Scenarios**:

1. **Given** Redis becomes unreachable, **When** the hub server attempts to read or write, **Then** it logs the failure, retries with exponential backoff, and does not crash.
2. **Given** telemetry publishing stops (iRacing closed mid-session), **When** the session resumes (client reconnects), **Then** the hub server resumes consuming from the correct stream offset and updates Race State without requiring a restart.
3. **Given** the hub server restarts after an unclean shutdown, **When** it reconnects to Redis, **Then** it reads from the last consumed stream offset (using consumer group state), not from the beginning of the stream.

---

### Edge Cases

- What happens when `CarIdxF2Time` returns a value of `0.0` for a car that has lapped the hero car? Gap model must handle lapped-car gaps without misclassifying them as battles.
- What happens when a lap completion event is detected but `FuelLevel` delta is negative (refuel stop)? Fuel model must reset `fuelAtLapStart` baseline without corrupting the rolling average.
- What happens when `SessionLapsRemain` is `-1` (time-based race with no lap limit)? Fuel model must express `lapsRemaining` in time-equivalent terms rather than asserting a lap count.
- What happens when multiple cars have the same `CarIdxPosition` value (e.g., during formation lap or timing anomaly)? Field state must not crash; last-known valid position should be retained.
- What happens when the `session:yaml` changes during a race (driver swap, car reset)? YAML Processor must re-derive the hero `carIdx` and update `HeroState` accordingly.
- What happens when `source === "observer"` but a driving client connects mid-stint? Hub must transition smoothly from Level 3 to Level 1 fuel model fidelity and emit a `source:upgraded` event.
- What happens when `source === "observer"` and no blackout zones are configured? `safeWindowOpen` MUST be `false` — no Tier 2 messages may fire until zones are authored post-session.

## Requirements *(mandatory)*

### Functional Requirements

**Telemetry Ingestion**

- **FR-001**: The hub server MUST consume `telemetry:live` and `telemetry:session` Redis Streams using dedicated consumer groups, one per logical processor (Live Processor, Session Processor).
- **FR-002**: The hub server MUST consume the `iracing:events:session` Redis Stream via consumer group `hub:session-event-processor` (consumer `hub-server-1`) and trigger the Session Event Processor on each new entry. Each entry's `payload` field contains a JSON-serialized `SessionEvent` (active flag, trackName, playerCarIdx, sessionType, wallClockTime). On startup, the processor MUST seed its initial state by reading the most recent entry via `XREVRANGE iracing:events:session + - COUNT 1` before entering the live consumer loop, so that the current session is known even if no new events arrive. This stream is included in `setupConsumerGroups()` and `reclaimPendingMessages()` alongside the telemetry streams.
- **FR-003**: The hub server MUST track the last-consumed offset for each stream and resume from that offset after a restart, using Redis consumer group state.
- **FR-004**: Consumer groups for Racing Engineer and Stream Engineer subscribers MUST be separate, so a backlog in one group cannot starve the other. These groups MUST be created in M3's `setupConsumerGroups()` so that M4 and M6 can begin consuming without modifying M3 code. Stream assignments (I2): `hub:racing-engineer` is created on both `iracing:telemetry:session` AND `iracing:telemetry:live` (M4 needs both for race state and safe window); `hub:stream-engineer` is created on `iracing:telemetry:live` only (M6 streams 60 Hz live data). The authoritative table is in `specs/003-race-state-engine/contracts/hub-redis-outputs.md`.

**Race State Construction**

- **FR-005**: The hub server MUST maintain an in-memory `RaceState` object containing `SessionState`, `FieldState` (all `CarIdx`), `HeroState` (player-only, when `source === "driver"`), and `DerivedSignals`.
- **FR-006**: `FieldState` MUST include all cars reported in `DriverInfo` from the session YAML, even if their telemetry variables are all zero (e.g., cars that have not yet connected).
- **FR-007**: The hub server MUST write a Race State KV snapshot to Redis (`hub:race-state:{sessionId}`) on each Session Processor cycle with a 2-hour TTL.
- **FR-008**: The hub server MUST write Fuel Model and Tire Model snapshots to Redis (`hub:fuel-model:{sessionId}`, `hub:tire-model:{sessionId}`) on each lap completion with a 2-hour TTL.

**Session Phase State Machine**

- **FR-009**: The hub server MUST implement the SessionPhase state machine: `PreSession → Formation → Racing ⇄ Caution → PostRace`. Transitions are driven by the `sessionFlags` bitmask from `iracing:telemetry:session`. The complete flag-to-transition mapping is defined in `specs/003-race-state-engine/data-model.md` (section "SessionPhase State Machine") — that section is **authoritative**; spec.md and data-model.md must be kept in sync if the state machine changes.
- **FR-010**: Phase transitions MUST emit a `session:phase_change` event to the event bus with `from` and `to` fields. **Ownership** (D1): `SessionProcessor` is the authoritative emitter for transitions driven by `sessionFlags` bitmask changes; `SessionEventProcessor` additionally emits this event when `active: false` triggers the `→ PostRace` transition. To prevent double-emission at session end, `SessionProcessor` MUST guard its emit with a check that `sessionPhase` has not already advanced before emitting (i.e., compare `previousPhase !== currentPhase` only when the change was not already applied by `SessionEventProcessor`).

**Fuel Model**

- **FR-011**: The Fuel Model MUST operate at three fidelity levels: Level 1 (live `FuelLevel` read), Level 2 (blended with historical Postgres data — **stubbed as a no-op fall-through in M3; full implementation deferred to M9**), Level 3 (estimated from lap count and car class defaults). In M3, the model operates at Level 1 when `source === "driver"` and Level 3 when `source === "observer"`. **Initial state** (U2): before any lap completes, `getSnapshot()` returns a valid (non-null) `FuelModel` with `burnRatePerLap: 0`, `lapsRemaining: null`, `fuelDeficit: 0`, `confidenceLevel: "low"`, `summary: "Fuel status unknown — no lap data yet"` — downstream consumers MUST handle `lapsRemaining: null` as a sentinel meaning "no data yet."
- **FR-012**: The rolling burn rate average MUST use the last N completed laps (N = 5, configurable via `windowSize` constructor parameter on `FuelModelEngine`). Outlap and inlap MUST be excluded from the average. **Detection** (A3): an outlap is the first lap of a stint — detected when `lapsSinceLastPit === 0` at the time of lap completion; an inlap is any lap where `CarIdxOnPitRoad` flips to `true` before the lap completes — detected by `onPitRoad === true` at the `lapCompleted` increment event. Both `isOutlap` and `isInlap` are derived by `SessionProcessor` before calling `FuelModelEngine.onLapCompletion()`.
- **FR-013**: The Fuel Model MUST expose a pre-formatted `summary` string alongside the structured output, ready for use in voice briefings. Two templates apply:
  - **Lap-based races** (`lapsRemaining !== null`): `"Fuel {status} — {lapsRemaining} laps remaining on current load, you need {lapsToFinish} to finish. {|buffer|}-lap buffer."` where `buffer = lapsRemaining − lapsToFinish` and `|buffer|` means `Math.abs(buffer)` (always displayed as a positive number regardless of sign).
  - **Time-based races** (`lapsRemaining === null`): `"Fuel {status} — {timeRemaining} minutes remaining on current load, you need {timeToFinish} to finish. {|bufferMinutes|}-minute buffer."` where times are formatted as whole minutes using `Math.round()` to the nearest whole minute, and `|bufferMinutes|` means `Math.abs(bufferMinutes)` (A1).
  - In both templates, `status` is `"good"` when `fuelDeficit < 0`, `"tight"` when `fuelDeficit === 0`, or `"critical"` when `fuelDeficit > 0`. The string must be grammatically complete and usable without additional processing.
- **FR-014**: After a pit stop with a detected refuel (FuelLevel increase), the model MUST reset the `fuelAtLapStart` baseline without corrupting the rolling average.
- **FR-015**: When `SessionLapsRemain` is unavailable (time-based race), the Fuel Model MUST express remaining capacity in time-equivalent terms, not lap count.

**Tire Model**

- **FR-016**: The Tire Model MUST compute `paceDegradationTrend` as a 3-lap rolling average of delta-to-stint-median, excluding outlap and inlap.
- **FR-017**: The Tire Model MUST apply the three-state classification using closed/open intervals: `nominal` when `paceDegradationTrend < 0.3s`, `watch` when `0.3s ≤ paceDegradationTrend ≤ 0.6s`, `critical` when `paceDegradationTrend > 0.6s`. Boundary values: exactly 0.3s is `watch` (not `nominal`); exactly 0.6s is `watch` (not `critical`).

**Gap Model**

- **FR-018**: The Gap Model MUST track gap and closure rate for every adjacent pair of cars in position order. "Position order" is determined by `CarIdxPosition` (ascending). When two cars share the same `CarIdxPosition` value, the car with the lower `carIdx` is treated as ahead (stable sort). The `carIdxF2Time` value for the trailing car in each pair provides the gap in seconds.
- **FR-019**: Battle status transitions (`open → closing → battle → resolved`) MUST be evaluated on each Session Processor cycle and emit the corresponding event when a transition occurs. The `resolved` transition requires `gapSeconds > 1.5s` for at least 2 consecutive invocations of `GapModelEngine.update()` in the Session Processor loop (~133ms at 15 Hz), regardless of wall-clock gaps caused by Redis timing variation; this minimum debounce prevents spurious `resolved` events from momentary gap spikes while keeping the signal responsive. The `gap:pulling_away` event is a separate notification — not a state machine arc — emitted when a pair in `battle` or `closing` state shows a gap trend increase of more than `+0.3 s/lap` (i.e., `closingRate > +0.3 s/lap`, where `closingRate` is measured in seconds per lap) for at least 2 consecutive ticks. This threshold prevents noisy single-tick gap fluctuations from triggering the event. It does not change `battleStatus`.
- **FR-020**: The Gap Model MUST correctly handle lapped-car gaps (where `CarIdxF2Time` reports a full-lap gap or a negative value) without classifying them as battles. Detection threshold: if `gapSeconds > 0.8 × sessionState.estimatedLapTime` (default 90s), the pair is classified as `"open"`. **Edge case**: iRacing `CarIdxF2Time` can return negative values when a car has been lapped — negative `gapSeconds` values MUST also be classified as `"open"` (not `"battle"`). Full implementation threshold is defined in `specs/003-race-state-engine/plan.md` Phase D.

**Pit Window Signal**

- **FR-029**: `DerivedSignals.pitWindowOpen` MUST be computed using the Fuel and Tire Models only (no competitor position logic). It is `true` when: `FuelModel.fuelDeficit <= 0` — where `fuelDeficit = fuelToFinish − fuelRemaining`; a value of `0` means exactly enough fuel to finish (zero buffer) and is considered pit-viable; negative values are surplus — AND (`TireModel.degradationSignal !== "nominal"` OR `TireModel.lapAge > 5`). The fuel condition gates whether a pit stop is physically viable; the tire condition gates whether a pit stop is strategically warranted. Competitor-aware pit window reasoning is the Racing Engineer's responsibility in M4.

**Safe Window Signal**

- **FR-021**: The Live Processor MUST evaluate the three-signal safe window condition on every `telemetry:live` tick and update `safeWindowOpen` on `HeroState` and `DerivedSignals`. The three signals are: (1) lateral acceleration, (2) throttle position, and (3) brake history distance buffer — all three defined in FR-022.
- **FR-022**: The 150-meter brake history MUST be maintained as a distance accumulator: on each Live Processor tick, `brakeDistanceBuffer += speed_ms × deltaTime_s`, where `speed_ms` is the iRacing SDK `Speed` variable expressed in **metres per second** (m/s) and `deltaTime_s` is the measured elapsed time since the previous tick in seconds; when `Brake > 0.05` is detected, `brakeDistanceBuffer` resets to 0. The safe window condition passes when `brakeDistanceBuffer >= 150` (metres travelled since last significant brake input). **Unit note**: iRacing `Speed` is natively in m/s — do not divide by 3.6. **Timing note**: `setInterval(fn, 16)` fires at approximately 62.5 Hz; using measured `deltaTime_s` rather than a hardcoded constant (1/60) avoids a systematic ~4% distance underestimate.
- **FR-023**: When `source === "observer"`, the safe window signal MUST be hardcoded to `false` in M3. Zone authoring (UI or file-based configuration of Radio Blackout Zones) is explicitly out of scope for M3; no zone-based logic exists yet. A future milestone will add zone configuration and allow `safeWindowOpen` to become `true` in observer mode when zones are configured — but in M3 the value is always `false` regardless of signal inputs.

**Event Bus**

- **FR-024**: All events MUST be published to a Redis Pub/Sub channel with the standard envelope: `{ type, sessionId, sessionTime, lapNumber, lapDistPct, payload }`.
- **FR-025**: All events MUST also be written to the Redis event ring buffer (`hub:events:ring:{sessionId}`, capped at 100 entries, 2-hour TTL).
- **FR-026**: The hub server MUST implement the full event catalog defined in `specs/003-race-state-engine/contracts/hub-redis-outputs.md` (section "Event Catalog"): session, hero, competitor, and gap events. **Note** (U2): `contracts/hub-redis-outputs.md` is a required artifact for this feature — spec.md is not self-contained with respect to event type definitions; the contracts file is authoritative and must be read alongside this spec.

**Source Transition**

- **FR-030**: When the `source` transitions from `"observer"` to `"driver"` mid-session (a new `SessionEvent` with `active: true` arrives with a non-null `playerCarIdx` when the hub was previously in observer mode), the hub server MUST: (1) emit a `source:upgraded` event to the event bus; (2) transition `FuelModelEngine` from Level 3 to Level 1 fidelity. The `source:upgraded` event payload MUST include `previousSource`, `newSource`, `lapNumber`, and `sessionTime`. **Transition behavior** (C3): on Level 3 → Level 1 transition, `fuelAtLapStart` is initialized to `currentFuelLevel` at the moment of transition (the Level 3 estimated state is discarded); `confidenceLevel` resets to `"low"` until 5 Level 1 laps accumulate.

**Incident Detection**

- **FR-031**: The Live Processor MUST detect on-track incidents by monitoring for a `|LongAccel| > 3g` spike followed by a speed drop of more than 20 m/s within 0.5s. The look-back window is the last 30 Live Processor ticks (~0.5s at ~62.5 Hz); the implementation MUST retain a ring buffer of the last 30 `{ longAccel, speed }` samples and evaluate both conditions against this buffer on every tick. When detected, emit a `hero:incident` event with `severity` (inferred from `|LongAccel|` magnitude using half-open intervals: `"low"` for `[3g, 5g)`, `"medium"` for `[5g, 8g)`, `"high"` for `≥ 8g`; boundary values 5g and 8g are `"medium"` and `"high"` respectively) and `sessionTime` (A2). **M3 implementation note**: this detection logic is a stub — the threshold values are encoded and the event wired into `EventBus.publish()`, but no downstream consumer processes it in this milestone.

**Observability**

- **FR-027**: The hub server MUST emit structured log entries for every event published, including the event type, session time, and processing latency from message receipt to event emission.
- **FR-028**: The hub server MUST log a structured entry for every processing cycle that produces no events (to satisfy the "no silent failures" constitution requirement).

### Key Entities

- **RaceState**: Top-level in-memory object; contains SessionState, FieldState, HeroState, DerivedSignals. Snapshotted to Redis KV at 15 Hz.
- **SessionState**: Session-level context — track, session type, phase, flags, weather, time/lap remaining.
- **FieldState**: Map of `carIdx → CarState` for every car in the session. Updated at 15 Hz from session telemetry and session YAML.
- **HeroState**: Extends CarState with player-only variables (fuel, pedal inputs, sensor data). Only populated when `source === "driver"`.
- **DerivedSignals**: Computed signals consumed directly by Engineers — `safeWindowOpen`, `cutWindowOpen` (stub for M6), `activeBattles`, `pitWindowOpen`.
- **FuelModel**: Self-calibrating burn rate model with three fidelity levels and confidence scoring. Key computed field: `fuelDeficit = fuelToFinish − fuelRemaining` (positive = not enough fuel to finish; negative = surplus). Used by `pitWindowOpen` in FR-029.
- **TireModel**: Lap-age and pace-degradation model for the hero car's current tire set. "Stint median" = the median lap time (in seconds) of all valid (non-outlap, non-inlap) laps completed in the current stint since the last pit stop. Recomputed on each lap completion; excludes the current in-progress lap.
- **GapEntry**: Per-pair gap tracking between adjacent cars, including closure rate and battle status.
- **Event**: Standard envelope for all bus notifications; also written to event ring buffer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The Race State KV snapshot in Redis accurately reflects the injected telemetry within one 15 Hz processing cycle (≤ 67ms) for 100% of simulated session ticks in the integration test suite. **Automated coverage**: T035 case 3 validates this constraint against a 5-lap synthetic set. Full-session load validation (60-lap, 100% of ticks) is performed manually via the quickstart.md load step after step 9 — not covered by the automated test suite.
- **SC-002**: The Fuel Model produces a burn rate within ±0.05 liters/lap of the true value after 5 lap completions, validated against a hand-computed reference on synthetic telemetry.
- **SC-003**: The Gap Model correctly classifies battle status for 100% of transitions in a synthetic 20-car field trace, with no false battle classifications for lapped-car gaps.
- **SC-004**: The Safe Window signal is `false` during every braking zone and `true` during every mid-straight in a reference 60 Hz lap trace, with zero false positives in identified braking zones.
- **SC-005**: Events are emitted within one processing cycle of the triggering telemetry tick for all event types, validated in integration tests using timestamps on stream messages vs. Pub/Sub events.
- **SC-006**: The hub server resumes consuming Redis Streams from the correct offset after a simulated restart with no gap or duplication in the event log.
- **SC-007**: All behavioral logic in the Fuel Model, Tire Model, Gap Model, and Safe Window evaluator is covered by unit tests with `mocha + chai`.

## Assumptions

- The Tauri client (M2) is already publishing correctly shaped `telemetry:live`, `telemetry:session`, and `session:yaml` messages to Redis. The hub server treats these as authoritative and does not re-validate message structure at the ingestion boundary.
- Redis is available on the local network at the configured URL. The hub server does not provision or manage Redis — that is an infrastructure concern handled in `infra/docker-compose.yml`.
- Fuel Model Level 2 (historical Postgres blending) is stubbed as a no-op fall-through in M3. The code path exists but immediately delegates to Level 1 or Level 3. Full blending logic is implemented in M9 alongside the Postgres session write, when historical data is actually available.
- The `cutWindowOpen` signal in `DerivedSignals` is a stub in this milestone — it is computed identically to `safeWindowOpen` for now. Full cut-window logic (minimum dwell, overtake lock, corner blackout) is implemented in M6 when the Stream Engineer is built.
- Car class fuel capacity defaults (used by Level 3 Fuel Model) are sourced from a hardcoded lookup table keyed by `carClassId` (integer). The table is a TypeScript `const` object in `apps/hub-server/src/models/car-class-defaults.ts`. Each entry provides `{ tankCapacityLiters: number, defaultBurnRatePerLap: number }`. The initial table covers the most common car classes; missing entries fall back to `{ tankCapacityLiters: 60, defaultBurnRatePerLap: 3.0 }`. A runtime-editable table is out of scope.
- The event ring buffer (`hub:events:ring:{sessionId}`) is the only durable event record in this milestone. Full Postgres `event_log` persistence is deferred to M9. **Constitution Principle V deferral**: Constitution Principle V requires a Postgres audit table for every new agent capability. M3 satisfies this gate with the Redis ring buffer (last 100 events, 2h TTL) because Postgres is not provisioned until M9 (Persistence Layer). This deferral was explicitly accepted during M3 scoping. The ring buffer provides sufficient catchup coverage for all M3 consumers. Postgres `event_log` will be retroactively compliant when implemented in M9.
- This milestone contains no LLM inference calls. Constitution Principles III and V Postgres audit requirements for LLM interactions apply starting in M4 when the Racing Engineer agent is built.
- The hub server runs as a single Node.js process. Horizontal scaling and multi-instance coordination are out of scope.

## Clarifications

### Session 2026-06-29

- Q: How should `DerivedSignals.pitWindowOpen` be computed in M3? → A: Fuel + Tire Models only — `true` when `fuelDeficit <= 0` AND (`degradationSignal !== "nominal"` OR `lapAge > 5`). No competitor position logic; that belongs to the Racing Engineer in M4.
- Q: When `source === "observer"` and no zones are configured, should `safeWindowOpen` default to `true` or `false`? → A: Default `false` — no Tier 2 messages fire in observer mode until Radio Blackout Zones are explicitly configured for the track.
- Q: Should Fuel Model Level 2 (historical Postgres blending) be fully implemented or stubbed in M3? → A: Stubbed as a no-op fall-through; full blending logic implemented in M9 alongside Postgres session writes.
