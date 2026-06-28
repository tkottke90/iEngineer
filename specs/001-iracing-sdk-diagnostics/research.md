# Research: iRacing SDK Connection & Diagnostic UI

**Feature**: `001-iracing-sdk-diagnostics` | **Date**: 2026-06-26

All decisions below are derived from inspection of the existing scaffold
(`apps/tauri-client/src-tauri/src/iracing/`) and the iRacing SDK C header
layout documented in `defines.rs` and `types.rs`.

---

## Decision 1: Shared Memory Access Strategy

**Decision**: Open `"Local\\IRSDKMemMapFileName"` using `OpenFileMapping` +
`MapViewOfFile` on a dedicated `std::thread` (not a tokio task). Wrap the raw
pointer in a `Send`-safe newtype and share it with the async runtime via `Arc`.

**Rationale**: `OpenFileMapping` and `MapViewOfFile` are synchronous Win32 calls
that park the thread while iRacing is not running. Running them inside a tokio
future would starve the async executor. A dedicated OS thread polls every 500 ms
and signals the async layer via a `tokio::sync::watch` channel when connection
state changes.

**Alternatives considered**:
- `tokio::task::spawn_blocking` — viable but adds a thread per poll invocation;
  a persistent dedicated thread is simpler and cheaper.
- Community crate (`irsdk-rs`) — no mature, maintained crate exists as of 2026;
  ADR 13 mandates custom Rust integration.

---

## Decision 2: Session YAML Parsing

**Decision**: Add `serde_yaml = "0.9"` to `Cargo.toml`. Extract the raw YAML
bytes from the shared memory buffer at `header.session_info_offset` for
`header.session_info_len` bytes, decode as UTF-8, and parse with
`serde_yaml::from_str::<serde_yaml::Value>()`.

**Rationale**: The session info blob is a YAML string embedded in shared memory.
`serde_yaml` is the de-facto standard in the Rust ecosystem. Parsing to
`serde_yaml::Value` (rather than a typed struct) avoids breakage if iRacing
adds unexpected YAML keys in future versions.

**Fields extracted**:
| Spec field | YAML path |
|------------|-----------|
| Track name | `WeekendInfo.TrackName` |
| Session type | `WeekendInfo.EventType` |
| Car name | `DriverInfo.Drivers[0].CarScreenNameShort` |

**Wall-clock time**: Sourced from `std::time::SystemTime::now()` on the Rust
side at the moment of session-change event emission — not from the iRacing SDK
(per clarification Q1: real-world wall-clock time).

**Alternatives considered**:
- Typed `serde` struct for the full YAML — fragile; iRacing's YAML schema is
  undocumented and fields vary by session type.
- `yaml-rust` crate — less ergonomic; `serde_yaml` is better supported.

---

## Decision 3: Var Header Enumeration

**Decision**: Enumerate all telemetry variables on connection by reading
`header.num_vars` entries of `IrsdkVarHeader` (144 bytes each) starting at
`header.var_header_offset`. Cache the result as `Vec<TelemetryField>` in
managed state. Refresh the cache when `header.session_info_update` increments.

**Rationale**: The var header array is stable within a session but can change
between sessions (different cars expose different variables). Caching avoids
re-parsing on every 10 Hz tick.

**`IrsdkVarHeader` layout** (from `types.rs`):
```
offset  0: i32  var_type
offset  4: i32  offset (byte offset into the live data buffer)
offset  8: i32  count (>1 for arrays)
offset 12: u8   count_as_time
offset 13: [u8;3] pad
offset 16: [u8;32] name (null-terminated)
offset 48: [u8;64] desc (null-terminated)
offset 112: [u8;32] unit (null-terminated)
total: 144 bytes
```

**Alternatives considered**:
- Re-enumerate every tick — unnecessary CPU cost given the cache is valid for the
  session lifetime.

---

## Decision 4: Live Data Buffer Selection

**Decision**: Use `header.var_buf[N]` where N is the index with the largest
`tick_count`. Read live variable values at `var_buf[N].buf_offset + var.offset`.

**Rationale**: iRacing maintains a ring of 4 data buffers (`IRSDK_MAX_BUFS = 4`)
to avoid read/write races. The buffer with the highest `tick_count` is the most
recent complete snapshot. This is the standard approach from the official C SDK.

---

## Decision 5: Frontend Event Delivery Strategy

**Decision**: Use Tauri's `app_handle.emit()` to push three event types from Rust
to the Preact frontend. The frontend listens with `@tauri-apps/api/event`
`listen()`. No polling from the frontend side.

**Rationale**: Tauri events are the idiomatic Rust→Frontend push mechanism. The
frontend should never poll via `invoke()` on a timer for live data — that couples
the JS timer to the Rust poll cycle and adds latency. Events decouple the two.

**Three events**:
1. `iracing://status-changed` — emitted when `is_connected()` state transitions
2. `iracing://session-changed` — emitted when `session_info_update` counter changes
3. `iracing://telemetry-tick` — emitted at 10 Hz with watchlist field values

**Alternatives considered**:
- Frontend `setInterval` + `invoke("get_watchlist_values")` — adds 1 round-trip
  latency per tick; less efficient; couples JS timer precision to Rust.

---

## Decision 6: Watchlist State Location

**Decision**: Store the watchlist as `Mutex<Vec<String>>` inside `AppState`
(Tauri managed state). The Rust polling task reads the watchlist each tick to
know which fields to include in `iracing://telemetry-tick`.

**Rationale**: Managed state is the Tauri-idiomatic way to share data between
commands and background tasks. The watchlist is small (≤ 20 field names) so
`Mutex` contention is negligible.

---

## Decision 7: Duplicate `ConnectionStatus` Cleanup

**Decision**: `ConnectionStatus` is currently defined in both `state.rs` and
`iracing/types.rs`. Consolidate to `iracing/types.rs` only. Update `state.rs`
to `use crate::iracing::types::ConnectionStatus`.

**Rationale**: Two definitions of the same type will cause type-mismatch errors
once both modules are used in the same Tauri command. Clean this up as part of
this feature before it causes a runtime issue.

---

## Decision 8: Non-Windows Stub Strategy

**Decision**: Use `#[cfg(target_os = "windows")]` / `#[cfg(not(target_os = "windows"))]`
blocks within `sdk.rs`. The non-Windows path returns a stub `IracingSDK` with
an empty buffer (identical to current scaffold) so `cargo test` runs on macOS/Linux CI.

**Rationale**: All unit tests are written against the struct's public interface
using hand-crafted byte buffers — no Win32 calls needed for testing the parsing logic.
