# Contract: Hub Server Redis Outputs

_Defines all Redis keys, channels, and data structures written by the hub server's Race State Engine. Consumers (Racing Engineer M4, Stream Engineer M6, Overlay Server M8) read from these contracts._

---

## Key Namespace

The hub server uses the `hub:` prefix for all keys it writes. The Tauri client uses `iracing:` — no conflicts.

---

## KV Snapshots (Redis String, JSON-serialized)

Written by the Session Processor on each 15 Hz cycle. All keys have a 2-hour TTL, reset on each write.

### `hub:race-state:{sessionId}`

Full `RaceState` snapshot. Shape: `packages/types/src/race-state.ts → RaceState`.

**Written**: Every 15 Hz Session Processor tick (≤ 67ms latency from telemetry receipt).

**Example** (abbreviated):
```json
{
  "session": {
    "sessionId": "1719619200123",
    "trackName": "Watkins Glen Boot",
    "trackLengthMeters": 3700,
    "sessionType": "Race",
    "sessionPhase": "Racing",
    "lapsTotal": 30,
    "lapsRemaining": 18,
    "timeRemaining": null,
    "flags": 4
  },
  "field": {
    "3": {
      "carIdx": 3,
      "driverName": "Thomas Kottke",
      "position": 4,
      "lapCompleted": 12,
      "onPitRoad": false,
      "gapToLeader": 14.3,
      "lapsSinceLastPit": 12
    }
  },
  "hero": {
    "carIdx": 3,
    "fuelLevel": 22.4,
    "safeWindowOpen": true,
    "...": "all CarState fields plus player-only fields"
  },
  "signals": {
    "safeWindowOpen": true,
    "cutWindowOpen": true,
    "pitWindowOpen": false,
    "activeBattles": [
      { "leadCarIdx": 7, "trailCarIdx": 3 }
    ]
  }
}
```

**Read by**: Racing Engineer (M4), Stream Engineer (M6), Overlay Server (M8), Race Control Center UI (M7).

---

### `hub:fuel-model:{sessionId}`

Current `FuelModel` snapshot. Shape: `packages/types/src/models.ts → FuelModel` (including `summary` field added in M3).

**Written**: On each lap completion event.

**Example**:
```json
{
  "burnRatePerLap": 2.8,
  "burnRateConfidence": 0.9,
  "fuelRemaining": 22.4,
  "lapsRemaining": 8,
  "timeRemaining": null,
  "fuelToFinish": 16.8,
  "fuelDeficit": -5.6,
  "confidenceLevel": "high",
  "dataSource": "live",
  "lapsSinceCalibration": 0,
  "summary": "Fuel is good — 8 laps remaining on current load, you need 6 to finish. 2-lap buffer."
}
```

**Read by**: Racing Engineer (M4) as LLM tool `get_fuel_status()` result.

---

### `hub:tire-model:{sessionId}`

Current `TireModel` snapshot. Shape: `packages/types/src/models.ts → TireModel`.

**Written**: On each lap completion event.

**Example**:
```json
{
  "compound": "Soft",
  "lapAge": 12,
  "setsRemaining": -1,
  "paceDegradationTrend": 0.15,
  "degradationSignal": "nominal",
  "degradationConfidence": "high"
}
```

**Read by**: Racing Engineer (M4) as LLM tool `get_tire_status()` result.

---

## Event Ring Buffer (Redis List)

### `hub:events:ring:{sessionId}`

A capped list of the last 100 `RaceEvent` JSON entries. Used by late-joining consumers to catch up on recent session history.

**Written**: LPUSH after each event publish; LTRIM to 100 entries; EXPIREAT reset to +2h.

**Structure**: Each element is a JSON-serialized `RaceEvent` (see `packages/types/src/events.ts`). Index 0 is the most recent.

**Read with**:
```
LRANGE hub:events:ring:{sessionId} 0 99
```

**TTL**: 2 hours from last write.

---

## Event Bus (Redis Pub/Sub)

### Channel: `hub:events`

All `RaceEvent` structs are published here as JSON strings. Consumers subscribe to this single channel and filter by `event.type`.

**Published by**: Session Processor and Live Processor on each detected state transition.

**Message format**: JSON-serialized `RaceEvent`:
```json
{
  "type": "hero:pit_entry",
  "sessionId": "1719619200123",
  "sessionTime": 1842.3,
  "lapNumber": 12,
  "lapDistPct": 0.02,
  "payload": {
    "lapNumber": 12
  }
}
```

**Consumer pattern** (ioredis):
```javascript
const sub = new Redis(config);
sub.subscribe('hub:events');
sub.on('message', (channel, message) => {
  const event = JSON.parse(message);
  // filter on event.type
});
```

**Delivery guarantee**: At-most-once (Pub/Sub is fire-and-forget). Consumers that need catch-up should read `hub:events:ring:{sessionId}` on connect, then subscribe to `hub:events` for live delivery.

---

## Consumer Group Setup (hub server internal)

The hub server creates these consumer groups at startup (XGROUP CREATE ... MKSTREAM):

| Stream | Group | Consumer | Starting offset |
|--------|-------|----------|-----------------|
| `iracing:telemetry:live` | `hub:live-processor` | `hub-server-1` | `$` (new entries only) |
| `iracing:telemetry:session` | `hub:session-processor` | `hub-server-1` | `$` (new entries only) |
| `iracing:events:session` | `hub:session-event-processor` | `hub-server-1` | `$` (new entries only) |
| `iracing:telemetry:session` | `hub:racing-engineer` | _(none in M3)_ | `$` (created for M4 — Racing Engineer reads session telemetry) |
| `iracing:telemetry:live` | `hub:stream-engineer` | _(none in M3)_ | `$` (created for M6 — Stream Engineer reads live 60 Hz data) |
| `iracing:telemetry:live` | `hub:racing-engineer` | _(none in M3)_ | `$` (created for M4 — Racing Engineer also reads live data for safe window) |

On restart, XAUTOCLAIM reclaims pending messages with idle time > `idleMs` (default **30,000ms / 30s**, configurable) before switching to `>` for live consumption. The 30s default ensures a quick crash-and-restart reclaims unacknowledged messages within seconds (SC-006 "no gap" guarantee). The `idleMs` parameter is exposed for unit testing (T041). On startup, the session-event-processor seeds initial `SessionState` via `XREVRANGE iracing:events:session + - COUNT 1` (FR-002).

---

## Event Catalog

All events published to `hub:events` use the `RaceEvent` envelope from `packages/types/src/events.ts`. The `type` field is the canonical event discriminator. FR-026 defers to this section as the authoritative list.

### Emitted by Session Processor (15 Hz evaluation)

| Event type | Trigger | Key payload fields |
|---|---|---|
| `session:phase_change` | SessionPhase state machine transition | `from`, `to` |
| `session:flag_yellow` | `caution` or `cautionWaving` flag set | — |
| `session:flag_green` | `green` flag set after caution cleared | — |
| `session:flag_checkered` | `checkered` flag set | — |
| `session:safety_car_deployed` | Pace car on track | — |
| `session:safety_car_cleared` | Pace car off track after caution | — |
| `hero:pit_entry` | `onPitRoad[heroIdx]` flips true | `lapNumber`, `lapDistPct` |
| `hero:pit_exit` | `onPitRoad[heroIdx]` flips false | `lapNumber`, `estimatedPitDuration` |
| `hero:position_change` | `position[heroIdx]` changes | `from`, `to` |
| `hero:blue_flag` | `blue` flag in `sessionFlags` | — |
| `hero:fuel_critical` | `FuelModel.lapsRemaining < 1.0` | `lapsRemaining`, `fuelRemaining` |
| `hero:pit_window_open` | `DerivedSignals.pitWindowOpen` transitions false→true | `lapAge`, `fuelDeficit` |
| `hero:pace_degradation` | `TireModel.degradationSignal` transitions to `watch` or `critical` | `signal`, `trend` |
| `competitor:pit_entry` | `onPitRoad[carIdx]` flips true (non-hero) | `carIdx`, `lapNumber` |
| `competitor:pit_exit` | `onPitRoad[carIdx]` flips false (non-hero) | `carIdx`, `lapNumber`, `estimatedPitDuration` |
| `competitor:position_change` | `position[carIdx]` changes (non-hero) | `carIdx`, `from`, `to` |
| `gap:closing` | `battleStatus` transitions to `closing` | `leadCarIdx`, `trailCarIdx`, `gapSeconds`, `lapsToContact` |
| `gap:battle` | `battleStatus` transitions to `battle` | `leadCarIdx`, `trailCarIdx`, `gapSeconds` |
| `gap:resolved` | `battleStatus` transitions to `resolved` | `leadCarIdx`, `trailCarIdx` |
| `gap:pulling_away` | Gap `closingRate > +0.3 s/lap` for 2+ ticks in `battle`/`closing` state | `leadCarIdx`, `trailCarIdx`, `gapDelta` |
| `source:upgraded` | FuelModel data source transitions Level 3 → Level 1 (FR-030) | `previousSource`, `newSource`, `lapNumber`, `sessionTime` |

### Emitted by Live Processor (60 Hz evaluation)

| Event type | Trigger | Key payload fields |
|---|---|---|
| `hero:incident` | `\|longAccel\| > 3g` followed by speed drop > 20 m/s within 0.5s (FR-031 stub) | `longAccel`, `speedDrop`, `sessionTime` |

---

## HTTP Endpoints (hub server, for polling consumers)

The hub server exposes these routes for consumers that prefer HTTP over Redis direct access.

| Method | Path | Response | Description |
|--------|------|----------|-------------|
| `GET` | `/api/race-state` | `RaceState` JSON | Latest in-memory Race State (no Redis round-trip) |
| `GET` | `/api/fuel-model` | `FuelModel` JSON | Latest Fuel Model |
| `GET` | `/api/tire-model` | `TireModel` JSON | Latest Tire Model |
| `GET` | `/api/events/recent` | `RaceEvent[]` JSON | Last 20 events from ring buffer |

These endpoints serve the Overlay Server (M8) and Race Control Center (M7) which may prefer HTTP over direct Redis access. They are read-only projections of in-memory state — no database round-trips.
