# Quickstart & Validation Guide: iRacing SDK Connection & Diagnostic UI

**Feature**: `001-iracing-sdk-diagnostics` | **Date**: 2026-06-26

This guide proves the feature works end-to-end. Run each scenario in order.
All commands are run from the repo root unless noted otherwise.

---

## Prerequisites

- Windows 10/11 PC with iRacing installed
- Rust toolchain (stable, 2021 edition) and `cargo` in PATH
- Node.js + npm installed, `npm install` already run at repo root
- Tauri CLI: `npm run tauri -- --version` should print `tauri-cli 2.x`
- iRacing subscription active (needed to enter a session)

---

## Scenario-to-Requirement Traceability

| Scenario | Spec Requirement(s) Verified |
|----------|------------------------------|
| 1 — Disconnected State on Launch | US1 AC1, FR-001, FR-004, FR-006 (no-session message) |
| 2 — Connection Detection (iRacing Starts) | US1 AC2 + AC3, FR-002, SC-001 |
| 3 — Session Data Appears | US2 AC1 + AC3, FR-003, FR-004, FR-006 (field browser populates), SC-002 |
| 4 — Field Browser Populated | US3 AC1, FR-006 |
| 5 — Watchlist Add and Live Update | US3 AC2 + AC3 + AC4, FR-007, FR-008, FR-009, SC-003 |
| 6 — Unavailable Field | FR-011, edge case: field absent in current session |
| 7 — Watchlist Survives Disconnect/Reconnect | FR-010, SC-005 |
| 8 — Crash Detection | Edge case: unclean disconnect (force-kill vs. orderly exit) |
| 9 — Full Lifecycle | SC-004; also covers US2 AC2 (session-type transition) |

*US2 AC2 (session-type transition while connected) is primarily exercised within Scenario 9 (Full Lifecycle) and the Phase 4 checkpoint, rather than as a standalone scenario.*

---

## Build Checks (non-Windows CI safe)

Run these first — they must pass on any platform.

```bash
# 1. Rust compiles cleanly (including non-Windows stub path)
cd apps/tauri-client/src-tauri
cargo build 2>&1 | tail -5
# Expected: "Finished dev" — no errors, no warnings about unused imports

# 2. Rust unit tests pass
cargo test 2>&1
# Expected: "test result: ok. N passed; 0 failed"
# Tests cover: parse_header, enumerate_vars, extract_session_yaml, is_connected

# 3. TypeScript type-checks
cd ../../..
npm run typecheck -w apps/tauri-client
# Expected: no type errors
```

---

## Scenario 1 — Disconnected State on Launch

**Goal**: Verify FR-001 and FR-002 — connection indicator shows "Disconnected"
immediately on app start when iRacing is not running.

**Steps**:
1. Ensure iRacing is fully closed (check Task Manager for `iRacingSim64DX11.exe`).
2. Run `npm run tauri dev -w apps/tauri-client` and wait for the window to open.
3. Click the **Diagnostics** tab.

**Expected**:
- Connection badge displays "Disconnected" (red or equivalent visual indicator).
- Session panel shows "No active session".
- Field browser shows "No active session — enter a session to browse fields".
- Watchlist panel is empty.

---

## Scenario 2 — Connection Detection (iRacing Starts)

**Goal**: Verify FR-002 — connection status updates within 2 seconds, no manual
refresh required.

**Steps**:
1. With the Diagnostics tab visible, start iRacing and wait for the main menu to load.
2. Start a timer.
3. Observe the connection badge.

**Expected**:
- Within **2 seconds** of iRacing's main menu appearing, the badge changes to
  "Connected".
- Session panel still shows "No active session" (we're on the main menu).
- Field browser still shows the "no session" message.

---

## Scenario 3 — Session Data Appears (Entering a Session)

**Goal**: Verify FR-003 and SC-002 — session metadata is correct and matches
iRacing's own UI.

**Steps**:
1. From iRacing's main menu, start a practice session on any track.
2. Once the session loads (you are in-car or in the pit), observe the Diagnostics tab.

**Expected**:
- Session panel shows:
  - **Track name** — matches the track name shown in iRacing's HUD.
  - **Session type** — "Practice" (or "Race" / "Qualify" as appropriate).
  - **Car name** — matches the car name shown in iRacing's garage screen.
  - **Wall-clock time** — current time (HH:MM:SS); verify it matches your system
    clock to within ±5 seconds.
- Field browser is now populated with a scrollable list of telemetry field names
  and their current values.

---

## Scenario 4 — Field Browser Populated

**Goal**: Verify FR-006 — all available fields are listed with values and units.

**Steps**:
1. With a session active, scroll through the field browser list.
2. Locate the following fields and note their displayed values:
   - `Speed` (expected unit: `m/s`)
   - `RPM` (expected unit: `rpm`)
   - `Throttle` (expected unit: `%`)
   - `Gear` (expected unit: empty or `gear`)
   - `FuelLevel` (expected unit: `l` or `kg`)

**Expected**:
- All 5 fields are present in the list.
- Values are plausible (Speed ≥ 0, RPM ≥ 0 in pit, Throttle 0–1, Gear ≥ 0).
- Units match the expected strings above.

---

## Scenario 5 — Watchlist: Add and Live Update

**Goal**: Verify FR-007, FR-008, FR-009, SC-003 — watchlist updates at 10 Hz.

**Steps**:
1. From the field browser, click **Add** (or equivalent) on `Speed`, `RPM`,
   `Throttle`, `Brake`, and `Gear`.
2. Drive the car on track (or use auto-drive if available).
3. Observe the watchlist panel.

**Expected**:
- All 5 fields appear in the watchlist panel.
- While the car is moving, `Speed` and `RPM` values change visibly without any
  manual refresh — at least one value change observed within 1 second.
- Remove `Gear` by clicking its remove control; it disappears from the watchlist.

---

## Scenario 6 — Unavailable Field (FR-011)

**Goal**: Verify that a watchlist field that disappears in a new context shows
"Unavailable" rather than being silently dropped.

**Steps**:
1. If a car-specific variable is known (e.g. a variable only available in open-wheel
   cars), add it to the watchlist while driving that car.
2. Alternatively: manually inject a non-existent field name via `set_watchlist`
   using the Tauri developer console:
   ```javascript
   window.__TAURI__.core.invoke('set_watchlist', {
     fields: ['Speed', 'RPM', 'FieldThatDoesNotExist']
   });
   ```
3. Observe the watchlist panel.

**Expected**:
- `Speed` and `RPM` show live values.
- `FieldThatDoesNotExist` shows "Unavailable" in place of a value.
- It is **not** removed from the watchlist silently.

---

## Scenario 7 — Watchlist Survives Disconnect/Reconnect (FR-010, SC-005)

**Goal**: Verify watchlist field selections are retained across iRacing exit and re-entry.

**Steps**:
1. Add `Speed`, `RPM`, and `Throttle` to the watchlist.
2. Exit iRacing completely.
3. Observe the Diagnostics tab — badge should show "Disconnected".
4. Restart iRacing and enter a session.

**Expected**:
- After reconnection, `Speed`, `RPM`, and `Throttle` are still in the watchlist.
- Values resume updating without any user action.

---

## Scenario 8 — Crash Detection (Edge Case: Unclean Disconnect)

**Goal**: Verify the client detects a process crash (force-kill) the same way it detects an orderly
iRacing shutdown — connection badge transitions to "Disconnected" within 2 seconds.

**Steps**:
1. With the Diagnostics tab visible, enter an active session and add `Speed` and `RPM` to the
   watchlist. Confirm both values are updating live.
2. Open Task Manager (`Ctrl+Shift+Esc`).
3. Locate `iRacingSim64DX11.exe` in the Processes list, right-click, and select **End Task**
   (force-kill — do NOT use the iRacing UI to exit).
4. Return to the client window and start a timer.

**Expected**:
- Within **2 seconds** of the force-kill, the connection badge changes to "Disconnected".
- The session panel shows "No active session".
- Watchlist values stop updating — no new values are rendered after the kill.
- `Speed` and `RPM` **remain in the watchlist panel** — field selections are retained (FR-010).
- The client application itself does not crash or show an error dialog.

---

## Scenario 9 — Full Lifecycle (SC-004)

**Goal**: Verify the complete connection lifecycle in one sitting.

**Steps**:
1. Launch client (Disconnected state confirmed).
2. Start iRacing → Connected appears within 2 s.
3. Enter a session → Session metadata and field browser populated.
4. Add 5 fields to watchlist → values update at 10 Hz.
5. Exit iRacing → Disconnected within 2 s; field browser shows "no session" message.

**Expected**: All transitions complete without errors, restarts, or manual intervention.

---

## Tracing Verification

Confirm observability gates (Constitution Principle V):

```bash
# Run the app with RUST_LOG=info and observe the terminal output
RUST_LOG=info npm run tauri dev -w apps/tauri-client 2>&1 | grep -E "connection|session"
```

**Expected log lines** (examples):
```
INFO iracing_engineer_lib: connection status → Connected
INFO iracing_engineer_lib: session changed: Practice @ Sebring International Raceway
INFO iracing_engineer_lib: connection status → Disconnected
```
