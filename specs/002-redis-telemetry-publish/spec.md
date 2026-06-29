# Feature Specification: Redis Telemetry Publishing

**Feature Branch**: `002-redis-telemetry-publish`

**Created**: 2026-06-28

**Status**: Draft

**Input**: User description: "Redis telemetry publishing — wire the Tauri client to publish iRacing telemetry and session events to Redis so the hub server can consume them. This bridges the existing iRacing SDK diagnostic layer (spec 001) to the hub server. The Tauri client already reads connection status, session metadata, and live telemetry fields at 10 Hz from iRacing shared memory. The next step is publishing that data onto a Redis data bus so downstream consumers (hub server, Racing Engineer, Stream Engineer) can subscribe to it."

---

## Clarifications

### Session 2026-06-28

- Q: Does "all high-frequency iRacing telemetry variables" mean all ~350 available SDK fields or a curated subset? → A: All available SDK fields are published — the hub server and downstream consumers are responsible for filtering what they need. No fields are omitted at the publisher.
- Q: When Redis reconnects mid-session, does the client replay missed frames or publish a current-state snapshot only? → A: Snapshot-only — no buffering or replay of missed frames. Consumers must handle gaps. Semantics are best-effort / UDP-like: the publisher's job on reconnect is to emit an accurate "here is the current state" baseline, then resume live publishing.
- Q: Does the Redis instance require authentication (password) in the v1 local setup? → A: No authentication — Redis runs without credentials. The connection URL format is `redis://host:port` with no password. This is consistent with the local-first infrastructure principle; all consumers are on the same LAN or localhost.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Connection & Session Events on the Bus (Priority: P1)

As a developer standing up the hub server, I want to receive iRacing connection state changes and session metadata from the client on a message bus, so I can validate that the data pipeline is live and the hub's model of the race state stays current without polling the client directly.

**Why this priority**: Connection and session state are prerequisite context for every downstream consumer. The Racing Engineer cannot advise on pit strategy without knowing the track and session type; the Stream Engineer cannot select cameras without knowing whether a session is active. Everything else in the pipeline is meaningless if this handshake is broken.

**Independent Test**: Start the client with Redis running and iRacing not running. Use a Redis CLI subscriber to confirm a "Disconnected" event is present. Start iRacing, enter a practice session, and confirm a "Connected" event and a session metadata message both arrive on the bus within 2 seconds, without any manual action. Switch session type (practice → qualifying) and confirm an updated session metadata message arrives automatically.

**Acceptance Scenarios**:

1. **Given** the client is running and iRacing is not open, **When** a subscriber connects to the message bus, **Then** the subscriber can observe the client's current "Disconnected" state.
2. **Given** the client is showing "Disconnected", **When** iRacing starts and a session begins, **Then** a "Connected" event and a session metadata message appear on the bus within 2 seconds — without any manual client action.
3. **Given** the client is publishing session metadata for a practice session, **When** iRacing transitions to qualifying, **Then** an updated session metadata message reflecting the new session type appears on the bus within 2 seconds.
4. **Given** the client is publishing and iRacing is closed unexpectedly, **Then** a "Disconnected" event appears on the bus within 2 seconds and no further telemetry is published until reconnected.

---

### User Story 2 — High-Frequency Live Telemetry Stream (Priority: P2)

As a hub server developer, I want to receive a continuous high-frequency stream of time-critical telemetry data from the client so the Racing Engineer and Stream Engineer can react to track events within their latency budgets.

**Why this priority**: The Racing Engineer's core function — advising on fuel, gaps, and safety alerts — depends on real-time position, dynamics, and flag data arriving fast enough to be actionable. A stream that updates too slowly makes Tier 1 alerts (fuel critical, blue flag) dangerously stale. This stream is the Racing Engineer's primary sensory input.

**Independent Test**: With a Redis subscriber listening on the live telemetry channel, enter an active iRacing session and drive on track. Confirm that messages arrive at ≥ 60 per second and that fields such as speed, RPM, throttle, brake, and gear change in value as the car moves. Confirm that no gap between messages exceeds 50 ms during normal driving.

**Acceptance Scenarios**:

1. **Given** the client is connected to an active iRacing session, **When** a subscriber listens on the live telemetry channel, **Then** messages arrive at ≥ 60 per second continuously while on track, with no individual gap between consecutive messages exceeding 50 ms (see SC-002; this gap constraint is validated manually in T036 — quickstart.md Scenario 5 — not by automated CI tests).
2. **Given** live telemetry is publishing, **When** the car is moving, **Then** time-varying fields (speed, RPM, throttle, brake) visibly change across consecutive messages.
3. **Given** the client is connected but no session is active (main menu), **When** a subscriber listens on the live telemetry channel, **Then** no telemetry messages are published.
4. **Given** live telemetry is publishing at 60 Hz, **When** the message bus connection drops and reconnects, **Then** publishing resumes automatically without restarting the client (within 10 seconds of reconnect, per SC-004).

---

### User Story 3 — Session-Rate Strategy Telemetry Stream (Priority: P3)

As a hub server developer, I want to receive a lower-frequency stream of session-rate telemetry data — fuel level, tire condition, lap times, race positions, and competitor gaps — so the Racing Engineer's fuel and tire models remain current throughout the stint.

**Why this priority**: Fuel and tire calculations require data that changes on a lap-by-lap or stint-by-stint cadence. Publishing this data on a separate, lower-frequency channel keeps it cleanly decoupled from the high-frequency live stream that drives real-time reactions, and avoids forcing the fuel/tire models to process 60 Hz noise when they only need updates every ~67 ms.

**Independent Test**: With a Redis subscriber listening on the session-rate telemetry channel, enter a session and drive for several laps. Confirm messages arrive at ≥ 15 per second. Confirm fuel level decreases across messages over the course of a lap. Confirm lap time and position fields update at lap boundaries.

**Acceptance Scenarios**:

1. **Given** the client is connected to an active session, **When** a subscriber listens on the session-rate telemetry channel, **Then** messages arrive at ≥ 15 per second.
2. **Given** session-rate telemetry is publishing across a lap, **When** fuel is consumed, **Then** the fuel level field decreases across consecutive messages.
3. **Given** a lap completes, **When** the next session-rate telemetry message arrives, **Then** the lap time field reflects the most recently completed lap.
4. **Given** session-rate telemetry is publishing, **When** the message bus is unavailable, **Then** the client continues reading iRacing data normally and resumes publishing when the bus is restored.

---

### User Story 4 — Configurable & Gracefully Degraded Connection (Priority: P4)

As a developer setting up the system for the first time, I want to configure the message bus connection URL in the client settings and have the client continue working normally if the bus is unavailable, so I can bring up the data pipeline incrementally without bricking the client.

**Why this priority**: Graceful degradation is required by the project constitution. The client is the sole source of iRacing data; a hard dependency on the message bus would mean a misconfigured Redis URL kills the diagnostic UI and data collection for all downstream features. This must be a soft dependency.

**Independent Test**: Set an invalid Redis URL in client settings. Confirm the client starts normally, the diagnostic UI (from spec 001) is fully functional, and a `warn!` log entry is emitted (see FR-013). Correct the URL. Confirm the client reconnects and begins publishing without a restart.

**Acceptance Scenarios**:

1. **Given** the Redis URL is not configured or invalid, **When** the client starts, **Then** the client starts normally, iRacing data reading continues, and the diagnostic UI is fully functional — only the publishing path is inactive.
2. **Given** the client is running with a valid Redis URL, **When** the Redis service becomes unreachable mid-session, **Then** the client continues reading iRacing data without interruption, logs a warning, and attempts reconnection in the background.
3. **Given** the client is reconnecting to Redis, **When** Redis becomes reachable again, **Then** the client publishes the current connection and session state as a snapshot before resuming the telemetry streams.
4. **Given** the client UI settings, **When** the user updates the Redis URL, **Then** the client applies the new URL on the next reconnect attempt after any connection loss — no active teardown or restart is triggered; the URL takes effect passively on the next backoff reconnect cycle (FR-010). See quickstart.md Scenario 9 for the manual validation procedure, including the extended case where the URL is changed while Redis is actively connected.

---

### Edge Cases

- What happens if Redis is unavailable at app start? → Client starts normally; publishing path stays inactive with a warning log; no crash or degraded UI.
- What happens if the Redis connection drops mid-session at high frequency? → Client does NOT buffer or replay missed frames. On reconnect, it publishes a current-state snapshot then resumes live publishing. See FR-009 for the canonical two-path snapshot behavior.
- What happens if iRacing crashes (not graceful shutdown) while publishing? → See FR-009 path (a): watcher detects the disconnection within 2 seconds, emits `ConnectionEvent(Disconnected)` AND `SessionEvent(None)`, stops telemetry publishing.
- What happens if Redis reconnects during an active iRacing session? → See FR-009 paths (b) and (c) for the canonical three-path snapshot behavior — no replay of missed frames.
- What if the configured Redis URL changes while telemetry is actively publishing? → Applies on next reconnection attempt; in-progress publishing is not interrupted mid-frame.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The client MUST publish iRacing connection state changes (Connected, Disconnected) to the message bus within 2 seconds of the state transition.
- **FR-002**: The client MUST publish iRacing session metadata (track name, car name, session type, wall-clock time, player car index (`player_car_idx`), and an `active` boolean discriminant — see data-model.md §SessionEvent) to the message bus whenever a session begins, the session type changes, or the session ends (a session-type change emits a single updated `SessionEvent` reflecting the new type — not two events; the watcher overwrites `current_session` in place, so no session-end event precedes the new-type event). On session end, a `SessionEvent` with `{"active":false}` MUST be published (not a JSON null or an omitted message — see data-model.md §SessionEvent). See also FR-009 for the reconnect snapshot behavior, including the sub-case where iRacing is Connected but `current_session` is None (main menu state).
- **FR-003**: The client MUST publish live telemetry data from an active iRacing session to a dedicated high-frequency channel at ≥ 60 messages per second. Delivery is best-effort: individual ticks may be delayed by OS timer jitter (Windows: 15–20 ms variance per tick) and missed frames are NOT retried or buffered — the channel uses XADD with `MAXLEN ~` (approximate trimming — see `data-model.md` §LiveTelemetryFrame and `contracts/redis-streams.md` for the exact wire format `XADD iracing:telemetry:live MAXLEN ~ 3600 * field value ...`): the stream is always writable and XADD never blocks or rejects; when the stream exceeds MAXLEN the oldest entries are trimmed from the tail. This is semantically equivalent to "drop oldest on full" — the newest frames are always preserved. Field-to-category assignment (high-frequency vs. session-rate) is defined in `data-model.md` §Classification Rule; `SESSION_RATE_FIELDS` in `publisher_task.rs` is the runtime authority. See SC-002 for the inter-message gap constraint (the rate and gap constraints are complementary, not redundant).
- **FR-004**: The client MUST publish session-rate telemetry data from an active iRacing session to a dedicated session-rate channel at ≥ 15 messages per second.
- **FR-005**: High-frequency telemetry and session-rate telemetry MUST be published to separate, independently subscribable channels.
- **FR-006**: The client MUST stop publishing telemetry and emit a Disconnected event within 2 seconds of iRacing becoming unavailable. See FR-009 path (a) for the full dual-event behavior: an iRacing disconnect emits BOTH `ConnectionEvent(Disconnected)` AND `SessionEvent(active:false)` — not a single event. "A Disconnected event" in FR-006 refers to the ConnectionEvent; the SessionEvent is additionally required per FR-009 path (a).
- **FR-007**: The client MUST NOT crash or degrade iRacing data reading or the diagnostic UI if the message bus is unavailable at startup or becomes unavailable mid-session.
- **FR-008**: The client MUST attempt to reconnect to the message bus automatically after a connection loss, using exponential backoff (100 ms initial delay, 2× multiplier per retry, 8 s ceiling). The ceiling is kept below the SC-004 10 s reconnect budget.
- **FR-009**: Upon connecting (or reconnecting) to the message bus — including app first launch — the client MUST publish a snapshot of current connection and session state before resuming telemetry publishing. The client MUST NOT buffer or replay frames missed during the disconnection — publishing has best-effort, stateless semantics and consumers are responsible for handling gaps. Three distinct paths exist with different snapshot behaviors: (a) **iRacing disconnects** (watcher detects iRacing gone) → client emits `ConnectionEvent(Disconnected)` AND `SessionEvent(None)` — session ends with iRacing; (b) **Redis publisher connects/reconnects while iRacing is Disconnected** → client emits only `ConnectionEvent(Disconnected)` snapshot, no `SessionEvent`, because there is no active session to snapshot; (c) **Redis publisher connects/reconnects while iRacing is Connected** → client emits `ConnectionEvent(Connected)` AND a `SessionEvent` reflecting the current `current_session` value — if `current_session` is `None` (main menu state), this produces `SessionEvent(None)` (`{"active":false}`); if `current_session` is `Some(session)`, this produces the full session metadata snapshot. Path (a) applies on every iRacing disconnect regardless of Redis state. Paths (b) and (c) apply during the publisher connect/reconnect sequence and are exclusive to one another based on current iRacing connection status.
- **FR-010**: The message bus connection URL MUST be configurable in the Tauri client settings UI without requiring a client restart. The new URL takes effect passively on the next reconnect attempt driven by the backoff cycle — no active teardown or forced reconnect is implemented; no app restart is needed. If Redis is currently connected, the URL change applies after the next connection loss triggers a reconnect. "Connection loss" means any disconnect detected by the publisher, regardless of cause (deliberate Redis shutdown, network failure, crash, or any other reason).
- **FR-011**: When the iRacing session is not active (client connected to iRacing but no session in progress), the client MUST NOT publish telemetry data but MUST maintain its message bus connection. The session is considered "not active" when `current_session` is `None` (no session YAML from iRacing). Being in the pit garage between stints is considered an active session if the session YAML remains set; only the main menu / lobby state constitutes "no session." The `IsInGarage` telemetry field has no bearing on session suppression — only the presence or absence of the session YAML (`current_session`) determines the active/inactive state.
- **FR-012**: The message bus service MUST be defined as a self-hosted Docker Compose service in the project infrastructure before any client code publishes to it.
- **FR-013**: Failed message bus connection attempts MUST be logged as warnings; successful connections and disconnections MUST be logged as info. **Validation method**: code review only (T030 tracing audit — see tasks.md Phase 7) — mocking the `tracing` subscriber in automated tests is complex and not required; any missing `warn!` or `info!` calls found during T030 are defects that must be fixed before PR merge (T032 build gate).
- **FR-014**: The hub server MUST serve living documentation for the Redis stream contract and data model at `/docs/...`, compiled from MDX source files co-located in `apps/hub-server/src/docs/`. Required routes: `/docs/` (landing page), `/docs/data-model` (ConnectionEvent, SessionEvent, LiveTelemetryFrame, SessionTelemetryFrame entity schemas and field classification), `/docs/contracts/redis-streams` (stream keys, MAXLEN values, XADD wire format, consumer patterns). Implemented via `@mdx-js/rollup` Vite plugin + hono-preact `contentRoutes` (see tasks.md Phase 9).

### Key Entities

- **Connection Event**: A timestamped record of an iRacing connection state transition (Connected or Disconnected).
- **Session Event**: A timestamped snapshot of current session metadata (track name, car name, session type, wall-clock time, player car index (`player_car_idx`)), or a null/ended marker when the session terminates. `player_car_idx` identifies the broadcasting player and is used to index into CarIdx arrays in the telemetry streams — see data-model.md §SessionEvent for the source field (`DriverInfo.DriverCarIdx`).
- **Live Telemetry Frame**: A timestamped snapshot of all available iRacing SDK telemetry fields categorized as high-frequency (fast-changing dynamics and position data). All SDK fields in this category are included — no fields are filtered at the publisher. The hub server and downstream consumers are responsible for selecting the subset they need.
- **Session Telemetry Frame**: A timestamped snapshot of all available iRacing SDK telemetry fields categorized as session-rate (slow-changing strategy and condition data). All SDK fields in this category are included — no fields are filtered at the publisher. Field-to-category assignment is defined in the implementation plan.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Connection state changes from iRacing are visible to message bus subscribers within 2 seconds of the actual transition — both connect and disconnect.
- **SC-002**: Live telemetry frames are published at ≥ 60 per second during an active on-track session, with no message gap exceeding 50 ms. At the nominal 16 ms tick rate with up to 20 ms of Windows timer jitter per tick, a single jitter-affected gap adds at most 36 ms — well within the 50 ms budget. The 50 ms threshold is the governing constraint; it does not correspond to a fixed count of consecutive missed ticks, since jitter magnitude varies per tick. **Validation method**: manual Windows test only (T025, Scenario 4) — the 50 ms gap constraint is determined by the watcher tick rate rather than the publish path and cannot be measured in CI without a real iRacing session; CI tests (T011, T017, T021, T024 — see tasks.md §SC-007 Integration Test Mapping) validate round-trip correctness but not publish rate. SC-004 (reconnect timing) is also validated manually in T025 Scenario 9. **PR merge requirement**: the `XRANGE iracing:telemetry:live - + COUNT 20` timestamp output (or equivalent screenshot) showing ≤50 ms gaps MUST be posted as a PR comment before merge — this is the sole compliance proof, required in **tasks.md T036** (quickstart.md Scenario 5).
- **SC-003**: Session telemetry frames are published at ≥ 15 per second during an active on-track session.
- **SC-004**: When the message bus becomes reachable after a period of unavailability, the client resumes publishing within 10 seconds, without user intervention or client restart. **Validation method**: arithmetic guarantee only — the backoff ceiling is 8 s (FR-008), which is below the 10 s budget, so compliance is proven by constants rather than a CI timing test. No CI test exercises the full backoff sequence from 100 ms to the 8 s ceiling. Validated manually via quickstart.md Scenario 2 (T033). This is consistent with the SC-002 manual-only treatment.
- **SC-005**: The client's diagnostic UI and iRacing data reading remain fully functional when the message bus is unavailable — no error states, no blank panels, no crashes. **Validation method**: manual only (T033 — quickstart.md Scenario 1).
- **SC-006**: Session metadata is visible to subscribers within 2 seconds of a session type change in iRacing.
- **SC-007**: Seven round-trip integration tests (connection event, live frame, session-rate frame, FR-009 path a dual-event, FR-009 path b negative case, FR-009 path c-None dual-event, FR-009 path c-Some full-metadata dual-event — as defined in tasks.md T011, T017, T021, T024 — T011 contributes 4 of the 7 tests; T017, T021, T024 contribute one each — see §SC-007 Integration Test Mapping) pass in CI on a non-Windows runner (ubuntu-latest) using a local Docker Redis instance, on every PR targeting `main`. Note: the path (b) CI test (T024) exercises the `publish_snapshot` branching function directly — calling it with `Disconnected` status and asserting no SessionEvent is emitted — but does not cover the outer reconnect loop's decision to invoke `publish_snapshot` with the correct status read from AppState; that caller decision is validated manually via quickstart.md Scenario 7 — this is an accepted limitation documented in plan.md §Constitution Check (Principle VI).
- **SC-008**: `infra/docker-compose.yml` contains a `redis:7-alpine`-compatible service on port 6379 with `--appendonly yes` persistence before any publisher code is merged (FR-012). Verified by T001 (tasks.md Phase 1 gate) — this is a precondition, not a post-implementation check; no PR targeting the publisher code may pass until T001 confirms the service is present.
- **SC-009**: All three hub server documentation routes (`/docs/`, `/docs/data-model`, `/docs/contracts/redis-streams`) render without console errors when the hub server is running in development mode (FR-014). **Validation method**: manual developer check during T043 — open each route in a browser with the hub server running via `npm run dev -w apps/hub-server`.

---

## Assumptions

- The Tauri client's existing iRacing watcher (spec 001) currently ticks at 10 Hz for the diagnostic watchlist. This feature requires upgrading the watcher's internal tick rate to support 60 Hz live telemetry publishing — the watchlist UI continues to function at approximately its current 10 Hz update rate; the tick upgrade (Phase 4, T012) changes the watchlist cadence from 100 ms to ~96 ms (6 × 16 ms tick), which is functionally equivalent. The underlying read loop must run faster to support live telemetry.
- All available iRacing SDK telemetry fields are published — no publisher-side filtering by field name. The implementation plan defines which fields are classified as high-frequency (live stream, 60 Hz) vs session-rate (session stream, 15 Hz). A reasonable default split: live stream = dynamics and position data (speed, RPM, throttle, brake, steering, gear, lateral G, track position, flags); session stream = strategy data (fuel level, tire temps, tire wear, lap times, race positions, competitor gaps). Every SDK field appears on exactly one stream.
- Redis Streams is the message bus technology, as specified in the project constitution (Technology Constraints, "Telemetry bus: Redis Streams").
- Stream retention (maxlen) is sized to hold approximately 60 seconds of data at the publishing rate — enough for consumers to catch up after brief lag without unbounded memory growth. Exact values (finalized in plan and data-model.md): live stream MAXLEN 3600 (~60 s at 60 Hz), session-rate MAXLEN 900 (~60 s at 15 Hz), event streams MAXLEN 100.
- The Tauri client's settings UI is expected to have a connection configuration section. The Redis URL field is added to this existing settings panel if present; the exact component file is confirmed at implementation time by reading `apps/tauri-client/src/`. `AppConfig.redis_url` and the `save_config` Tauri command are assumed to exist in the scaffold or are added as part of US4 wiring.
- No hub server code is written in this feature — this feature ends at the publishing boundary. The hub server's subscriber implementation is a separate feature.
- Message schema (field names, JSON structure) for all four entity types will be defined in `packages/types` as part of this feature, before any consuming code references them.
- The iRacing session is considered "not active" when the client is connected but the session info YAML reports no active session (e.g., driver is in the main menu or garage). Telemetry is suppressed in this state.
- Docker Compose Redis service is confirmed present in the scaffold (`infra/docker-compose.yml` — `redis:7-alpine`, port 6379, AOF persistence). FR-012 is pre-satisfied; T001 (tasks.md Phase 1) verifies this before Phase 2 begins.
- The Redis service runs without password authentication in v1. The connection URL format is `redis://host:port` with no credentials. This is appropriate given the local-first infrastructure principle — all clients are on the same machine or home LAN.
