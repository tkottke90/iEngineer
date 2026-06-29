---
description: "Task list for Redis Telemetry Publishing"
---

# Tasks: Redis Telemetry Publishing

**Input**: Design documents from `specs/002-redis-telemetry-publish/`

**Prerequisites**: plan.md ✅ spec.md ✅ research.md ✅ data-model.md ✅ contracts/redis-streams.md ✅ quickstart.md ✅

**Tests**: Integration tests are explicitly required by the spec (SC-007 mandates 7 round-trip CI tests). Test tasks are included and must be written before their corresponding implementations.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no dependencies between [P] tasks in the same phase)
- **[Story]**: Maps to spec.md user story (US1–US4)
- File paths are exact and relative to repo root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Gates, CI infrastructure, and shared type foundations that must exist before any story work begins.

- [ ] T001 Verify `infra/docker-compose.yml` has a `redis:7-alpine` service on port 6379 with `command: redis-server --appendonly yes` — SC-008 gate; no publisher code may be merged until this is confirmed (pre-satisfied per spec §Assumptions, but must be formally checked as T001); run `grep 'redis:7-alpine' infra/docker-compose.yml` as a scripted spot-check — if no output, the SC-008 assumption is violated and work must stop until the service is added
- [ ] T002 Create or update `.github/workflows/ci.yml` with these **required** steps on every PR targeting `main`:
  1. `run: grep 'redis:7-alpine' infra/docker-compose.yml || (echo 'SC-008 violation: Redis service missing from docker-compose' && exit 1)` — scripted SC-008 gate; must run before tests
  2. `services: redis:7-alpine` (port 6379) on the integration test job
  3. `run: cargo test -p iracing-engineer-lib -- --test-threads=1` on `ubuntu-latest` (SC-007 — **Note**: this step will produce "0 tests passed" on early PRs before Phase 3–6 test tasks are implemented; this is expected and not a failure — the step validates CI infrastructure exists; T031 enforces the full 7-test count before the final PR)
  4. `run: npm run build -w apps/hub-server` — **required** (not advisory); catches broken MDX compilation or misconfigured `contentRoutes` before T038–T043 are merged; this is the automated portion of SC-009 validation since no CI runtime server test exists
- [ ] T003 [P] Add `mocha`, `chai`, `@types/mocha`, `@types/chai`, `tsx`, `@types/node` devDependencies and `"test": "mocha --require tsx/esm 'test/**/*.test.ts'"` script to `packages/types/package.json` — `tsx` is required by the mocha command; if `tsx` is already present in the workspace root, note the version but still add it explicitly to `packages/types` to avoid implicit dependency on root hoisting
- [ ] T004 [P] Add `player_car_idx: u32` field to `SessionInfo` struct in `apps/tauri-client/src-tauri/src/iracing/types.rs`; update `parse_session_info` in `apps/tauri-client/src-tauri/src/iracing/watcher.rs` to read `DriverInfo.DriverCarIdx` (a root-level integer in the YAML, not `Drivers[0].CarIdx`) — `DriverCarIdx` is the reliable player car index and is stable across multi-driver team configurations; also confirm `player_car_name` is read from `DriverInfo.Drivers[0].CarScreenNameShort` (confirmed in data-model.md §SessionEvent — this IS `Drivers[0]` syntax but for the car name field, not the car index)

**Checkpoint**: Infrastructure ready — CI can run Rust integration tests against Docker Redis; TypeScript test runner configured; `SessionInfo` carries `player_car_idx` for use in session events.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core scaffolding that all user stories depend on. No story work can begin until this phase is complete.

**⚠️ CRITICAL**: T005–T010 all block US1–US4. Complete this phase before any story phase.

- [ ] T005 Create `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` — stub file declaring: stream key constants (`LIVE_STREAM = "iracing:telemetry:live"`, `SESSION_STREAM = "iracing:telemetry:session"`, `CONN_EVENT_STREAM = "iracing:events:connection"`, `SESSION_EVENT_STREAM = "iracing:events:session"`); MAXLEN constants (`LIVE_MAXLEN: u64 = 3600`, `SESSION_MAXLEN: u64 = 900`, `EVENT_MAXLEN: u64 = 100`); `SESSION_RATE_FIELDS: once_cell::sync::Lazy<HashSet<&'static str>>` initialized with the full session-rate field name set — **transcribe exclusively from `data-model.md` §SessionTelemetryFrame field table** (not from memory or this task description), which is the single authoritative source; if `data-model.md` changes after T005 is implemented, T005 must be re-visited; current field list from `data-model.md` includes: (FuelLevel, FuelLevelPct, FuelUsePerHour, WaterTemp, OilTemp, OilPress, all tire temp/wear fields, lap timing fields, position fields, CarIdx arrays for positions/laps/times/gaps/status, pit service fields); **field name accuracy**: strings in SESSION_RATE_FIELDS must exactly match what `sdk.enumerate_vars()` returns — including capitalization — **before implementing T022–T023** (the session-rate publish tasks), cross-check at least 5 representative names (e.g. `FuelLevel`, `WaterTemp`, `LFtempCL`, `LapLastLapTime`, `CarIdxPosition`) against the iRacing SDK field docs or an existing telemetry test in the repo; a mismatch causes silent publish failures because CI mock vecs bypass the SDK entirely; T031 provides a final cross-check but does not substitute for pre-implementation verification
- [ ] T006 [P] Add `session_watch_tx: tokio::sync::watch::Sender<Option<SessionInfo>>` and `_session_watch_rx: tokio::sync::watch::Receiver<Option<SessionInfo>>` to `AppState` in `apps/tauri-client/src-tauri/src/state.rs`; initialize in `AppState::default()` with `watch::channel(None)`
- [ ] T007 Update `apps/tauri-client/src-tauri/src/iracing/watcher.rs` to send on `state.session_watch_tx` in two places: (1) in `emit_disconnected` after `*s = None` to send `None`; (2) in the session-update branch after `*state.current_session.lock().unwrap() = session_info.clone()` to send the new value
- [ ] T008 [P] Update `apps/tauri-client/src-tauri/src/telemetry/publisher.rs` — **first read the file to discover the actual `publish_live` signature before T017 writes its test** (A3: if T017 is written assuming the wrong signature, the test must be reworked after the fact); then: rename `LIVE_STREAM` constant to `"iracing:telemetry:live"`; rename `SESSION_STREAM` to `"iracing:telemetry:session"`; update `LIVE_MAXLEN` from 600 to 3600; update session-rate MAXLEN from hardcoded 600 to 900; add `pub async fn publish_event(&mut self, stream: &str, payload_json: &str) -> Result<()>` method that XADDs `("payload", payload_json)` with the given stream key and MAXLEN 100; confirm or update `pub async fn publish_live(&mut self, fields: Vec<(&str, &str)>) -> Result<()>` to accept this exact signature — T017 and T019 depend on it from publisher_task; **T008 must complete before T017 is written** so the confirmed signature is known
- [ ] T009 [P] Create `packages/types/src/redis-events.ts` — export `ConnectionEvent` interface (`status: 'Connected' | 'Disconnected'; ts: number`) and `SessionEvent` interface (`active: boolean; ts: number; track_name?: string; player_car_name?: string; player_car_idx?: number; session_type?: string; wall_clock_time?: string`); export `isConnectionEvent(v: unknown): v is ConnectionEvent` and `isSessionEvent(v: unknown): v is SessionEvent` runtime validators; re-export both from `packages/types/src/index.ts`
- [ ] T010 [P] Write `packages/types/test/redis-events.test.ts` — mocha+chai tests covering: `isConnectionEvent` accepts valid Connected/Disconnected shapes and rejects missing fields; `isSessionEvent` accepts `active:false` (ts only), accepts `active:true` with all required optional fields present including `player_car_idx`; rejects `active:true` with missing `track_name`; rejects non-object input

**Checkpoint**: Foundation ready — stream keys, MAXLEN, SESSION_RATE_FIELDS, event structs, AppState watch channels, and TypeScript types all in place. User story phases can now proceed.

---

## Phase 3: User Story 1 — Connection & Session Events (Priority: P1) 🎯 MVP

**Goal**: Connection state changes and session metadata are observable on `iracing:events:connection` and `iracing:events:session` within 2 seconds of the actual transition.

**Independent Test**: With Redis running and iRacing open, use `redis-cli XREAD COUNT 10 BLOCK 5000 STREAMS iracing:events:connection iracing:events:session 0` — confirm `ConnectionEvent(Connected)` and `SessionEvent(active:true, player_car_idx: N)` both appear within 2s of iRacing opening. Close iRacing — confirm `ConnectionEvent(Disconnected)` and `SessionEvent(active:false)` within 2s. (quickstart.md Scenarios 3+4)

### Tests for User Story 1

> **Write these tests FIRST — they must fail before T013–T016 are implemented**

- [ ] T011 [P] [US1] Write 4 integration tests in `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` `#[cfg(test)]` block — `test_connection_event_roundtrip`: XADD a `ConnectionEvent(Connected)` payload to Redis, XRANGE back, parse JSON, assert `status=="Connected"` and `ts` is present; `test_fr009_path_a_dual_event`: call `publish_snapshot(publisher, Disconnected, None, SnapshotReason::IracingDisconnected)`, assert BOTH `iracing:events:connection` (Disconnected) AND `iracing:events:session` (active:false) each receive exactly one new entry — path (a) always emits both; `test_fr009_path_c_none`: call `publish_snapshot(publisher, Connected, None, SnapshotReason::RedisConnected)`, assert `iracing:events:connection` receives `Connected` and `iracing:events:session` receives `active:false`; `test_fr009_path_c_some`: call `publish_snapshot(publisher, Connected, Some(session), SnapshotReason::RedisConnected)` with a populated `SessionInfo`, assert `iracing:events:session` payload has `active:true`, `player_car_idx` present, `track_name` matching. **TDD stub note**: T012 and T013 (`ConnectionEventPayload`, `SessionEventPayload`, `SnapshotReason`, `publish_snapshot`) must exist as at minimum stub types for this file to compile — add empty struct bodies and `async fn publish_snapshot(...) { unimplemented!("stub — implement in T013") }` so tests compile but PANIC (not silently pass) until real logic is wired in T013; do NOT use a no-op stub that returns `Ok(())` without publishing — that would cause tests to pass vacuously

### Implementation for User Story 1

- [ ] T012 [US1] Define `ConnectionEventPayload { pub status: &'static str, pub ts: u64 }` and `SessionEventPayload { pub active: bool, pub ts: u64, pub track_name: Option<String>, pub player_car_name: Option<String>, pub player_car_idx: Option<u32>, pub session_type: Option<String>, pub wall_clock_time: Option<String> }` Rust structs with `#[derive(Serialize)]` and `#[serde(skip_serializing_if = "Option::is_none")]` in `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs`; add helper `fn unix_ms() -> u64` returning system time as epoch milliseconds
- [ ] T013 [US1] Define `enum SnapshotReason { IracingDisconnected, RedisConnected }` and implement `async fn publish_snapshot(publisher: &mut RedisPublisher, status: &ConnectionStatus, current_session: &Option<SessionInfo>, reason: SnapshotReason)` in `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` — three distinct behaviors matching FR-009: **path (a)** `reason==IracingDisconnected` → always emit BOTH `ConnectionEvent(Disconnected)` to `iracing:events:connection` AND `SessionEvent(active:false)` to `iracing:events:session` (iRacing just disconnected; both connection and session state changed together); **path (b)** `reason==RedisConnected` + `status==Disconnected` → emit ONLY `ConnectionEvent(Disconnected)` to `iracing:events:connection` (Redis just reconnected; iRacing was already Disconnected; no session state to snapshot); **path (c)** `reason==RedisConnected` + `status==Connected` → emit `ConnectionEvent(Connected)` to `iracing:events:connection` AND `SessionEvent` (active:false if session is None, full payload if session is Some) to `iracing:events:session`
- [ ] T014 [US1] Implement connection state change monitoring in publisher_task inner loop — hold a `watch::Receiver<ConnectionStatus>` cloned from AppState; use `receiver.changed().await` in a `tokio::select!`; on transition to **Disconnected**: call `publish_snapshot(..., SnapshotReason::IracingDisconnected)` — this is path (a) and MUST emit both events; on transition to **Connected**: call `publish_snapshot(..., SnapshotReason::RedisConnected)` — this covers iRacing reconnect while Redis is already up (path c sub-case); the outer reconnect loop calls `publish_snapshot(..., SnapshotReason::RedisConnected)` on initial Redis connect (paths b/c)
- [ ] T015 [US1] Implement session change detection in publisher_task inner loop — track `last_sdk_session_update: i32 = -1` alongside the existing 16ms tick; on each tick call `IracingSDK::open()` (already done for telemetry reads), then `sdk.session_info_update()`; when the counter differs from `last_sdk_session_update`: re-read `AppState.current_session`, serialize updated `SessionEventPayload`, call `publisher.publish_event(SESSION_EVENT_STREAM, &json)`, update both `last_sdk_session_update` and `last_published_session`; this matches the counter-based pattern already used in `watcher.rs` (`last_session_update: i32`) and avoids deep equality on `SessionInfo`; skip the session event emit if `sdk.session_info_update()` returns -1 (pre-session sentinel — same as watcher.rs initialization); note: plan.md Phase 3 T010 describes a `last_published_session` deep-equality approach — that is superseded by this counter-based method (no `last_published_session` field is needed)
- [ ] T016 [US1] Add FR-013 structured logging to `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` — `info!("redis publisher connected: {}", url)` immediately after successful connect; `info!("redis publisher disconnected — reconnecting")` when inner loop exits; `warn!("redis connect attempt {} failed: {}", attempt, e)` on each backoff iteration

**Checkpoint**: US1 complete when T011 tests pass in CI and quickstart.md Scenarios 3+4 pass on Windows (connection and session events within 2s, `player_car_idx` visible in SessionEvent payload).

---

## Phase 4: User Story 2 — High-Frequency Live Telemetry (Priority: P2)

**Goal**: All iRacing live-stream SDK fields published at ≥60 Hz on `iracing:telemetry:live` during an active on-track session, with no inter-message gap exceeding 50ms.

**Independent Test**: With an active on-track session, `XRANGE iracing:telemetry:live - + COUNT 20` returns entries with `Speed`, `RPM`, `Throttle`, `Brake`, `Gear` fields changing between entries; `_ts` deltas ≤50ms. No entries when at main menu. (quickstart.md Scenario 5)

### Tests for User Story 2

> **Write this test FIRST — it must fail before T018–T020 are implemented**

- [ ] T017 [P] [US2] Write integration test `test_live_frame_roundtrip` in `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` `#[cfg(test)]` — build a mock live field vec: `[("_ts", "1719619200123"), ("Speed", "42.37"), ("RPM", "6800"), ("Gear", "4"), ("Throttle", "0.82"), ("Brake", "0.0"), ("SessionFlags", "0")]`; call `publisher.publish_live(fields)` (after adapting to accept `Vec<(&str, &str)>`); XRANGE `iracing:telemetry:live`; assert entry has `Speed == "42.37"` and `_ts == "1719619200123"`

### Implementation for User Story 2

- [ ] T018 [US2] Upgrade watcher tick rate in `apps/tauri-client/src-tauri/src/iracing/watcher.rs` — **sequence AFTER T007** (T007 also modifies `watcher.rs` to add `session_watch_tx` sends; implementing T018 before T007 is complete will cause a merge conflict in the same file; these two tasks must be done sequentially, not in parallel); — change `TICK_SLEEP` from `Duration::from_millis(100)` to `Duration::from_millis(16)`; add `const WATCHLIST_EVERY_N_TICKS: u32 = 6`; wrap the watchlist emit block (lines that call `sdk.populate_var_offsets()` and `handle.emit("iracing://telemetry-tick", ...)`) inside `if tick % WATCHLIST_EVERY_N_TICKS == 0`; change `CONNECT_EVERY_N_TICKS` from `5` to `30`; add comment explaining tick rate rationale (16ms → 60Hz; watchlist every 96ms ≈ 10Hz)
- [ ] T019 [US2] Implement live telemetry field reads and 60 Hz publish in publisher_task inner loop in `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` — on each tokio interval tick (16ms) when connected: call `IracingSDK::open()`, then `sdk.populate_var_offsets()`, then `sdk.enumerate_vars()`; for each `TelemetryField` whose name is NOT in `SESSION_RATE_FIELDS`: serialize `TelemetryValue` to string; prepend `("_ts", unix_ms_str)` entry; call `publisher.publish_live(fields).await`; catch and `warn!` any error, break inner loop; for `TelemetryValue` serialization, first check the existing `publisher.rs` for its current approach — use `format!("{}", value)` for scalar variants and `serde_json::to_string(...)` for array variants (or reuse the same helper already in `publisher.rs`)
- [ ] T020 [US2] Implement session suppression gate in publisher_task in `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` — before building any telemetry field vec, check `AppState.current_session.lock().unwrap().is_none()`; skip both `publish_live` and `publish_session` calls entirely when no session; log a single `info!("telemetry publish suppressed — no active session")` when transitioning from active to suppressed state (FR-011); track a `was_suppressed: bool` local variable (initialized `false`) so the `info!` fires only on the first tick where `current_session` becomes None — not on every suppressed tick; add a `#[test]` unit test `test_was_suppressed_flag_logic` that directly exercises the flag state machine: simulate `was_suppressed=false` + `current_session=None` → assert `info!` fires and flag becomes `true`; then simulate second tick with `was_suppressed=true` + `current_session=None` → assert `info!` does NOT fire; then `current_session=Some(...)` → assert flag resets to `false` (this is a pure state-machine test; no Redis connection required) (G3). **Accepted limitation**: no dedicated CI integration test verifies the suppression path — the 7 SC-007 tests cover event and telemetry frame round-trips but not the "no-publish when `current_session` is None" behavior. This is validated manually via quickstart.md Scenario 8 — see T037 for the manual validation task (same tradeoff as FR-009 path (b) branching, documented in plan.md §Constitution Check Principle VI).

**Checkpoint**: US2 complete when T017 test passes in CI and quickstart.md Scenario 5 (SC-002 ≤50ms gap evidence) passes on Windows. The XRANGE output must be posted as a PR comment before merge.

---

## Phase 5: User Story 3 — Session-Rate Strategy Telemetry (Priority: P3)

**Goal**: Session-rate SDK fields (fuel, tires, lap times, positions, gaps) published at ≥15 Hz on `iracing:telemetry:session` during an active session.

**Independent Test**: With an active session and driving, `XRANGE iracing:telemetry:session - + COUNT 20` shows entries with `FuelLevel`, `LapLastLapTime`, `CarIdxPosition` fields; `FuelLevel` decreases over a lap; `LapLastLapTime` updates at lap boundary. (quickstart.md Scenario 6)

### Tests for User Story 3

> **Write this test FIRST — it must fail before T022–T023 are implemented**

- [ ] T021 [P] [US3] Write integration test `test_session_rate_frame_roundtrip` in `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` `#[cfg(test)]` — build mock session-rate field vec: `[("_ts", "1719619200456"), ("FuelLevel", "28.5"), ("LapLastLapTime", "92.341"), ("CarIdxPosition", "[1,3,2,4]")]`; call `publisher.publish_session(fields)`; XRANGE `iracing:telemetry:session`; assert `FuelLevel == "28.5"` and `CarIdxPosition == "[1,3,2,4]"`; also add a `#[test]` assertion `assert!(SESSION_RATE_FIELDS.contains("FuelLevel"), "FuelLevel missing from SESSION_RATE_FIELDS — verify field name capitalization against sdk.enumerate_vars()")` — this converts the T005 manual spot-check into an automated guard that fails the test suite if the field name is wrong (A1)

### Implementation for User Story 3

- [ ] T022 [US3] Implement session-rate field reads in publisher_task in `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` — for each `TelemetryField` whose name IS in `SESSION_RATE_FIELDS`: serialize `TelemetryValue` to string (arrays as JSON); build `("_ts", unix_ms_str)` + session-rate field vec; store in a local variable for use by T023
- [ ] T023 [US3] Wire `Downsampler` into publisher_task inner loop in `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` — **first confirm** `Downsampler::should_emit_session()` triggers on every 4th call (4 × 16ms = 64ms → 15.6 Hz), which satisfies SC-003's ≥15 Hz requirement; if the existing implementation uses a different N, update the constant before wiring; instantiate `telemetry::downsampler::Downsampler::new()` at publisher_task start; call `downsampler.should_emit_session()` on each 16ms tick; when `true` AND session active: call `publisher.publish_session(session_fields).await`; catch and `warn!` any error, break inner loop on Redis error

**Checkpoint**: US3 complete when T021 test passes in CI and quickstart.md Scenario 6 passes on Windows (≥15 Hz, fuel and lap data visible).

---

## Phase 6: User Story 4 — Configurable & Gracefully Degraded Connection (Priority: P4)

**Goal**: Client starts and runs normally when Redis is unavailable; automatically reconnects with backoff when Redis returns; Redis URL is configurable in settings without a client restart.

**Independent Test**: Set an invalid Redis URL in settings; confirm client starts, diagnostic UI is fully functional, `warn!` logs appear. Set valid URL; confirm reconnect and publishing resume within 10 seconds without restart. (quickstart.md Scenarios 1, 2, 9)

### Tests for User Story 4

> **Write this test FIRST — it must fail before T025–T028 are implemented**

- [ ] T024 [P] [US4] Write integration test `test_fr009_path_b_negative` in `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` `#[cfg(test)]` — call `publish_snapshot(publisher, Disconnected, None, SnapshotReason::RedisConnected)` (Redis just reconnected; iRacing already Disconnected); XRANGE `iracing:events:connection` — assert exactly one new entry with `status=="Disconnected"`; XRANGE `iracing:events:session` — assert zero new entries added (FR-009 path b: no SessionEvent because there is no active session to snapshot, and this is a Redis reconnect not an iRacing disconnect)

### Implementation for User Story 4

- [ ] T025 [US4] Implement exponential backoff reconnect in publisher_task outer loop in `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` — initial delay 100ms; each failed `RedisPublisher::new(url)` call: `warn!`, delay doubles (ceiling 8s); reset delay to 100ms on successful connect; **immediately after successful connect and before entering the inner loop, call `publish_snapshot(&mut publisher, &current_iracing_status, &current_session, SnapshotReason::RedisConnected)` to emit the initial state snapshot** (FR-009 paths b/c — this is the "outer reconnect loop" caller path that T024's CI test does NOT cover; it complements T014's iRacing-reconnect sub-case); the 8s ceiling ensures reconnect happens within 10s budget (SC-004, FR-008)
- [ ] T026 [US4] Add graceful error handling throughout publisher_task in `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` — replace any `unwrap()` / `expect()` on Redis calls with `?`-propagation or explicit `match`; on any `Err` from `publish_live`, `publish_session`, or `publish_event`: `warn!` and `break` the inner loop to re-enter the outer reconnect loop; the publisher_task `async fn` must never panic and must handle permanent Redis unavailability silently (FR-007)
- [ ] T027 [US4] **First**, read `apps/tauri-client/src-tauri/src/state.rs` and confirm `AppConfig` has `redis_url: String`; **also** read `apps/tauri-client/src/pages/Setup.tsx` during this step and confirm the `redisUrl` state variable exists — record whether it is present or absent before T028 proceeds (if absent, flag for T028's fallback path); if absent, add it with `#[serde(default = "default_redis_url")]` and a `fn default_redis_url() -> String { "redis://localhost:6379".to_string() }` helper before the struct — T028's Settings UI wiring saves to this field. **Then** add `redis_url_watch_tx: tokio::sync::watch::Sender<String>` and `_redis_url_rx` to `AppState` in `apps/tauri-client/src-tauri/src/state.rs`; initialize with `watch::channel(AppConfig::default().redis_url)` in `Default`; update `save_config` command in `apps/tauri-client/src-tauri/src/commands.rs` to send `config.redis_url.clone()` on the channel when URL changes and add `info!("redis url updated — will apply on next reconnect")` immediately after the send (user-visible confirmation the change was received). Note: this channel does NOT trigger an active reconnect — publisher_task reads the latest URL at the START of each reconnect loop iteration (T028), preserving FR-010's passive apply semantics.
- [ ] T028 [US4] Update publisher_task outer loop to read `AppState.config.lock().unwrap().redis_url.clone()` at the start of each reconnect attempt in `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` (FR-010). The Redis URL input field already exists in `apps/tauri-client/src/pages/Setup.tsx` (search for the `redisUrl` state variable — confirmed by T027; do not rely on the line number as the file may have shifted). **Fallback**: if T027 found `redisUrl` absent, create it first: add `const [redisUrl, setRedisUrl] = useState('')` near the other config state vars and add a labeled text input `<input type="text" value={redisUrl} onInput={e => setRedisUrl(e.currentTarget.value)} placeholder="redis://localhost:6379" />` with label "Redis URL" in the settings form — then proceed with the wiring below. The field has two wiring gaps to close: (1) `useEffect` on mount does not load the stored value — add `invoke<AppConfig>('get_config').then(c => setRedisUrl(c.redis_url))`; (2) `onInput` updates local state only with no persistence — add a Save button or `onBlur` handler that calls `invoke('save_config', { config: { ...currentConfig, redis_url: redisUrl } })` so the updated URL reaches AppState and is picked up on the next publisher reconnect attempt. For the save trigger: use an **explicit Save button** (not `onBlur`) — a labeled `<button onClick={handleSave}>Save</button>` that calls `invoke('save_config', ...)` on click; `onBlur` is permitted if a Save button is impractical, but must be documented with the same call. The chosen trigger is what Scenario 9's extended case (step 5–8) validates. **Optional UX** [not required for merge]: after saving, display a brief status message ("URL saved — will apply on next reconnect") near the input field; this is cosmetic only and does not affect FR-010 semantics

**Checkpoint**: US4 complete when T024 test passes in CI and quickstart.md Scenarios 1, 2, 9 pass on Windows (graceful degradation and reconnect within 10s).

---

## Phase 7: Wire & Polish

**Purpose**: Wire publisher_task into the running app; complete FR-013 logging audit; ensure workspace-wide build and lint pass.

- [ ] T029 Update `apps/tauri-client/src-tauri/src/telemetry/mod.rs` to declare `pub mod publisher_task` and expose `pub use publisher_task::spawn_publisher_task`; update `apps/tauri-client/src-tauri/src/lib.rs` `.setup()` closure to add `tauri::async_runtime::spawn(telemetry::spawn_publisher_task(app.handle().clone()))` after the `spawn_connection_watcher` call
- [ ] T030 FR-013 tracing audit of `apps/tauri-client/src-tauri/src/telemetry/publisher_task.rs` — read every code path; verify: `info!` present on successful Redis connect; `info!` present on inner loop exit (disconnect); `warn!` present on every backoff iteration; add any missing calls; this task = the code review validation mandated by FR-013
- [ ] T031 Run `cargo test -p iracing-engineer-lib -- --test-threads=1` — all 7 SC-007 integration tests pass: T011×4 (connection/session/FR-009 paths), T017 (live frame), T021 (session-rate frame), T024 (FR-009 path b); **also confirm `test_was_suppressed_flag_logic` (T020) passes** — this is a required 8th Rust test (unit-level, no Redis) that is NOT part of the SC-007 7-count (SC-007 covers round-trip integration tests only) but is still required before PR merge; fix any failures before proceeding
- [ ] T032b Delete `apps/tauri-client/src-tauri/src/telemetry/sampler.rs` — **prerequisite**: T032's `grep -r 'mod sampler\|use.*sampler\|sampler::' apps/tauri-client/src-tauri/src/` returns zero results; if callers are found, resolve them as a blocking sub-task before proceeding; file confirmed present 2026-06-29 and marked SUPERSEDED in plan.md §Project Structure (`Arc<IracingSDK>` design is incorrect; publisher_task calls `IracingSDK::open()` directly per tick); this task is separated from T032's build gate so it cannot be accidentally skipped
- [ ] T032 Run `npm run build && npm run typecheck && npm run lint && npm run format:check` workspace-wide — all pass; fix any TypeScript errors, ESLint violations, or Prettier formatting issues before proceeding to manual validation; also run `cargo clippy -p iracing-engineer-lib -- -D warnings`; separately run `grep -r 'mod sampler\|use.*sampler\|sampler::' apps/tauri-client/src-tauri/src/` — if no results (confirmed no callers exist), delete `apps/tauri-client/src-tauri/src/telemetry/sampler.rs` unconditionally (file confirmed present 2026-06-29; plan.md §Project Structure marks it SUPERSEDED — `Arc<IracingSDK>` design is incorrect; publisher_task calls `IracingSDK::open()` directly per tick; do not wait for clippy to warn, as a live dead file is a live risk); **if the grep returns results** (unexpected callers found), do NOT delete — file a blocking sub-task to remove the callers first and do not proceed to manual validation until resolved

---

## Phase 8: Manual Validation (Windows + iRacing Required)

**Purpose**: Validate timing, rate, and graceful degradation requirements that cannot be proven in CI without a real iRacing session.

- [ ] T033 Run quickstart.md Scenario 1 — start Tauri client with Redis stopped; confirm diagnostic UI loads fully, `warn!` log line visible in terminal, no crash or blank panels; start Redis and confirm client reconnects within 10s and begins publishing (SC-005, FR-007, SC-004). Also run quickstart.md Scenario 7 (FR-009 path b manual branching check): with iRacing DISCONNECTED, trigger a Redis reconnect — XREAD `iracing:events:connection` confirms one new `Disconnected` entry; XREAD `iracing:events:session` confirms zero new entries — validates that path (b) emits only the ConnectionEvent, not a SessionEvent (the T024 CI test exercises the `publish_snapshot` branching function directly but does not cover the outer reconnect loop's decision to call it with the correct `iracing_status` from AppState). **PR sign-off required (D1 constitution note)**: post a PR comment explicitly acknowledging that the outer reconnect loop's status-passing decision is validated manually-only via Scenario 7 — an accepted limitation per plan.md §Constitution Check (Principle VI) — before the PR may be merged.
- [ ] T034 Run quickstart.md Scenarios 3+4 — with iRacing open: `XREAD BLOCK 3000 STREAMS iracing:events:connection 0` within 2s of iRacing connect confirms `ConnectionEvent(Connected)`; `XREAD BLOCK 3000 STREAMS iracing:events:session 0` confirms `SessionEvent` with `active:true` and `player_car_idx` populated; close iRacing and confirm `Disconnected` + `active:false` within 2s (SC-001, SC-006)
- [ ] T035 Run quickstart.md Scenario 6 — drive for 2 laps; `XRANGE iracing:telemetry:session - + COUNT 30`; confirm `FuelLevel` decreases, `LapLastLapTime` updates at lap completion, `_ts` deltas ≤100ms (SC-003)
- [ ] T036 Run quickstart.md Scenario 5 — enter on-track session, drive; run `XRANGE iracing:telemetry:live - + COUNT 20`; inspect `_ts` column for deltas ≤50ms; **paste or screenshot this XRANGE output as a PR comment — this is the sole SC-002 compliance proof and is required before the PR may be merged**
- [ ] T037 Run quickstart.md Scenario 8 — with iRacing open but at the main menu (no active session, `current_session` is `None`): observe `iracing:telemetry:live` and `iracing:telemetry:session` for 5 seconds via `XREAD BLOCK 5000 STREAMS iracing:telemetry:live iracing:telemetry:session 0`; confirm zero new entries are published during this window; confirm the latest `iracing:events:session` entry has `active: false`; FR-011 session suppression manually confirmed (the CI path for this finding is intentionally absent — see T020 accepted-limitation note). **PR sign-off required (D2 constitution note)**: post a PR comment explicitly acknowledging that FR-011's session suppression path (`current_session is None` → no telemetry publish) is validated manually-only via Scenario 8 with no dedicated CI integration test — an accepted limitation per plan.md §Constitution Check (Principle VI).

---

## Phase 9: Documentation (FR-014)

**Purpose**: Publish data model and stream contracts as living documentation served by the hub server at `/docs/...`.

- [ ] T038 Add `@mdx-js/rollup` to `apps/hub-server/package.json` devDependencies; update `apps/hub-server/vite.config.ts` to import and register `mdx({ jsxImportSource: 'preact' })` as the first plugin in the `plugins` array (before `honoPreact()`); run `npm run build -w apps/hub-server` to confirm no new build errors
- [ ] T039 [P] Create `apps/hub-server/src/docs/data-model.mdx` — entity schemas section for ConnectionEvent (with `player_car_idx` usage note: "use `player_car_idx` from the latest SessionEvent to index into all CarIdx arrays in the telemetry streams"), SessionEvent, LiveTelemetryFrame, SessionTelemetryFrame; field classification table (live vs session-rate split); adapted from `specs/002-redis-telemetry-publish/data-model.md`
- [ ] T040 [P] Create `apps/hub-server/src/docs/contracts/redis-streams.mdx` — stream keys table, MAXLEN values, XADD wire format examples for each stream, publisher guarantee list, consumer XREAD and XREVRANGE patterns; adapted from `specs/002-redis-telemetry-publish/contracts/redis-streams.md`
- [ ] T041 Create `apps/hub-server/src/docs/index.mdx` — docs landing page with one-paragraph feature summary and links to `/docs/data-model` and `/docs/contracts/redis-streams`
- [ ] T042 Create `apps/hub-server/src/docs/DocsLayout.tsx` — single-element `<div>` wrapper with readable prose styles (e.g. `max-width: 768px; margin: 2rem auto; padding: 0 1rem`); update `apps/hub-server/src/routes.ts` using the **definitive pattern** confirmed from `apps/hub-server/agents/llms-full.txt` (resolved 2026-06-29 — no further discovery needed):
  ```ts
  import { defineRoutes, contentRoutes } from 'hono-preact';
  import DocsLayout from './docs/DocsLayout.js';
  export default defineRoutes([
    // existing routes ...
    {
      path: '/docs',
      layout: () => import('./docs/DocsLayout.js'),
      children: [
        ...contentRoutes(import.meta.glob('./docs/**/*.mdx'), { wrapper: DocsLayout }),
      ],
    },
  ]);
  ```
  `contentRoutes` returns an **array of route nodes** — always spread (`...`) inside `children: []`; do NOT assign it to `children:` directly. The `wrapper` option wraps each MDX page in a single-element root (required for stable hydration — bare MDX Fragment roots do not hydrate correctly). `import.meta.glob` pattern must be a literal string (Vite requirement).
- [ ] T043 Run `npm run dev -w apps/hub-server`; open `http://localhost:3000/docs`, `http://localhost:3000/docs/data-model`, `http://localhost:3000/docs/contracts/redis-streams` in browser; confirm all three pages render without console errors and DocsLayout wraps each page

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion — **blocks all user stories**
- **US1 (Phase 3)**: Depends on Phase 2 — no dependency on US2/US3/US4
- **US2 (Phase 4)**: Depends on Phase 2 — no dependency on US1/US3/US4
- **US3 (Phase 5)**: Depends on Phase 2 AND US2 (shares the 60 Hz inner loop and publisher_task established in US2)
- **US4 (Phase 6)**: Depends on Phase 2 — no dependency on US1/US2/US3
- **Wire & Polish (Phase 7)**: Depends on all story phases being complete
- **Manual Validation (Phase 8)**: Depends on Phase 7 (wired + tests passing)
- **Documentation (Phase 9)**: Depends on Phase 7 (types finalized); can run in parallel with Phase 8

### User Story Dependencies

- **US1 (P1)**: Can start after Phase 2. No dependency on US2–US4. ← **Start here for MVP**
- **US2 (P2)**: Can start after Phase 2. Independent of US1.
- **US3 (P3)**: Depends on US2 (reuses publisher_task 60 Hz loop and `SESSION_RATE_FIELDS` from T005).
- **US4 (P4)**: Can start after Phase 2. Independent of US1–US3.

### SC-007 Integration Test Mapping

In this tasks.md, the 7 SC-007 CI integration tests are distributed across stories (spec.md SC-007 cross-references these task IDs):

| SC-007 test | Task | Story |
|-------------|------|-------|
| connection event round-trip | T011 | US1 |
| FR-009 path a dual-event | T011 | US1 |
| FR-009 path c-None dual-event | T011 | US1 |
| FR-009 path c-Some full-metadata | T011 | US1 |
| live frame round-trip | T017 | US2 |
| session-rate frame round-trip | T021 | US3 |
| FR-009 path b negative case | T024 | US4 |

All 7 must pass in CI (T031) before the PR may be merged.

**Additional required test (not in SC-007 7-count)**:

| Test | Task | Notes |
|------|------|-------|
| `test_was_suppressed_flag_logic` | T020 | Unit-level, no Redis — tests the `was_suppressed` flag state machine; required at T031 before merge |

---

## Parallel Opportunities

### Phase 1 Parallel

```
T003 (mocha+chai setup in packages/types)
T004 (SessionInfo player_car_idx in iracing/types.rs + watcher.rs)
→ both can run simultaneously after T001+T002
```

### Phase 2 Parallel

```
T006 (AppState: session_watch_tx)
T007 (watcher: send on session_watch_tx)   ← depends on T006
T008 (publisher.rs: stream key updates)
T009 (packages/types: redis-events.ts)
T010 (packages/types: redis-events tests)  ← depends on T009
→ T006+T008+T009 can run simultaneously
→ T007 starts after T006; T010 starts after T009
→ T010 also depends on T003 (mocha+chai devDeps from Phase 1 must be installed first)
```

### US1 Parallel

```
T011 (integration tests — write first, let fail)
T012 (Rust payload structs)
→ both can run simultaneously; T013–T015 depend on T012
```

### US2 + US3 Parallel (after Phase 2)

```
US2 (T017–T020) and US4 (T024–T028) can run simultaneously
US3 (T021–T023) requires US2's T019 to be in place first
```

### Documentation Parallel (Phase 9)

```
T039 (data-model.mdx)
T040 (contracts/redis-streams.mdx)
→ both can run simultaneously after T038
→ T041+T042 depend on T038 but not on T039/T040
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T004)
2. Complete Phase 2: Foundational (T005–T010) — **CRITICAL blocker**
3. Complete Phase 3: US1 (T011–T016)
4. Complete Phase 7 partially: T029 (wire), T030 (logging audit), T031 (tests), T032 (build)
5. Complete Phase 8 partially: T033, T034 (connection + session event manual tests)
6. **STOP and VALIDATE**: Connection and session events visible on Redis within 2s ← MVP delivered

### Incremental Delivery

1. Setup + Foundational → shared infrastructure ready
2. US1 → connection/session events on Redis (P1 MVP)
3. US2 → live telemetry at 60 Hz, SC-002 gap evidence (P2)
4. US3 → session-rate telemetry at 15 Hz (P3)
5. US4 → configurable URL + graceful degradation (P4)
6. Wire + Polish + Manual Validation → PR-ready
7. Documentation → hub server docs live

### Parallel Execution (Solo Developer)

As a solo developer, prefer this order:
- Complete US1 fully before starting US2 (ensures event infrastructure is solid)
- US2 before US3 (US3 reuses US2's inner loop)
- US4 can slot in at any point after Phase 2

---

## Notes

- `[P]` tasks modify different files and have no inter-dependencies within their phase — safe to run in parallel
- All `[US?]` tasks include the story label for traceability to spec.md acceptance criteria
- Integration tests (`#[cfg(test)]` in publisher_task.rs) require Docker Redis running locally on port 6379
- The SC-002 XRANGE screenshot (T036) is a hard merge gate — the PR cannot be merged without it
- `SESSION_RATE_FIELDS` in T005 is the single source of truth for field classification; keep it in sync with `data-model.md`
- `player_car_idx` added in T004 flows through T012 (Rust struct) → T009 (TypeScript interface) → T011 (test assertion) — ensure all three are consistent
