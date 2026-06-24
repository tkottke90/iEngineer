# Data Pipeline & Session State Spec

## Purpose

This document defines how raw iRacing telemetry is ingested, categorized, processed, and transformed into the race state that drives the Racing Engineer, Stream Engineer, and overlay system. It is the authoritative reference for the data model, derived computations, and event detection logic.

---

## Mental Model: The Two-Speed Pipeline

The iRacing SDK produces a single 60 Hz data dump. Not all of that data requires 60 Hz processing — driving dynamics signals (brake, throttle, lateral G) need full-rate evaluation for safe window detection and incident classification, while strategic data (lap times, position changes, fuel level) changes meaningfully at a much lower cadence.

The pipeline categorizes all telemetry into two tracks with different processing rates, then runs derivation and event detection on the processed output.

```
iRacing SDK (60 Hz read)
    │
    ▼
Tauri Client
    ├── Live Stream  → Redis (60 Hz)   ← driving dynamics, per-car track position
    └── Session Stream → Redis (15 Hz) ← lap times, positions, flags, fuel
    │
    ▼
Hub Server
    ├── Live Processor  (60 Hz)   → safe window signal, incident detection
    └── Session Processor (15 Hz) → race state update, model refresh, event detection
    │
    ▼
Race State (in-memory + Redis KV snapshot)
    │
    ▼
Event Bus (Redis Pub/Sub)
    │
    ├── Racing Engineer
    ├── Stream Engineer
    ├── Overlay Server
    └── Discord Bridge
```

The Tauri client reads shared memory at 60 Hz on every tick. It downsamples internally before publishing — the Live stream carries only the high-frequency variables, the Session stream carries everything else at one-quarter rate. This keeps Redis write volume manageable without losing any signal fidelity.

---

## Data Classification

### Live Data — 60 Hz

Variables that change meaningfully within a single corner sequence. Safe window detection and incident classification depend on these at full rate.

| Variable | Description | Consumer |
|---|---|---|
| `Brake` | Brake pedal input (0–1) | Safe window, incident |
| `Throttle` | Throttle input (0–1) | Safe window |
| `LatAccel` | Lateral acceleration (m/s²) | Safe window, incident |
| `LongAccel` | Longitudinal acceleration | Incident detection |
| `Speed` | Car speed (m/s) | Safe window context |
| `Gear` | Current gear | Context |
| `SteeringWheelAngle` | Steering input | Context |
| `CarIdxLapDistPct` | Per-car track position (0–1), all cars | Battle detection, cut window |

### Session Data — 15 Hz

Variables that change at lap or stint cadence. Processing every 4th tick is sufficient and keeps hub-side load proportionate.

| Variable | Description | Consumer |
|---|---|---|
| `CarIdxLapCompleted` | Completed lap count per car | Fuel model, stint tracking |
| `CarIdxLastLapTime` | Last completed lap time, per car | Gap model, pace |
| `CarIdxBestLapTime` | Best lap time, per car | Overlay |
| `CarIdxEstTime` | Estimated current lap time | Gap model |
| `CarIdxF2Time` | Gap to leader / relative gap | Gap model |
| `CarIdxOnPitRoad` | Pit road boolean, per car | Event detection |
| `CarIdxPosition` | Race position, per car | Position change events |
| `CarIdxTrackSurface` | On track / pit / garage, per car | Car status |
| `CarIdxTireCompound` | Tire compound, per car | Strategy context |
| `CarIdxFastRepairsUsed` | Fast repair count | Context |
| `FuelLevel` | Fuel remaining (liters) | Fuel model |
| `FuelUsePerHour` | Live burn rate | Fuel model |
| `SessionFlags` | Active race flags | Event detection |
| `SessionTimeRemain` | Time remaining (seconds) | Strategy context |
| `SessionLapsRemain` | Laps remaining | Strategy context |
| `PlayerCarPosition` | Hero car race position | Racing Engineer |
| `PlayerCarDriverIncidentCount` | Incident points | Context |
| `WaterTemp` / `OilTemp` | Engine health | Alert thresholds |
| `LapCurrentLapTime` | Running current lap time | Pace monitoring |
| `LapDeltaToBestLap` | Real-time delta to personal best | Racing Engineer |

### Semi-Static Data — On Change

The Session YAML string in shared memory is updated by iRacing on session events (driver swap, caution, session phase change, etc.). The Tauri client monitors the YAML hash on every tick and publishes a full update to Redis Pub/Sub only when it changes — not on a timer.

- `WeekendInfo` — track name and length, event type, weather configuration
- `SessionInfo` — session list (practice / qualify / race), time and lap limits
- `DriverInfo` — full driver and car roster, team assignments, car class
- `CameraInfo` — available camera groups and positions
- `SplitTimeInfo` — sector boundary definitions by lap distance percentage

---

## Telemetry Ingestion: Tauri → Redis

### Two Redis Streams

Tauri publishes to two separate Redis Streams, downsampled before publish:

**`telemetry:live`** — 60 Hz. Contains only the Live data variables listed above. Small, fast, high-frequency.

**`telemetry:session`** — 15 Hz (every 4th tick). Contains all Session data variables — per-car arrays and player-only fields. Larger payload, much lower volume.

**`session:yaml`** — Redis Pub/Sub channel. Published when the Session YAML hash changes. Contains the full parsed YAML payload as JSON.

Both streams use `MAXLEN ~600` trimming to prevent unbounded growth. At 60 Hz, 600 entries represents 10 seconds of history — sufficient for replay and catchup logic without accumulating hours of raw ticks.

### Message Envelope

All messages on both streams share a common envelope:

```typescript
{
  sessionId: string;       // iRacing subsession ID — primary key for the session
  sessionTick: number;     // iRacing tick counter (monotonic within session)
  sessionTime: number;     // iRacing session time in seconds
  sessionPhase: string;    // Current SessionPhase enum value
  source: "driver" | "observer";  // Determines which player-only fields are populated
  data: Record<string, unknown>;  // Variable payload for this stream
}
```

The `source` field is critical. Player-only variables (`FuelLevel`, pedal inputs, `LatAccel`, etc.) are only valid when `source === "driver"`. When `source === "observer"`, these fields are absent from the payload entirely.

The `sessionId` matches the iRacing subsession ID and is the join key across Redis, Postgres, and the iRacing REST API.

---

## Race State Model

The hub server maintains an in-memory Race State object updated continuously as telemetry arrives. A snapshot is written to Redis Key/Value on each session-cadence update (15 Hz) for consumption by the overlay server and for LLM context assembly.

### Top-Level Structure

```typescript
RaceState {
  session: SessionState
  field: FieldState
  hero: HeroState | null      // null when source === "observer" and no driver data available
  signals: DerivedSignals
}
```

### SessionState

Session-level context that is not car-specific.

```typescript
SessionState {
  sessionId: string
  trackName: string
  trackLengthMeters: number
  sessionType: "practice" | "qualify" | "race"
  sessionPhase: SessionPhase
  lapsTotal: number | null      // null for time-based races
  lapsRemaining: number | null
  timeRemaining: number | null  // seconds
  flags: SessionFlags           // currently active flags
  weather: WeatherState         // air temp, track temp, humidity, wind
  sessionStartWallClock: Date   // real-world time at session start
}
```

**SessionPhase state machine**

Phases are derived from the iRacing `SessionState` variable and flag state:

```
PreSession → Formation → Racing ⇄ Caution → PostRace
```

| Phase | Condition |
|---|---|
| `PreSession` | Session not yet started; cars on grid or in garage |
| `Formation` | Formation or pace lap in progress |
| `Racing` | Green flag, pace car not on track |
| `Caution` | Yellow flag active or safety car deployed |
| `PostRace` | Checkered flag shown |

Phase transitions emit `session:phase_change` events to the event bus.

### FieldState

Per-car state for every car in the session, indexed by `carIdx`.

```typescript
FieldState {
  cars: Map<number, CarState>   // keyed by carIdx
}

CarState {
  carIdx: number
  driverName: string
  carNumber: string
  teamName: string | null
  carClassId: number

  // Live-cadence fields (updated at 60 Hz from CarIdxLapDistPct)
  lapDistPct: number

  // Session-cadence fields (updated at 15 Hz)
  trackSurface: "onTrack" | "pitRoad" | "inGarage" | "notInWorld"
  position: number
  classPosition: number
  lapCompleted: number
  lastLapTime: number | null
  bestLapTime: number | null
  estimatedLapTime: number
  gapToLeader: number           // seconds (from CarIdxF2Time)
  onPitRoad: boolean
  tireCompound: string
  fastRepairsUsed: number

  // Derived by the hub server
  pitEntryTime: number | null   // sessionTime when OnPitRoad → true
  pitExitTime: number | null    // sessionTime when OnPitRoad → false
  lastPitLap: number | null
  lapsSinceLastPit: number
  estimatedPitDuration: number | null   // pitExitTime - pitEntryTime
}
```

### HeroState

Player-specific state, available only when `source === "driver"`. Contains all CarState fields plus player-only variables.

```typescript
HeroState extends CarState {
  // Player-only — absent in observer mode
  fuelLevel: number             // liters remaining (live read)
  fuelUsePerHour: number        // live burn rate from SDK
  brake: number                 // 0–1
  throttle: number              // 0–1
  latAccel: number              // m/s²
  longAccel: number             // m/s²
  speed: number                 // m/s
  gear: number
  waterTemp: number
  oilTemp: number
  incidentCount: number
  lapDeltaToBest: number
  lapCurrentTime: number        // running current lap time

  // Derived
  fuelModel: FuelModel
  tireModel: TireModel
  safeWindowOpen: boolean
}
```

### DerivedSignals

Computed signals that both Engineers consume directly without parsing raw state.

```typescript
DerivedSignals {
  safeWindowOpen: boolean        // Racing Engineer message gate
  cutWindowOpen: boolean         // Stream Engineer cut gate
  activeBattles: Battle[]        // sorted by relevance score (see Gap Model)
  pitWindowOpen: boolean         // true when pitting is strategically viable
}
```

---

## Derived Models

### Fuel Model

The Fuel Model is a self-calibrating estimate of fuel consumption and projected race distance. It is maintained continuously by the hub server and exposed as a callable tool to the Racing Engineer LLM.

Keeping fuel math in deterministic code rather than LLM reasoning produces consistent, reliable strategy numbers. The LLM calls the tool and uses the output; it does not perform fuel arithmetic itself.

#### Fidelity Levels

The model operates at different fidelity levels depending on available data, applied in priority order:

**Level 1 — Live driver data**

Active when `source === "driver"` and `FuelLevel` is populated.

- Tracks `FuelLevel` on each session-cadence tick (15 Hz)
- Computes per-lap consumption on each lap completion: `burnThisLap = fuelAtLapStart − fuelAtLapEnd`
- Maintains a rolling N-lap average burn rate (N = 5 laps, configurable)
- The rolling average smooths out splash-and-dash partial refuels and single-lap anomalies
- After a pit stop with a known refuel, the `fuelAtLapStart` baseline resets automatically

**Level 2 — Blended with historical stint data**

When Level 1 data is accumulating (early in a stint), the model seeds its burn rate estimate from previous stint data stored in Postgres.

- Historical rate acts as a prior; each live lap completion shifts weight toward the live average
- Blend weight: before 3 live laps, historical data dominates; after 5 laps, live data is the primary signal
- Historical data is discarded when conditions differ significantly — wet track, different tire compound, different car configuration. Difference is determined by session metadata comparison, not inference.

**Level 3 — Estimated**

Active when `source === "observer"` or when `FuelLevel` is unavailable (e.g., driver has not yet connected).

- Uses known car class tank capacity × remaining lap estimate to model fuel state
- Applies a track-specific average consumption rate, sourced from historical Postgres data if available or from a hardcoded car class default otherwise
- Blends in any partial live data if the driver connects mid-stint
- Confidence is marked `"low"` and exposed to the Racing Engineer, which reflects it in message phrasing ("based on lap count, roughly X laps remaining — I don't have a live fuel read")

#### Fuel Model Outputs

```typescript
FuelModel {
  burnRatePerLap: number           // liters/lap (rolling average)
  burnRateConfidence: number       // 0–1, increases with lap count
  fuelRemaining: number            // liters (live or estimated)
  lapsRemaining: number            // fuelRemaining / burnRatePerLap
  fuelToFinish: number             // fuel required for all remaining laps
  fuelDeficit: number              // negative = surplus, positive = shortfall
  confidenceLevel: "high" | "medium" | "low"
  dataSource: "live" | "blended" | "estimated"
  lapsSinceCalibration: number     // laps since last live FuelLevel read
}
```

#### As an LLM Tool

The Fuel Model is exposed as a callable tool in the Racing Engineer's LLM context:

```
get_fuel_status() → { model: FuelModel, summary: string }
```

The `summary` field is a pre-formatted natural-language string ready for use in a Tier 3 briefing (e.g., "Fuel is good — 8 laps remaining on current load, you need 6 to finish. 2-lap buffer."). The LLM uses the summary directly rather than formatting the raw numbers itself.

---

### Tire Model

The Tire Model tracks tire state for the hero car in driver mode. The iRacing SDK does not expose real-time per-corner tire temperature or wear in the standard telemetry variables — the model therefore operates on lap count and pace degradation signals rather than direct wear data.

```typescript
TireModel {
  compound: string
  lapAge: number                   // laps completed on current set
  setsRemaining: number            // TireSetsAvailable − TireSetsUsed
  paceDegradationTrend: number     // Δ seconds/lap over last 3 laps vs. stint median
  degradationSignal: "nominal" | "watch" | "critical"
  degradationConfidence: "high" | "medium" | "low"
}
```

**Degradation signal computation:**

On each lap completion, the model computes the delta between the completed lap time and the driver's median lap time for the current stint (excluding outlap and inlap). A 3-lap rolling average of this delta is the degradation trend.

| `paceDegradationTrend` | `degradationSignal` |
|---|---|
| < +0.3s | `nominal` |
| +0.3s to +0.6s | `watch` |
| > +0.6s | `critical` |

This is intentionally coarse. The value of the Tire Model is not precision — it is producing a signal the Racing Engineer can reference in context ("your last 3 laps are 4 tenths slower than your stint median — tires may be going off"). Exact tire wear is inaccessible; pace proxy is the realistic alternative.

The Tire Model is exposed as an LLM-callable tool alongside the Fuel Model.

---

### Gap Model

Tracks relative gaps and closure rates between adjacent cars for both the Racing Engineer (competitor alerts) and Stream Engineer (battle detection and action scoring).

For each pair of adjacent cars in position order:

```typescript
GapEntry {
  leadCarIdx: number
  trailCarIdx: number
  gapSeconds: number             // current gap (from CarIdxF2Time)
  gapTrend: number               // Δ seconds across last 3 lap comparisons
  closingRate: number            // seconds/lap (negative = closing)
  lapsToContact: number | null   // gapSeconds / |closingRate|; null if not closing
  battleStatus: "open" | "closing" | "battle" | "resolved"
}
```

**Battle status transitions:**

| Status | Condition |
|---|---|
| `open` | Gap > 2.0s |
| `closing` | Gap ≤ 2.0s and `closingRate < −0.2s/lap` |
| `battle` | Gap ≤ 1.0s |
| `resolved` | Gap was `battle`, now > 1.5s for 2+ consecutive lap checks |

`closing` and `battle` entries are included in `DerivedSignals.activeBattles`, sorted by relevance score (field position, proximity to hero car).

**Gap computation:** Primary source is `CarIdxF2Time`. Trend is computed by comparing the gap value at the end of the last three lap completions for the trailing car. The 3-lap window smooths single-lap noise from traffic or safety car restarts.

---

### Safe Window Signal

Computed at 60 Hz from Live data. Governs when the Racing Engineer can deliver Tier 2 messages.

A safe window is open when **all three** conditions hold on the current tick:

1. `|LatAccel| < 0.4g` — driver is not in a cornering load
2. `Throttle > 0.7` — driver has passed the apex and is accelerating
3. `Brake < 0.05` for the last 150 meters of travel — no recent heavy braking (distance computed from `Speed × elapsed ticks since last brake event`)

`safeWindowOpen` is a boolean updated on every 60 Hz tick. The Live Processor maintains the 150-meter brake history as a rolling buffer.

**Radio Blackout Zones** supplement this signal. If the hero car's `LapDistPct` falls within a driver-configured blackout zone for the current track, `safeWindowOpen` is forced `false` regardless of the three-signal evaluation.

The Cut Window Signal for the Stream Engineer follows analogous logic applied to the *subject car* in the current shot, evaluated at 60 Hz using that car's `LapDistPct` and the track's corner map. The Street Engineer Behavior Spec defines its specific thresholds.

---

## Event Detection

Events are discrete notifications published to the Redis Pub/Sub event bus when telemetry state crosses a defined condition. The Racing Engineer and Stream Engineer subscribe to the event bus; they do not poll Race State directly for trigger conditions.

### Processing Cadence by Event Category

| Category | Evaluated at | Processor |
|---|---|---|
| Safe window open/close | 60 Hz | Live Processor |
| Incident detection (spin, off-track) | 60 Hz | Live Processor |
| Flag changes, safety car | 15 Hz | Session Processor |
| Position changes | 15 Hz | Session Processor |
| Pit road entry / exit | 15 Hz | Session Processor |
| Gap threshold crossings | 15 Hz | Session Processor |
| Fuel model updates | Per lap completion | Session Processor |
| Tire model updates | Per lap completion | Session Processor |
| Session phase transitions | On Session YAML change | YAML Processor |
| Camera info changes | On Session YAML change | YAML Processor |

### Event Catalog

**Session events**
- `session:phase_change` — includes `from` and `to` phase
- `session:flag_yellow`
- `session:flag_green` — caution period ended
- `session:flag_checkered`
- `session:safety_car_deployed`
- `session:safety_car_cleared`

**Hero car events**
- `hero:pit_entry`
- `hero:pit_exit`
- `hero:position_change` — includes `from` and `to` position
- `hero:incident` — detected from LongAccel spike + speed drop signature
- `hero:blue_flag` — blue flag directed at hero car
- `hero:fuel_critical` — `lapsRemaining < 1.0` at current burn rate
- `hero:pit_window_open` — first lap where pitting is viable based on fuel + tire models and competitor positions
- `hero:pace_degradation` — `TireModel.degradationSignal` transitions to `watch` or `critical`

**Competitor events**
- `competitor:pit_entry` — includes `carIdx`, `lap`
- `competitor:pit_exit` — includes `carIdx`, `lap`, `estimatedPitDuration`
- `competitor:position_change` — includes `carIdx`, `from`, `to`

**Gap / battle events**
- `gap:closing` — `GapEntry.battleStatus` transitions to `closing`; includes `leadCarIdx`, `trailCarIdx`, `gapSeconds`, `lapsToContact`
- `gap:battle` — `GapEntry.battleStatus` transitions to `battle`
- `gap:resolved` — `GapEntry.battleStatus` transitions to `resolved`
- `gap:pulling_away` — gap was `battle` or `closing`, now increasing; includes gap delta

### Event Payload Envelope

All events share a common envelope. Consumers can filter on `type` and access the event-specific data in `payload`.

```typescript
{
  type: string;              // e.g. "hero:pit_entry"
  sessionId: string;
  sessionTime: number;       // iRacing session time at detection
  lapNumber: number;         // hero car lap at time of detection
  lapDistPct: number;        // hero car track position at detection
  payload: Record<string, unknown>;  // event-specific fields
}
```

---

## LLM Context Assembly

When the Racing Engineer calls the LLM for a Tier 3 message or responds to a driver query, it assembles a context payload from the current Race State. This is a structured summary, not a raw state dump — it contains the relevant facts at the relevant level of detail.

### Context Payload

```typescript
{
  session: {
    track: string,
    sessionType: string,
    lapsRemaining: number | null,
    timeRemaining: number | null,
    sessionPhase: SessionPhase,
    activeFlags: string[]
  },
  hero: {
    position: number,
    classPosition: number,
    lapCompleted: number,
    lastLapTime: number | null,
    lapDeltaToBest: number,
    incidentCount: number,
    fuelSummary: string,         // FuelModel.summary (pre-formatted)
    tireSummary: string,         // TireModel natural-language summary
    lapsSinceLastPit: number,
    pitWindowOpen: boolean
  },
  field: FieldEntry[],           // see truncation rules below
  recentEvents: EventSummary[],  // last 5 events, most recent first
  sessionHistory: {
    overridesThisSession: number,
    lastOverrideDescription: string | null,
    significantMoments: string[] // brief narrative entries, max 5
  }
}
```

**Field array composition:**

The `field` array includes:
- P1 if the hero is not P1
- Up to 3 cars directly ahead of the hero in position order
- Up to 3 cars directly behind
- Any car that has entered or exited pit road in the last 3 laps

Total field entries are capped at 12. Within the cap, adjacent cars take priority over pit-active cars.

**Token budget and truncation:**

Context assembly targets a token ceiling (exact value to be calibrated during development against the configured model). If the payload exceeds the ceiling, fields are truncated in this order:

1. `sessionHistory.significantMoments` — reduced to 2 entries
2. `recentEvents` — reduced to 3 entries
3. `field` array — reduced to direct neighbors only (P−1, P+1)
4. `hero.tireSummary` — replaced with compound and lap age only

`session`, `hero.position`, `hero.fuelSummary`, and `hero.pitWindowOpen` are never truncated.

---

## Team Observer Mode

When `source === "observer"`, the hub server operates with a degraded data set. The Race State structure is identical; fields unavailable in observer mode are `null` with an explicit `dataSource: "observer"` annotation on the enclosing model.

### What Changes in Observer Mode

**HeroState** — all player-only variables (`fuelLevel`, `throttle`, `brake`, `latAccel`, etc.) are absent. The Fuel Model degrades to Level 3 (estimated). The Tire Model has no degradation signal — only `compound` and `lapAge` (derived from lap count) are available.

**Safe Window Signal** — without live brake/throttle/LatAccel, the three-signal evaluation cannot run. The signal falls back to a static track section model: zones defined by `LapDistPct` ranges where it is generally safe to deliver messages, authored the same way as Radio Blackout Zones. This is a coarser fallback — the driver should configure it for the specific track.

**Incident Detection** — without `LongAccel` and `Speed` from the player car, hero incident detection is unavailable. The `hero:incident` event is not emitted in observer mode.

### Multi-Client Merging

When multiple team clients are connected and publishing telemetry:

- Each client publishes with its own `source` tag (`"driver"` for the active driver, `"observer"` for all others)
- The hub server identifies the driving client by matching `carIdx` to the active driver in `DriverInfo`
- For all `CarIdx` variables, the driving client's data is used for the active driver's car. Observer clients provide complementary coverage for all other cars
- Player-only variables (`FuelLevel`, pedal inputs, sensor data) are exclusively sourced from the driving client for that car's `carIdx`
- If the driving client disconnects mid-stint, the hub server emits a `source:degraded` event, drops to observer-mode estimates for that car, and notifies the race control UI

In team endurance events, the "active driver" can change on each driver swap. The YAML `DriverInfo` update on swap triggers a re-evaluation of which connected client is the driving client.

---

## State Persistence

### Redis — Ephemeral Session State

Redis holds the live, in-session state. All Redis data is treated as ephemeral — it reflects current race state and is not the system of record.

| Key | Content | TTL |
|---|---|---|
| `race_state:{sessionId}` | Full RaceState JSON snapshot | 2 hours |
| `fuel_model:{sessionId}` | Current FuelModel snapshot | 2 hours |
| `tire_model:{sessionId}` | Current TireModel snapshot | 2 hours |
| `event_ring:{sessionId}` | Ring buffer of last 100 events | 2 hours |
| `audio:{clipId}` | TTS audio clip (MP3 bytes) | 60 seconds |

Redis Streams (`telemetry:live`, `telemetry:session`) use `MAXLEN ~600` trimming. At 60 Hz, 600 entries = ~10 seconds of history.

### Postgres — Durable Session Record

At session end (on `session:phase_change` to `PostRace`, or on graceful hub shutdown), the hub server writes a durable session record. This is the data needed for post-session debrief and cross-session calibration.

| Table | What is written |
|---|---|
| `sessions` | Session metadata: sessionId, track, date, session type, final positions, duration |
| `stint_fuel_data` | Per-stint burn rate actuals — used as priors for future sessions at same track/car |
| `tire_stint_data` | Per-stint compound, lap age, and degradation signal observations |
| `event_log` | Full event history for the session — all events with full payloads |
| `engineer_decisions` | All Racing Engineer recommendations: what was recommended, whether the driver acted, and the observable outcome |

**What is not written:**
- Raw 60 Hz telemetry ticks — too large, not needed for debrief
- TTS audio clips — ephemeral by design
- LLM inference call logs — cost and latency data is captured via OpenTelemetry; full prompt/response pairs are not stored

The post-session iRacing REST API call (for full lap-by-lap data) is scheduled after the `PostRace` event. That data is fetched and stored separately in Postgres for the debrief screen and is not part of the live session pipeline.

### Session Lifecycle

**Pre-session**
- Hub server starts, loads broadcast plan from Postgres
- Awaits first telemetry tick from Tauri client
- On first YAML publish, initializes Session State (track, driver roster, session type)
- Seeds Fuel Model burn rate from historical Postgres data if a matching track/car record exists

**Session active**
- Redis Streams ingesting Live and Session telemetry
- Live Processor updating safe window signal at 60 Hz
- Session Processor updating Race State and emitting events at 15 Hz
- Derived models updating on lap completions
- Race State snapshot written to Redis KV on each Session Processor tick

**Post-race (checkered flag)**
- `session:flag_checkered` event emitted
- Racing Engineer delivers end-of-race summary (Tier 3)
- Hub server writes session record to Postgres
- iRacing REST API call queued for full lap data
- Redis keys continue to exist through TTL (not immediately cleared — debrief screen may still be reading them)

**Session ended or hub shutdown**
- Any in-flight Postgres writes are flushed
- Redis connection closed cleanly
- If shutdown is unclean (crash), session record is written on next startup from Redis ring buffer before keys expire

---

## What the Pipeline Does Not Do

- **Record raw telemetry at 60 Hz.** No IBT-style continuous recording. If session replay or raw logging becomes a future need, it is a separate opt-in feature with its own storage path.
- **Handle more than one active session simultaneously.** The hub server manages one session at a time. Multiple concurrent iRacing sessions on different machines are not a supported configuration.
- **Validate or reject iRacing data.** All SDK values are treated as authoritative. Anomalous values (e.g., a fuel level spike after a stop) are smoothed by the derived models but not filtered at the ingestion layer.
- **Push state to overlays.** Overlays pull from hub-served HTTP endpoints on their own refresh timer. The pipeline writes to Redis and serves HTTP; it does not maintain WebSocket connections for overlay data updates (only for the race control UI).
- **Infer driver intent.** The pipeline detects events from observable telemetry. It does not attempt to predict what the driver will do — that reasoning lives in the Racing Engineer's LLM context.
