# Research: Redis Telemetry Publishing

_Phase 0 output — all NEEDS CLARIFICATION items resolved before Phase 1 design._

---

## 1. Publisher Task Runtime

**Decision**: Use `tauri::async_runtime::spawn` for the publisher tokio task.

**Rationale**: Tauri 2 owns a single tokio runtime under the hood, exposed via `tauri::async_runtime`. Using raw `tokio::spawn` from the app setup closure would panic (no tokio runtime in scope). Using `std::thread::spawn` with `block_on` risks deadlocking Tauri's runtime. `tauri::async_runtime::spawn` is the correct integration point.

**Alternatives considered**: `std::thread::spawn` + `tokio::runtime::Runtime::new()` (own runtime per task) — rejected because it would create a second tokio runtime consuming extra threads and memory; unnecessary given Tauri already provides one.

---

## 2. Watcher–Publisher Coordination

**Decision**: Publisher task reads `AppState.iracing_status` (`watch::Receiver<ConnectionStatus>`) and `AppState.current_session` (`Arc<Mutex<Option<SessionInfo>>>`) directly. No new channels added to AppState.

**Rationale**: The watch channel is already purpose-built for broadcasting connection state changes to multiple readers. `current_session` is already an `Arc<Mutex<...>>` that the publisher can clone and poll cheaply each 16ms tick. Adding a second watch channel for session state is unnecessary complexity.

**Alternatives considered**: `tokio::sync::mpsc` from watcher to publisher — rejected because the watcher is a `std::thread` and crossing the sync/async boundary requires unsafe or cumbersome bridge code; the existing watch + mutex approach avoids this.

Session-change detection: publisher tracks `last_published_session: Option<SessionInfo>` internally and compares on each tick. When the value changes, it publishes a new `SessionEvent`.

---

## 3. SDK Access at 60 Hz

**Decision**: Publisher task calls `IracingSDK::open()` on each 16ms tick when iRacing is connected. Each open() creates an independent mmap view.

**Rationale**: The existing watcher already uses this per-tick open pattern. Two threads opening independent mmap views of the same file is safe (both are read-only for telemetry variables). This avoids threading an `Arc<Mutex<IracingSDK>>` across the sync/async boundary.

**Alternatives considered**: Shared `Arc<Mutex<IracingSDK>>` — rejected because it requires a Mutex lock on every 16ms tick in both the watcher and publisher, adding contention on the hot path, and the IracingSDK object is not designed to be shared (it has mutable internal state for `populate_var_offsets`).

---

## 4. Stream Key Naming

**Decision**:

| Purpose | Stream key |
|---------|-----------|
| Live telemetry (60 Hz) | `iracing:telemetry:live` |
| Session-rate telemetry (15 Hz) | `iracing:telemetry:session` |
| Connection events | `iracing:events:connection` |
| Session events | `iracing:events:session` |

**Rationale**: The `iracing:` namespace prefix scopes keys to this application, prevents collision with other Redis data, and supports future key pattern subscriptions (e.g. `iracing:*` for all project streams). The SC-002 acceptance criterion explicitly names `iracing:telemetry:live` in its XRANGE validation command.

**Alternatives considered**: Flat keys (`telemetry:live`) — rejected because the publisher.rs scaffold uses these and SC-002 contradicts them; `iracing:` prefix wins.

---

## 5. MAXLEN Values

**Decision**: live = 3600, session = 900, events = 100.

**Rationale**: Specified in spec §Assumptions. 3600 entries at 60 Hz = 60 seconds of live data buffer; 900 entries at 15 Hz = 60 seconds of session data. Event streams only need to hold the last few state transitions, so 100 is generous.

---

## 6. Message Wire Format

**Decision**: Two formats by stream type:

- **Telemetry streams** (live, session-rate): flattened Redis Streams key-value pairs — one XADD entry with each iRacing field name as a stream field key and its string-serialized value as the field value. A special `_ts` field carries the Unix epoch milliseconds timestamp.
- **Event streams** (connection, session): single-field XADD entry with key `payload` containing a JSON string. Keeps event schemas evolvable without changing the stream structure.

**Rationale**: Flattened pairs for telemetry let consumers retrieve individual fields with `XRANGE` without deserializing a JSON blob — efficient for consumers that only need a subset. JSON for events is appropriate because events are consumed whole and their schemas may evolve.

---

## 7. Watcher Tick Rate Upgrade

**Decision**: Change `TICK_SLEEP` from 100ms to 16ms. Change `CONNECT_EVERY_N_TICKS` from 5 to 30. Add a `WATCHLIST_EVERY_N_TICKS = 6` constant; watchlist UI update fires every 6th tick (~96ms ≈ 10 Hz, functionally equivalent to current 100ms cadence).

**Rationale**: Live telemetry requires SDK reads at 60 Hz. The watcher loop is the only place that opens the SDK and has access to the full shared memory snapshot. The watchlist UI can run at 10 Hz (every 6 ticks) without visible degradation. Connection polling at 30 × 16ms = 480ms is equivalent to the current 5 × 100ms = 500ms cadence.

---

## 8. Field Classification Rule

**Decision**: Fields are classified based on their rate of change relative to the race state:

- **Live stream (60 Hz)**: fields that change on a per-frame or sub-second basis — vehicle dynamics (speed, RPM, throttle, brake, steering, acceleration), real-time position (LapDistPct, CarIdxLapDistPct), live flags (SessionFlags), sensor data (AirTemp, TrackTemp), and camera tracking fields.
- **Session-rate stream (15 Hz)**: fields that change on a per-lap or per-pit basis — fuel, tire temperatures and wear, lap times, race positions, competitor gaps, incident count, and pit service state.

Every field from `sdk.enumerate_vars()` is assigned to exactly one stream. Fields not explicitly classified fall to session-rate by default (conservative choice — strategy data is never time-critical at 60 Hz). The definitive field-to-stream mapping is in `data-model.md` and implemented as a `const` set in `telemetry/publisher_task.rs`.

---

## 9. TypeScript Types and Testing

**Decision**: Add `packages/types/src/redis-events.ts` for `ConnectionEvent` and `SessionEvent` TypeScript types. Add `mocha`, `chai`, and `@types/mocha`/`@types/chai` as devDependencies in `packages/types`. Add `test` script to `packages/types/package.json`. Tests in `packages/types/test/redis-events.test.ts`.

**Rationale**: Constitution Principle VI mandates mocha+chai for all `packages/types` validators. The types package currently has no test infrastructure. This feature is the first to add validated types to `packages/types` beyond raw type declarations.

**Alternatives considered**: Skipping TypeScript tests (types are simple) — rejected because Principle VI is NON-NEGOTIABLE.

---

## 10. Exponential Backoff Reconnect

**Decision**: Initial delay 100ms, multiplier 2×, ceiling 8s. Implemented via `tokio::time::sleep` in the publisher task's outer reconnect loop. On each failed connection attempt: `warn!` log per FR-013. On successful connection: `info!` log and proceed to snapshot + telemetry.

**Rationale**: Parameters specified verbatim in FR-008. The 8s ceiling ensures reconnect happens within the 10s SC-004 budget even in the worst case (8s delay + connection overhead < 10s).
