# Feature Specification: iRacing SDK Connection & Diagnostic UI

**Feature Branch**: `001-iracing-sdk-diagnostics`

**Created**: 2026-06-26

**Status**: Draft

**Input**: User description: "Great now lets tackle the Rust Client and it's connection to the shared memory file, plus processing of the data. For this first iteration we should also create a basic UI (skip tailwind and shadcn for now) so we can display if the client is connected, show the session data, and select fields from the live data which allow us to verify that the system is connected correctly"

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Connection Status at a Glance (Priority: P1)

As a developer setting up the system for the first time, I want to see immediately whether the desktop client is connected to the simulator so I know whether data is flowing before I rely on it for anything.

**Why this priority**: All other functionality — session data, live telemetry — is meaningless without a confirmed connection. This is the foundational health signal for the entire system.

**Independent Test**: Launch the client with iRacing not running and confirm "disconnected" is shown. Start iRacing, enter a session, and confirm "connected" appears automatically without any user action. Close iRacing and confirm the display reverts to "disconnected".

**Acceptance Scenarios**:

1. **Given** the client app is open and iRacing is not running, **When** I look at the client UI, **Then** I see a clear indication that no connection is established.
2. **Given** the client is showing "disconnected", **When** iRacing starts and a session begins, **Then** the connection indicator updates to "connected" within 2 seconds — without any manual refresh.
3. **Given** the client is showing "connected", **When** iRacing is closed, **Then** the connection indicator reverts to "disconnected" within 2 seconds.

---

### User Story 2 — Session Metadata Confirmation (Priority: P2)

As a developer, once I see the client is connected, I want to read the current session's metadata — track name, car name, session type, weather conditions — so I can confirm the data channel is feeding real, correct information and not stale or incorrect values.

**Why this priority**: Verifying that the session data matches what iRacing shows in its own UI is the first meaningful end-to-end correctness check. It gates trust in everything downstream.

**Independent Test**: Connect to a known session on a specific track and car. Verify the track name, car name, and session type displayed in the client match what is visible in the iRacing UI.

**Acceptance Scenarios**:

1. **Given** the client is connected and an active session is running, **When** I view the session panel, **Then** I see at minimum: track name, car name, session type (practice / qualifying / race), and real-world wall-clock time.
2. **Given** the client is connected and showing session metadata, **When** iRacing transitions to a new session type (e.g., practice ends and qualifying begins), **Then** the displayed session metadata updates to reflect the new session without requiring a restart.
3. **Given** iRacing is open but the user is in the main menu (no active session), **When** I view the client, **Then** the client shows "connected" but the session panel indicates no active session data is available.

---

### User Story 3 — Live Telemetry Field Browser & Watchlist (Priority: P3)

As a developer, I want to browse all telemetry fields available from the simulator, select a handful that I care about, and watch their values update in real time — so I can verify the live data pipeline is working correctly end to end.

**Why this priority**: The watchlist confirms that high-frequency live data is being received and updated correctly. It provides direct evidence that the real-time data path is healthy.

**Independent Test**: In a live session, open the field browser, select at least 5 fields (e.g., speed, RPM, lap distance percentage, fuel level, gear), and confirm all values update visibly as the car moves on track.

**Acceptance Scenarios**:

1. **Given** the client is connected to an active session, **When** I open the field browser, **Then** I see a scrollable list of all available telemetry fields with their current values and units.
2. **Given** I can see the field list, **When** I select a field to add to my watchlist, **Then** it appears in a separate "watching" panel and its value continues to update.
3. **Given** I have fields in my watchlist, **When** the car is moving on track, **Then** time-varying fields (speed, RPM) visibly change without manual refresh.
4. **Given** I have fields in my watchlist, **When** I deselect a field, **Then** it is removed from the watchlist panel.

---

### Edge Cases

- What happens when iRacing starts but no session has been loaded yet (sitting on the main menu)?
- What happens if the simulator crashes mid-session — does the client detect the disconnection cleanly?
- What happens to the watchlist if iRacing disconnects and then reconnects — are field selections preserved?
- What happens when a session transitions (practice → qualifying → race) while the watchlist is active — do values continue updating for the same fields?
- What if a field that was on the watchlist is not available in a new session or car type? → Resolved: field remains in watchlist with an "unavailable" label (see FR-011).

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The client MUST display a persistent connection status indicator showing either "connected" or "disconnected" at all times while the app is running.
- **FR-002**: The connection status MUST update automatically — without user-initiated refresh — within 2 seconds of the simulator starting or stopping.
- **FR-003**: When connected to an active session, the client MUST display session metadata including: track name, car name, session type, and real-world wall-clock time. The wall-clock time is the system clock time captured at the moment the Rust layer emits the session event — it is NOT a value read from the iRacing SDK itself.
- **FR-004**: When connected but no session is active (e.g., simulator is on the main menu), the client MUST display the connected status while indicating that no session data is currently available.
- **FR-005**: When a session type transition occurs (e.g., practice → qualifying), the client MUST refresh displayed session metadata to reflect the new session without requiring a restart.
- **FR-006**: The client MUST present a browsable list of all available telemetry fields and their instantaneous values when connected to an active session. "All available fields" means every variable returned by the SDK's variable headers at connect time (both time-varying and static fields). Values in the field browser are a **snapshot** captured at connect/session-change time and are NOT live-refreshed per row — live-updating values are provided by the watchlist panel only (FR-009). When connected but no session is active, the field browser panel MUST remain visible but display a "no active session" message in place of the field list. Search, filtering, and grouping are out of scope for this iteration.
- **FR-007**: The user MUST be able to add any field from the browser to a persistent watchlist.
- **FR-008**: The user MUST be able to remove any field from the watchlist.
- **FR-009**: Watchlist field values MUST refresh at a minimum of 10 Hz (10 times per second) so that time-varying data (e.g., speed, RPM) visibly changes while the car is moving.
- **FR-010**: When the simulator disconnects, the watchlist MUST retain the user's field selections so they are restored when the connection is re-established.
- **FR-011**: If a watchlist field is not available in the current session or car (e.g., after a session transition or car change), the field MUST remain in the watchlist and display a clear "unavailable" label in place of its value — it MUST NOT be silently removed.

### Key Entities

- **Connection State**: Represents whether the client is currently receiving data from the simulator. States: connected, disconnected. Updates automatically.
- **Session**: The current iRacing session context. Contains static metadata (track, car, session type, real-world wall-clock time). Changes when the session type transitions.
- **Telemetry Field**: A named data variable provided by the simulator. Has a name, current value, and unit of measure. Values change at the simulator's output rate.
- **Watchlist**: The user's curated set of telemetry fields to monitor. Persists across disconnect/reconnect cycles within the same app session.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Connection state is accurate and visible within 2 seconds of the simulator starting or stopping — verifiable by timing the transition manually across 3 trials.
- **SC-002**: All mandatory session metadata fields (track, car, session type, real-world wall-clock time) are displayed and match the simulator's own UI — verifiable by side-by-side comparison.
- **SC-003**: A developer can confirm the live data pipeline is working by observing at least 5 time-varying fields updating at 10 Hz or faster in real time without any manual action.
- **SC-004**: The complete connection lifecycle (launch client → start simulator → enter session → watch live data → exit simulator → client shows disconnected) can be executed successfully in a single sitting without errors or restarts.
- **SC-005**: The watchlist survives a disconnect/reconnect cycle — fields selected before disconnection are still present and resume updating after reconnection.

---

## Clarifications

### Session 2026-06-26

- Q: Does "time of day" mean real-world wall-clock time or in-session elapsed time? → A: Real-world wall-clock time
- Q: What is the minimum acceptable refresh rate for watchlist field values? → A: 10 Hz (10 updates per second)
- Q: When a watchlist field is unavailable in the current car/session, what should the client display? → A: Keep the field in the watchlist, show "unavailable" label instead of a value (FR-011)
- Q: What should the field browser panel show when connected but no session is active? → A: Panel remains visible with a "no active session" message in place of the field list (FR-006)

---

## Assumptions

- iRacing is installed and running on the same machine as the desktop client application.
- The primary user of this UI is the developer/system owner, not an end user — functional correctness takes precedence over visual polish.
- "Basic UI" means a functional but minimally styled interface; no design system, component library, or custom theming is required for this feature.
- The field browser shows all available fields; search, filtering, and grouping by category are out of scope for this first iteration.
- Watchlist selections are retained for the lifetime of the client app session only — persistence to disk across app restarts is out of scope for this iteration.
- Session transitions within a single running simulator instance (practice → qualifying → race) must be handled gracefully; full restart scenarios are also in scope.
- The number of available telemetry fields may vary by car — the spec makes no assumption about the exact field list, only that all currently available fields are shown.
