# Contract: Redis Streams Interface

_Defines the publisher/consumer boundary for all four Redis Streams produced by the Tauri client._

---

## Streams Summary

| Stream key | Rate | MAXLEN | Content |
|-----------|------|--------|---------|
| `iracing:events:connection` | On-change | 100 | `ConnectionEvent` JSON payloads |
| `iracing:events:session` | On-change | 100 | `SessionEvent` JSON payloads |
| `iracing:telemetry:live` | 60 Hz | 3600 | Flattened iRacing SDK fields (dynamics + position) |
| `iracing:telemetry:session` | 15 Hz | 900 | Flattened iRacing SDK fields (strategy + condition) |

---

## Event Streams

### `iracing:events:connection`

**Publisher**: Tauri client (`telemetry/publisher_task.rs`)

**Trigger**: iRacing connection state transitions; also emitted as a snapshot on Redis connect/reconnect (FR-009 paths b/c).

**Entry format**:
```
Entry ID: auto-generated (XADD *)
Fields:
  payload  →  JSON string (see ConnectionEvent schema)
```

**ConnectionEvent JSON schema**:
```json
{
  "status": "Connected" | "Disconnected",
  "ts": <unix_epoch_ms>
}
```

**Example entry** (from `XRANGE iracing:events:connection - + COUNT 1`):
```
1) 1719619200000-0
2) 1) "payload"
   2) "{\"status\":\"Connected\",\"ts\":1719619200123}"
```

---

### `iracing:events:session`

**Publisher**: Tauri client (`telemetry/publisher_task.rs`)

**Trigger**: Session starts, session type changes, session ends, iRacing disconnects. Also emitted as snapshot on Redis connect/reconnect when iRacing is Connected (FR-009 path c).

**Entry format**:
```
Entry ID: auto-generated (XADD *)
Fields:
  payload  →  JSON string (see SessionEvent schema)
```

**SessionEvent JSON schema** (active session):
```json
{
  "active": true,
  "track_name": "Watkins Glen Boot",
  "player_car_name": "BMW M4 GT3",
  "player_car_idx": 3,
  "session_type": "Race",
  "wall_clock_time": "14:32:07",
  "ts": 1719619200123
}
```

**SessionEvent JSON schema** (no session / ended):
```json
{
  "active": false,
  "ts": 1719619200456
}
```

**Invariant**: `track_name`, `player_car_name`, `player_car_idx`, `session_type`, `wall_clock_time` are ONLY present when `active: true`. When `active: false` the JSON contains only `active` and `ts`. Consumers MUST NOT assume these fields are present when `active` is false.

**`player_car_idx` usage**: This is the CarIdx for the broadcasting player. Consumers use it to index into all `CarIdx*` arrays in the telemetry streams (e.g. `CarIdxLapDistPct[player_car_idx]` to get the player's track position). It is stable for the duration of a session.

---

## Telemetry Streams

### `iracing:telemetry:live`

**Publisher**: Tauri client (`telemetry/publisher_task.rs`)

**Rate**: ≥ 60 msg/s (16ms tokio interval); best-effort, drop-on-full semantics

**Active condition**: Published only while iRacing is Connected AND `current_session` is `Some` (active session YAML present)

**Entry format**:
```
Entry ID: auto-generated (XADD *)
Fields:
  _ts         → Unix epoch milliseconds (string)
  <FieldName> → string-serialized value for each live-stream field
  ...
```

**Numeric fields**: serialized as decimal strings (e.g. `"42.37"`, `"6800"`, `"-0.12"`).

**Boolean fields**: `"true"` or `"false"`.

**Array fields**: JSON array string (e.g. `"[0.12, 0.45, 0.0, ...]"` for CarIdxLapDistPct).

**Example** (partial entry):
```
1) 1719619200123-0
2)  1) "_ts"
    2) "1719619200123"
    3) "Speed"
    4) "42.37"
    5) "RPM"
    6) "6800"
    7) "Gear"
    8) "4"
    9) "Throttle"
   10) "0.82"
   11) "Brake"
   12) "0.0"
   ...
```

---

### `iracing:telemetry:session`

**Publisher**: Tauri client (`telemetry/publisher_task.rs`)

**Rate**: ≥ 15 msg/s (every 4th live tick via Downsampler)

**Active condition**: Same as live stream

**Entry format**: Identical structure to live stream (flattened key-value pairs + `_ts`). Fields are the session-rate subset (fuel, tires, lap times, positions, gaps — see `data-model.md`).

---

## Publisher Guarantees

1. **Delivery**: Best-effort. Individual entries may be lost under Redis backpressure or connection drops. Consumers MUST handle gaps.
2. **Ordering**: Monotonically increasing entry IDs within each stream (Redis guarantee).
3. **No replay**: The publisher does NOT buffer or retransmit missed frames after reconnect. On reconnect, it publishes a current-state snapshot for event streams, then resumes live publishing.
4. **Snapshot on connect**: On Redis connect/reconnect, the publisher emits a `ConnectionEvent` and (if a session is active) a `SessionEvent` to give new subscribers a baseline before the telemetry stream starts.
5. **Suppression**: Telemetry is NOT published when `current_session` is `None` (main menu / lobby state), regardless of iRacing connection status.

## Consumer Notes

- Subscribe with `XREAD COUNT 100 BLOCK 0 STREAMS iracing:telemetry:live $` for low-latency streaming.
- Use `XREAD ... STREAMS iracing:telemetry:live iracing:telemetry:session $` to multiplex both streams in one call.
- The `_ts` field in telemetry entries is the publisher-side system clock, not the Redis server clock. Use Redis entry IDs (which use the Redis server clock) for ordering; use `_ts` only for wall-clock timing analysis.
- Event stream consumers should use the most recent entry from `iracing:events:connection` and `iracing:events:session` as the initial state baseline when connecting. Query with `XREVRANGE iracing:events:connection + - COUNT 1`.
