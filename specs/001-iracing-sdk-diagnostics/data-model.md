# Data Model: iRacing SDK Connection & Diagnostic UI

**Feature**: `001-iracing-sdk-diagnostics` | **Date**: 2026-06-26

All types are Rust structs/enums. Those marked `[TS]` are exported to TypeScript
via `ts-rs` so the Preact frontend has matching types.

---

## Entities

### ConnectionStatus `[TS]`

Represents whether the Tauri client currently has a live read on the iRacing
shared memory file.

```rust
pub enum ConnectionStatus {
    Connected,
    Disconnected,
    Connecting,   // transient — emitted while OpenFileMapping is in progress
}
```

**Lifecycle**:
```
Disconnected → (iRacing starts) → Connecting → (MapViewOfFile succeeds) → Connected
Connected    → (iRacing closes / header.status ≠ 1)                    → Disconnected
```

**Authoritative location**: `apps/tauri-client/src-tauri/src/iracing/types.rs`
(remove the duplicate in `state.rs` — import from here instead).

---

### SessionInfo `[TS]`

Parsed from the YAML blob embedded in shared memory. Present only while a session
is active; `None` when iRacing is on the main menu.

```rust
pub struct SessionInfo {
    pub track_name: String,
    pub session_type: String,     // "Race", "Practice", "Qualify", etc.
    pub car_name: String,         // driver's own car (Drivers[0].CarScreenNameShort)
    pub wall_clock_time: String,  // HH:MM:SS, captured from std::time::SystemTime at emission
}
```

**Validation rules**:
- All fields are non-empty strings. If the YAML key is missing, the field falls
  back to `"unknown"` (never panics on malformed YAML).
- `wall_clock_time` is populated by the Rust layer at event-emission time, not
  read from the SDK.

**State transitions**: re-emitted each time `header.session_info_update` increments,
indicating iRacing has written a new session YAML blob.

---

### TelemetryField `[TS]`

One entry in the full field browser list. Derived from `IrsdkVarHeader` at
connection time. The `value` is updated each 10 Hz tick for fields in the watchlist.

```rust
pub struct TelemetryField {
    pub name: String,           // e.g. "Speed", "RPM", "Throttle"
    pub description: String,    // human-readable description from var header
    pub unit: String,           // e.g. "m/s", "rpm", "%"
    pub var_type: VarType,
    pub value: TelemetryValue,
}

pub enum VarType {
    Char, Bool, Int, Bitfield, Float, Double,
}

pub enum TelemetryValue {
    Float(f32),
    Double(f64),
    Int(i32),
    Bool(bool),
    Bitfield(u32),
    Char(String),
    FloatArray(Vec<f32>),
    IntArray(Vec<i32>),
    Unavailable,   // field exists in cache but not readable in current car/session
}
```

**Field browser**: the full list (`Vec<TelemetryField>`) is enumerated once at
connection and cached. It is refreshed when `session_info_update` changes (new
session or car change may expose different variables).

**Watchlist tick**: only fields named in the watchlist are read from the live data
buffer each 10 Hz tick. Non-watchlist fields retain their last known value in the
cache (the browser shows stale values — acceptable for a diagnostic tool).

---

### Watchlist

Not a persistent entity — lives in `AppState` as `Mutex<Vec<String>>` (field names).

```rust
// In AppState:
pub watchlist: Mutex<Vec<String>>,
```

**Constraints**:
- Field names are the canonical `IrsdkVarHeader.name` strings (e.g. `"Speed"`).
- No fixed maximum size; practically bounded by the ≤ 350 available fields.
- Retained across iRacing disconnect/reconnect within the same app session (FR-010).
- If a watchlist field is absent in a new session's var headers, its value is set
  to `TelemetryValue::Unavailable` (FR-011).

---

## State Ownership Map

| Entity | Owned by | Shared via |
|--------|----------|------------|
| `ConnectionStatus` | connection watcher thread | `tokio::sync::watch::Sender<ConnectionStatus>` |
| `SessionInfo` | connection watcher thread | Tauri event `iracing://session-changed` |
| `Vec<TelemetryField>` (full list) | `AppState.field_cache` `Mutex` | `list_telemetry_fields` command |
| `Watchlist` | `AppState.watchlist` `Mutex` | `get_watchlist` / `set_watchlist` commands |
| Tick values | produced each tick, not stored | Tauri event `iracing://telemetry-tick` |

---

## AppState Extensions

```rust
pub struct AppState {
    pub config: Mutex<AppConfig>,
    // --- new for this feature ---
    pub field_cache: Mutex<Vec<TelemetryField>>,
    pub watchlist: Mutex<Vec<String>>,
    pub iracing_status: watch::Sender<ConnectionStatus>,
}
```

The `watch::Sender` lets the connection watcher thread and Tauri commands both
read the current status without an extra `Mutex`.
