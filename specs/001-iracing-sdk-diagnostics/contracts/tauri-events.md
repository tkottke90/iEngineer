# Contract: Tauri Events (Rust → Frontend)

**Feature**: `001-iracing-sdk-diagnostics` | **Date**: 2026-06-26

These events are emitted by the Rust backend and received by the Preact frontend
via `@tauri-apps/api/event`. The frontend should `listen()` for these on mount
and `unlisten()` on unmount. All events are global (not window-scoped).

---

## `iracing://status-changed`

Emitted whenever the iRacing connection state transitions. Also emitted once on
app startup with the initial state.

**Payload**:
```typescript
import { listen } from '@tauri-apps/api/event';

type ConnectionStatus = 'Connected' | 'Disconnected' | 'Connecting';

const unlisten = await listen<ConnectionStatus>('iracing://status-changed', (event) => {
  const status = event.payload;
  // update connection indicator
});
```

**Emission triggers**:
- App startup (initial state)
- `OpenFileMapping` succeeds → `Connecting` → `Connected`
- `header.status ≠ 1` detected → `Disconnected`
- iRacing process exits → `Disconnected`

**Tracing**: each emission MUST be accompanied by `tracing::info!("connection status → {status:?}")`.

---

## `iracing://session-changed`

Emitted when `header.session_info_update` increments, indicating iRacing has
written a new session YAML blob (new session type, session start, session end).

**Payload**:
```typescript
import { listen } from '@tauri-apps/api/event';

interface SessionInfo {
  track_name: string;
  session_type: string;
  car_name: string;
  wall_clock_time: string;  // "HH:MM:SS" — real-world time at emission
}

const unlisten = await listen<SessionInfo | null>('iracing://session-changed', (event) => {
  const session = event.payload;
  if (session === null) {
    // connected but no active session (main menu)
  } else {
    // update session panel
  }
});
```

**Emission triggers**:
- `header.session_info_update` counter increments
- Connection drops → emit `null`
- Reconnection establishes a session → emit populated `SessionInfo`

**Tracing**: MUST log `tracing::info!("session changed: {session_type} @ {track_name}")`.

---

## `iracing://telemetry-tick`

Emitted at 10 Hz (every 100 ms) when connected and the watchlist is non-empty.
Contains the current values of all watchlist fields only — not the full field list.

**Payload**:
```typescript
import { listen } from '@tauri-apps/api/event';

type TelemetryValue =
  | { Float: number }
  | { Double: number }
  | { Int: number }
  | { Bool: boolean }
  | { Bitfield: number }
  | { Char: string }
  | { FloatArray: number[] }
  | { IntArray: number[] }
  | 'Unavailable';

// payload is a map from field name → current value
type TelemetryTickPayload = Record<string, TelemetryValue>;

const unlisten = await listen<TelemetryTickPayload>('iracing://telemetry-tick', (event) => {
  const values = event.payload;
  // values["Speed"] → { Float: 42.3 }
  // values["Gear"]  → { Int: 3 }
  // values["SomeMissingField"] → "Unavailable"
});
```

**Emission rules**:
- Only emitted when `ConnectionStatus == Connected` AND watchlist is non-empty.
- Emitted even if some watchlist fields are `Unavailable` in the current car/session
  (FR-011: missing fields appear as `"Unavailable"` in the map, not omitted).
- Suppressed (not emitted) when disconnected or watchlist is empty.

**Performance**: payload is bounded by watchlist size (≤ 20 fields in practice).
At 10 Hz this is negligible IPC overhead.
