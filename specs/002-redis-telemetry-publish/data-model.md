# Data Model: Redis Telemetry Publishing

_Phase 1 output. Defines the four publishable entities and the field-to-stream classification._

---

## Entities

### ConnectionEvent

Published to `iracing:events:connection` whenever iRacing connection state changes, and as a snapshot on Redis connect/reconnect (FR-009).

```json
{
  "status": "Connected" | "Disconnected",
  "ts": 1719619200000
}
```

| Field | Type | Notes |
|-------|------|-------|
| `status` | string enum | `"Connected"` or `"Disconnected"` |
| `ts` | number | Unix epoch milliseconds (system clock) |

**State transitions that trigger emission**:
- iRacing opens while client is running → `Connected`
- iRacing closes or crashes → `Disconnected`
- Redis publisher connects/reconnects → snapshot of current status (FR-009 paths b/c)

---

### SessionEvent

Published to `iracing:events:session` when a session begins, the session type changes, or the session ends. Also published as a snapshot on Redis connect/reconnect when iRacing is Connected (FR-009 path c).

**Active session** (`active: true`):
```json
{
  "active": true,
  "track_name": "Watkins Glen Boot",
  "player_car_name": "BMW M4 GT3",
  "player_car_idx": 3,
  "session_type": "Race",
  "wall_clock_time": "14:32:07",
  "ts": 1719619200000
}
```

**No session / session ended** (`active: false`):
```json
{
  "active": false,
  "ts": 1719619200000
}
```

| Field | Type | Notes |
|-------|------|-------|
| `active` | boolean | `true` when a session YAML is present in SDK; `false` when `current_session` is `None` |
| `track_name` | string | Only when `active: true`; from `WeekendInfo.TrackName` |
| `player_car_name` | string | Only when `active: true`; from `DriverInfo.Drivers[0].CarScreenNameShort` |
| `player_car_idx` | number | Only when `active: true`; from `DriverInfo.DriverCarIdx` (root-level integer in the session YAML — more reliable than `Drivers[0].CarIdx` which is not guaranteed to be the player in multi-driver teams). The CarIdx for the broadcasting player — used to index into all `CarIdx*` arrays in the telemetry streams. |
| `session_type` | string | Only when `active: true`; from `WeekendInfo.EventType` (Practice / Qualify / Race / etc.) |
| `wall_clock_time` | string | Only when `active: true`; HH:MM:SS system clock at emission |
| `ts` | number | Unix epoch milliseconds |

**Triggers**:
- Session YAML first appears in SDK → `active: true` event
- Session type changes (no intermediate `active: false` — watcher overwrites `current_session` in place) → `active: true` with new type
- Session ends / iRacing disconnects → `active: false` event
- FR-009: Redis reconnect while iRacing Connected + `current_session` is `Some` → full `active: true` snapshot
- FR-009: Redis reconnect while iRacing Connected + `current_session` is `None` → `active: false` snapshot

---

### LiveTelemetryFrame

Published to `iracing:telemetry:live` at ≥ 60 Hz during an active session. This information si directly related to the _player_ or active user. Wire format: flattened Redis Streams key-value pairs. Each XADD entry contains one key per iRacing field plus a `_ts` timestamp field.

```
XADD iracing:telemetry:live MAXLEN ~ 3600 *
  _ts     1719619200123
  Speed   42.37
  RPM     6800
  Gear    4
  Throttle 0.82
  Brake   0.0
  SteeringWheelAngle  -0.12
  ...
```

**Live stream fields** (published at 60 Hz):

| Category | Field names |
|----------|------------|
| Vehicle dynamics | `Speed`, `RPM`, `Gear`, `Throttle`, `Brake`, `SteeringWheelAngle` |
| Acceleration | `LatAccel`, `LongAccel`, `VertAccel` |
| Velocity | `VelocityX`, `VelocityY`, `VelocityZ` |
| Orientation | `Yaw`, `Pitch`, `Roll`, `YawRate`, `PitchRate`, `RollRate` |
| Hero position | `LapDistPct`, `LapDist` |
| Session state | `SessionTime`, `SessionTick`, `PlayerCarIdx`, `SessionFlags` |
| On-track state | `IsOnTrack`, `IsInGarage`, `OnPitRoad` |
| Camera | `CamCarIdx`, `CamGroupNumber`, `CamCameraNumber` |
| All-car position | `CarIdxLapDistPct` (array), `CarIdxTrackSurface` (array) |
| All-car dynamics | `CarIdxGear` (array), `CarIdxRPM` (array), `CarIdxSteer` (array) |
| Weather (live) | `AirTemp`, `TrackTemp`, `TrackWetness`, `WeatherDeclaredWet` |

Array fields are serialized as JSON arrays (e.g. `"[0.12, 0.45, ...]"`).

**Naming convention**: Field names in the live stream table above match iRacing SDK field names exactly — including capitalization (e.g. `PlayerCarIdx`, `SessionFlags`). These differ from the snake_case convention used in event payloads (`player_car_idx` in `SessionEvent`). Both conventions are correct in their respective contexts: SDK names are used as Redis Streams keys verbatim; snake_case names appear only in JSON event payloads serialized by the Rust structs in `data-model.md §Rust Types`.

**Note**: All fields available from `sdk.enumerate_vars()` that are not in the session-rate set are published on the live stream. The live stream is the default for unclassified fields.

---

### SessionTelemetryFrame

Published to `iracing:telemetry:session` at ≥ 15 Hz (every 4th live tick via `Downsampler`) during an active session. Same flattened key-value wire format as the live stream.

**Session-rate stream fields** (published at 15 Hz):

| Category | Field names |
|----------|------------|
| Fuel | `FuelLevel`, `FuelLevelPct`, `FuelUsePerHour` |
| Coolant / oil | `WaterTemp`, `OilTemp`, `OilPress` |
| Tire temps (LF) | `LFtempCL`, `LFtempCM`, `LFtempCR` |
| Tire temps (RF) | `RFtempCL`, `RFtempCM`, `RFtempCR` |
| Tire temps (LR) | `LRtempCL`, `LRtempCM`, `LRtempCR` |
| Tire temps (RR) | `RRtempCL`, `RRtempCM`, `RRtempCR` |
| Tire wear (LF) | `LFwearL`, `LFwearM`, `LFwearR` |
| Tire wear (RF) | `RFwearL`, `RFwearM`, `RFwearR` |
| Tire wear (LR) | `LRwearL`, `LRwearM`, `LRwearR` |
| Tire wear (RR) | `RRwearL`, `RRwearM`, `RRwearR` |
| Lap timing | `LapCurrentLapTime`, `LapLastLapTime`, `LapBestLapTime`, `LapDeltaToBestLap`, `LapDeltaToOptimalLap` |
| Session remaining | `SessionTimeRemain`, `SessionLapsRemain` |
| Hero position | `PlayerCarClassPosition`, `PlayerCarPosition`, `IncidentCount` |
| All-car positions | `CarIdxPosition` (array), `CarIdxClassPosition` (array) |
| All-car laps | `CarIdxLap` (array), `CarIdxLapCompleted` (array) |
| All-car timing | `CarIdxLastLapTime` (array), `CarIdxBestLapTime` (array), `CarIdxEstTime` (array), `CarIdxF2Time` (array) |
| All-car status | `CarIdxOnPitRoad` (array), `CarIdxTireCompound` (array), `CarIdxFastRepairsUsed` (array) |
| Pit service | `PitSvFlags`, `PitOptRepairLeft`, `PitRepairLeft` |

---

## Classification Rule

```
if field_name IN SESSION_RATE_FIELDS:
    → iracing:telemetry:session  (15 Hz)
else:
    → iracing:telemetry:live     (60 Hz, default)
```

`SESSION_RATE_FIELDS` is defined as a `const HashSet<&str>` in `telemetry/publisher_task.rs`. Every field returned by `sdk.enumerate_vars()` is published to exactly one stream per tick.

---

## TypeScript Types (`packages/types/src/redis-events.ts`)

```typescript
export interface ConnectionEvent {
  status: 'Connected' | 'Disconnected';
  ts: number; // Unix epoch milliseconds
}

export interface SessionEvent {
  active: boolean;
  ts: number;
  track_name?: string;
  player_car_name?: string;
  player_car_idx?: number;
  session_type?: string;
  wall_clock_time?: string;
}
```

Validators for these types (used by hub server to assert incoming Redis messages are well-formed) live in `packages/types/src/redis-events.ts` and are tested with mocha+chai in `packages/types/test/redis-events.test.ts`.

---

## Rust Types (`apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs`)

```rust
#[derive(Serialize)]
pub struct ConnectionEventPayload {
    pub status: &'static str, // "Connected" | "Disconnected"
    pub ts: u64,              // Unix epoch milliseconds
}

#[derive(Serialize)]
pub struct SessionEventPayload {
    pub active: bool,
    pub ts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_car_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_car_idx: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wall_clock_time: Option<String>,
}
```

Both serialized to JSON string and stored as the `payload` field in the respective event stream entries.
