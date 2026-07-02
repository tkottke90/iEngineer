# Feature Specification: Rule-Based Alerts + Voice

**Feature Branch**: `004-rule-based-alerts-voice`

**Created**: 2026-06-30

**Status**: Draft

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Fuel Critical Alert During Race (Priority: P1)

A driver is in a live iRacing race. Their fuel level drops below the critical threshold. The Racing Engineer speaks a fuel warning through their configured audio output device before the driver runs out — without any LLM call or manual intervention.

**Why this priority**: This is the single most safety-critical alert. Missing it ends the race. Delivering it demonstrates the core end-to-end path (telemetry → alert rule → TTS → audio playback) and is independently valuable.

**Independent Test**: Simulate a telemetry feed with fuel below the critical threshold (e.g., < 1 lap remaining). Confirm that the engineer speaks a fuel alert within 3 seconds and does not repeat it on the following lap.

**Acceptance Scenarios**:

1. **Given** a live session with fuel < 1 lap of fuel remaining, **When** the telemetry event is processed, **Then** the engineer speaks a fuel critical warning within 3 seconds via the configured output device.
2. **Given** the fuel critical alert already fired on the current lap, **When** the same condition persists on the next lap, **Then** no duplicate alert is emitted.
3. **Given** the fuel level later rises above the threshold (e.g., after a pit stop and refuel), **When** it drops critically low again, **Then** the alert fires again (deduplication resets after condition clears).

---

### User Story 2 — Pit Window Alert (Priority: P2)

A driver is racing and reaches the lap window in which a pit stop becomes strategically viable. The engineer announces the pit window opening. The driver can decide whether to pit.

**Why this priority**: This is the primary strategic value of the Racing Engineer in M4 and the headline feature for the deploy test. It requires the Tier 2 safe-window gating path to work correctly.

**Independent Test**: Configure a pit window range (e.g., laps 10–15 in a 30-lap race). Simulate reaching lap 10. Confirm the engineer speaks a pit window alert exactly once, only when not in a Radio Blackout Zone.

**Acceptance Scenarios**:

1. **Given** the session lap enters the configured pit window range, **When** the driver is not in a Radio Blackout Zone, **Then** the engineer announces the pit window opening within 3 seconds.
2. **Given** the driver is in a Radio Blackout Zone (e.g., mid-corner sector), **When** the pit window opens, **Then** the alert is held until the next safe window and then delivered.
3. **Given** the pit window alert has fired once this stint, **When** each subsequent lap inside the window is processed, **Then** the alert does not repeat.
4. **Given** the driver has completed a pit stop and exited the pit lane, **When** the next stint's pit window opens (same configured lap range), **Then** the pit window alert fires again.

---

### User Story 3 — Tier 1 Alerts: Blue Flag, Safety Car, Pit Limiter (Priority: P2)

During a race, flag conditions and pit limiter activation change instantly. The engineer delivers immediate Tier 1 alerts that override any safe-window gate and speak without delay.

**Why this priority**: Flag alerts are regulatory — missing a blue flag can cause a penalty. These must be delivered immediately regardless of blackout zone.

**Independent Test**: Simulate each flag event independently (blue flag, safety car, pit limiter on/off). Confirm immediate TTS delivery for each, bypassing the safe-window gate.

**Acceptance Scenarios**:

1. **Given** the blue flag is shown to the driver, **When** the telemetry flag field changes, **Then** the engineer speaks a blue flag warning immediately, regardless of Radio Blackout Zone.
2. **Given** a safety car is deployed, **When** the telemetry event is processed, **Then** the engineer announces the safety car immediately.
3. **Given** the driver enters the pit lane with the limiter active, **When** the telemetry pit limiter field activates, **Then** the engineer confirms limiter active immediately.

---

### User Story 4 — Chattiness Personality Setting (Priority: P3)

A driver can configure the engineer's Chattiness to Low, suppressing all Tier 2 alerts, or leave it on Default to receive all alerts. This lets experienced drivers reduce noise during intense racing.

**Why this priority**: Improves usability without changing core logic. Low Chattiness simply drops Tier 2 messages before they enter the queue.

**Independent Test**: Set Chattiness to Low. Trigger a pit window opening event. Confirm no audio plays. Set Chattiness to Default. Trigger same event. Confirm audio plays.

**Acceptance Scenarios**:

1. **Given** Chattiness is set to Low, **When** a Tier 2 alert condition is met, **Then** no audio is produced.
2. **Given** Chattiness is set to Low, **When** a Tier 1 alert condition is met (fuel critical, blue flag, safety car, pit limiter), **Then** audio is produced immediately.
3. **Given** Chattiness is set to Default, **When** any alert fires, **Then** it follows normal gating and queuing behavior.

---

### User Story 5 — Audio Device Test Panel (Priority: P3)

Before a race session, a driver wants to verify their audio output device is working correctly without having to start a race. They open a test panel in Tauri settings, play a sample TTS clip, and confirm audio comes through the right device.

**Why this priority**: Critical for first-time setup and troubleshooting. A driver who can't hear the engineer doesn't know the system is broken.

**Independent Test**: Open the audio test panel. Click the playback test button. Confirm a sample TTS clip plays through the configured output device. Verify the mic input level meter responds to microphone input. Verify the PTT trigger test responds to the PTT key press.

**Acceptance Scenarios**:

1. **Given** the audio settings panel is open, **When** the user clicks "Play Test Clip," **Then** a sample TTS audio clip plays through the currently configured output device.
2. **Given** the audio settings panel is open, **When** the user speaks into the microphone at normal conversational volume, **Then** the input level meter visually responds (bar animates above its resting position); any audible input producing visible bar movement satisfies this criterion.
3. **Given** the audio settings panel is open, **When** the user presses the configured PTT key, **Then** the panel confirms PTT detection.

---

### Edge Cases

- What happens when the TTS service is unreachable? The alert is dropped; no crash, no stale audio. A structured log entry MUST be emitted containing: alert type, tier, lap number, failure reason, and timestamp — enabling post-session filtering and frequency analysis.
- What happens when multiple Tier 1 alerts fire simultaneously (e.g., blue flag + safety car)? Each is queued and played sequentially with minimal delay; Tier 1 alerts bypass the safe-window gate but do not interrupt each other — all play in FIFO arrival order.
- What happens when an alert fires while another clip is mid-playback? No clip is ever interrupted — all alerts queue sequentially. A Tier 1 alert that arrives during Tier 2 playback is placed at the front of the remaining queue; a Tier 1 alert that arrives during another Tier 1 clip's playback queues immediately after the current clip completes. A Tier 2 alert always queues behind all pending Tier 1 alerts.
- What happens when the entire lap is covered by Radio Blackout Zones (no safe window exists)? A Tier 2 alert queues and delivers on the first safe-window tick of the following lap. If 30 seconds elapse with no safe window found, the alert is dropped and a structured warning log is emitted with the alert type and reason ("no-safe-window-timeout"). Tier 1 alerts are unaffected — they bypass blackout zones entirely.
- What happens when no audio output device is configured? The system logs a warning; no audio is attempted; the test panel shows a "no device configured" message.
- What happens if Redis is unavailable? The Racing Engineer service fails to subscribe to the event bus; it logs an error and does not attempt to play audio.
- What happens when the OS denies microphone permission? The mic input level meter in the audio test panel shows a "Microphone unavailable" message and disables the level meter; the rest of the panel (playback test, PTT test) continues to function normally.
- What happens when no PTT key is bound in settings? The PTT test section in the audio device test panel shows a "No PTT key bound" message and does not listen for key events. (`ptt_hotkey: "F13"` is the default in `AppConfig`, so this state requires the user to have explicitly cleared the binding.)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Racing Engineer service MUST subscribe to the telemetry event bus and evaluate alert rules on each telemetry tick.
- **FR-002**: Tier 1 alerts (fuel critical, blue flag, safety car, pit limiter) MUST bypass the safe-window gate and be dispatched immediately; queue ordering and no-interrupt rules are defined in FR-005.
- **FR-003**: Tier 2 alerts (pit window opens) MUST be held during Radio Blackout Zones and delivered at the next safe window.
  - *M4 scope*: only `hero:pit_window_open` is implemented as an active Tier 2 rule.
  - *M5 deferred (stubs only in M4)*: `competitor:pit_entry`, `competitor:pit_exit`, `gap:closing`, `gap:pulling_away`, `hero:pace_degradation` — rule functions return null and produce no alerts in M4.
  - *Note*: `hero:pit_exit` is **not** a deferred alert rule — it is consumed in M4 by the dedup tracker as the reset signal for pit-window deduplication (FR-016, T029). The event type must exist in M4 even though it produces no alert.
- **FR-004**: The priority message queue MUST process Tier 1 messages before any queued Tier 2 messages; full ordering rules including FIFO behavior for same-tier simultaneous alerts are defined in FR-005.
- **FR-005**: No audio clip MUST ever be interrupted mid-playback. Queue ordering rules: (1) Tier 1 messages dequeue before any Tier 2 messages; (2) two simultaneously enqueued Tier 1 alerts dequeue FIFO (arrival order); (3) a Tier 1 alert arriving during Tier 2 playback is inserted at the front of the pending queue, playing after the current clip finishes; (4) a Tier 1 alert arriving during another Tier 1 clip's playback queues immediately after; (5) Tier 2 alerts always queue behind all pending Tier 1 alerts. Note: rules (1)–(5) are enforced at the hub's `PriorityMessageQueue` layer only. Once a clip is dispatched to the Tauri client via `voice:audio`, all clips play FIFO with no reordering — the hub's Tier 1-head queue guarantees ordering before dispatch, making Tauri-side reordering unnecessary.
- **FR-006**: No alert MUST repeat while its triggering condition persists. Deduplication uses one of two key strategies depending on the alert type:
  - **Per-lap alerts** (`hero:fuel_critical`): dedup key is `{eventType}:{lapNumber}`. The alert fires at most once per lap while the condition persists, then re-enables automatically on the next lap. This is the correct behavior for fuel critical because there is no discrete "fuel recovered" event — the per-lap key gives the alert a natural once-per-lap cadence. No `recordCleared()` call is needed for per-lap alerts.
  - **Event-cleared alerts** (`hero:blue_flag`, `session:safety_car_deployed`, `hero:pit_limiter_active`, `hero:pit_window_open`): dedup key is `{eventType}` only (no lap number — persistent across laps). The alert fires once and is suppressed on every subsequent lap until its explicit clearing event arrives and calls `recordCleared({eventType})`. Clearing events: blue flag → `hero:blue_flag_cleared`; safety car → `session:safety_car_cleared`; pit limiter → `hero:pit_limiter_active` with `payload.active === false`; pit window → `hero:pit_exit`. This ensures the pit window alert fires exactly once per stint (US2 AC3) and re-fires only after a pit stop resets it (US2 AC4). After `recordCleared()`, a same-lap re-fire IS permitted if the condition re-triggers within the same lap.
- **FR-007**: The TTS service MUST convert alert text to an audio clip; the clip MUST be retrievable for at least 60 seconds after it is stored in `AudioStore` (`storedAt` timestamp — not from TTS request initiation) and then discarded by TTL eviction only (NOT deleted on fetch — a client may re-fetch within the window), served via a hub HTTP endpoint referenced by a unique key. Each clip reference MUST include a `generatedAt` timestamp (Unix ms, set at store time) to enable the client to discard stale clips received after a disconnect. On TTS failure (any tier), the alert MUST be dropped and a structured log entry MUST be emitted with: alert type, tier, lap number, failure reason, and timestamp. No retry is attempted.
- **FR-008**: The hub server MUST publish an `AudioClipRef` (a URL pointer to the clip, not the binary) to the Tauri client via the `voice:audio` Redis Pub/Sub channel (not Redis Streams); the Tauri client fetches the binary separately via the hub HTTP endpoint (FR-009).
- **FR-009**: The Tauri client MUST fetch the audio clip and play it through the user's configured audio output device.
- **FR-010**: Radio Blackout Zones MUST be configurable as static track-position ranges (expressed as lap distance percentage, 0.0–1.0) in a config file with format `{ "zones": [{ "lapDistPctStart": 0.4, "lapDistPctEnd": 0.6 }] }`; no UI editor is required for M4. If the file is missing or malformed, the system MUST treat it as `{ "zones": [] }` (entire lap is a safe window) and emit a structured warning log.
- **FR-011**: Chattiness setting MUST have two values: Low (suppresses Tier 2 alerts) and Default (all alerts active). If the hub server starts before the Tauri client has written the Chattiness preference, or if the Redis value is absent or unrecognized, the hub MUST default to Default and emit a structured warning log. This applies on every hub startup including first-run cold start where no Chattiness key has ever been written.
- **FR-012**: Familiarity and Aggression personality settings MUST exist as config placeholders set to their default values; they have no behavioral effect in M4.
- **FR-013**: The Tauri settings UI MUST include an audio device test panel with: a playback test button that generates and plays a sample TTS clip (shows loading state during synthesis with a 30-second timeout before transitioning to error state; on TTS failure or timeout shows "Audio synthesis failed — check Chatterbox service"; disabled with "No audio device configured" message if no output device is selected), a microphone input level meter, and a PTT trigger test.
- **FR-014**: Fuel critical threshold MUST be configurable (`fuelCriticalLapsRemaining`, default: 1.0 lap of fuel remaining). The Racing Engineer does NOT compute fuel consumption itself — it consumes the `lapsRemaining` value already calculated by the M3 fuel model and carried on the `hero:fuel_critical` event payload (the M3 model maintains a rolling per-lap burn-rate average, excluding out-/in-laps, and resets on pit exit). The M4 rule fires when `payload.lapsRemaining` is present (non-null) and `payload.lapsRemaining <= config.fuelCriticalLapsRemaining`, allowing a driver to set a stricter threshold than M3's internal emit gate. If `payload.lapsRemaining` is null or absent, the rule MUST NOT fire. This keeps fuel-consumption math in one place (M3) rather than duplicating it in the Racing Engineer.
- **FR-015**: Gap threshold for gap-crossing alerts MUST be configurable (default: 2.0 seconds). The `gapThresholdSeconds` config field IS present in `engineer-config.json` in M4 (as a placeholder); gap-crossing alert behavior is deferred to M5 — the rule function returns null in M4. Pace degradation config fields (`paceDegradationPctThreshold`, `paceDegradationRollingLaps`) are NOT added until M5 (YAGNI).
- **FR-016**: Pit window alert deduplication MUST reset when a `hero:pit_exit` event is received, enabling the pit window alert to fire again when the next stint's window opens.
- **FR-017**: A Tier 2 alert that cannot be delivered within 30 seconds of enqueue (because no safe window has been found) MUST be dropped from the queue and a structured warning log MUST be emitted with: alert type, enqueue timestamp, and reason ("no-safe-window-timeout"). This prevents indefinite silent holds when Radio Blackout Zone config is misconfigured.

### Key Entities

- **Alert**: A triggered event with tier (1 or 2), message text, timestamp, and a deduplication key derived per the two-strategy scheme in FR-006 (per-lap alerts key on `{eventType}:{lapNumber}`; event-cleared alerts key on `{eventType}` only).
- **AudioClip**: A generated TTS output held in hub server memory (in-process Map), referenced by a unique UUID key, with a 60-second TTL after which it is evicted from the Map. Served to the Tauri client via a hub HTTP endpoint.
- **Radio Blackout Zone**: A lap-distance-percentage range (0.0–1.0) within a lap during which Tier 2 alerts are suppressed; defined in static config.
- **Personality Config**: Driver-scoped settings object with fields: `chattiness` (Low | Default), `familiarity` (placeholder), `aggression` (placeholder).
- **Priority Message Queue**: An in-process ordered queue that separates Tier 1 and Tier 2 messages and respects gate conditions before dispatching.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Tier 1 alerts reach the driver's audio output within 3 seconds of the triggering telemetry event. "Normal conditions" means Chatterbox responding within its POC-0001-measured latency range (0.5–2s GPU). Automated validation (T027) uses a mocked TTS and measures hub-side latency only; full end-to-end timing is validated in the live deploy test (T048).
- **SC-002**: No duplicate alert for the same condition fires within the same lap (0 duplicates in a full-race simulation).
- **SC-003**: A pit window alert is delivered at the correct lap in a full practice lap deploy test, with the driver hearing it through speakers.
- **SC-004**: A fuel critical alert fires at the correct fuel threshold in the deploy test.
- **SC-005**: The audio device test panel allows a driver to confirm their output device is working without starting a race session (task completes in under 60 seconds from panel open). Validated manually via quickstart.md Scenario 6; automated UX timing assertion deferred to M5.
- **SC-006**: Tier 2 alerts held during a Radio Blackout Zone are delivered within 3 seconds of the zone ending. The dispatcher polls every 100ms, so worst-case delivery lag after zone exit is 100ms — well within the 3-second budget.
- **SC-007**: Setting Chattiness to Low results in zero Tier 2 alerts delivered in a simulated full-race scenario.

## Clarifications

### Session 2026-06-30

- Q: When a second Tier 1 alert fires while a first Tier 1 clip is mid-playback, should the current clip be interrupted? → A: No interruptions; all clips play to completion; Tier 1 alerts arriving during playback queue immediately after the current clip.
- Q: When TTS fails, should the alert be dropped silently or logged? → A: Drop for all tiers; emit a structured log entry with alert type, tier, lap number, failure reason, and timestamp — no retry.
- Q: What TTL should AudioClips have? → A: 60 seconds in the hub's in-process Map (covers deep queues and brief hub/client disconnects); clips are not stored in Redis.
- Q: When should pit window alert deduplication reset so it can fire again in a future stint? → A: On pit lane exit (driver exits pit lane after completing a pit stop).

## Assumptions

- The M3 telemetry event bus (Redis Streams) is fully operational and publishes lap-level and flag-level telemetry fields needed by alert rules.
- POC 0001 (TTS evaluation) has been completed; Chatterbox is the selected TTS engine and its API contract is known.
- The Tauri client already has a real-time channel from the hub server (established in prior milestones); audio clip references will be pushed over this existing channel.
- Fuel consumption rate is calculated by the M3 fuel model (rolling per-lap burn average), not by the Racing Engineer. M4 consumes the resulting `lapsRemaining` from the `hero:fuel_critical` event payload (and, if ever needed at dispatch time, the `hub:fuel-model:${sessionId}` KV snapshot). The Racing Engineer performs no fuel math of its own.
- "Same lap" for deduplication purposes means the same lap counter value as published in telemetry.
- Radio Blackout Zones in M4 are static config (JSON file per FR-010); no UI editor is in scope.
- The configured audio output device is stored in existing Tauri settings; the test panel reads from that setting, it does not change device selection.
- PTT key binding already exists in Tauri settings from prior milestones (or is a simple new field added to settings).
- The configured pit window lap range is static for all stints in a session — no per-stint range configuration is in scope for M4. After a pit stop and re-entry of the window, the same configured range applies.
- Fuel burn-rate history and its reset on pit exit are handled inside the M3 fuel model, not the Racing Engineer (see FR-014). M4 does not track fuel history.
- Radio Blackout Zone safe-window hold time is bounded at 30 seconds. If no safe window is found within 30 seconds of a Tier 2 alert being enqueued, the alert is dropped with a structured warning log (reason: "no-safe-window-timeout"). This prevents silent indefinite holds when static zone config is misconfigured.
- Competitor pit entry/exit data is available in iRacing telemetry at sufficient fidelity for gap-based alerts. (Confirmed for M5 readiness; competitor/gap alerts are not consumed in M4 — rule functions return null stubs per FR-003.)
- Pace degradation is defined as lap time increasing by more than a configurable percentage (default: 2%) over the rolling 3-lap average. (Algorithm defined for M5 readiness; not implemented in M4 — config fields and rule function are deferred per FR-015 and YAGNI.)
