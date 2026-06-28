# Tasks: iRacing SDK Connection & Diagnostic UI

**Input**: Design documents from `specs/001-iracing-sdk-diagnostics/`

**Feature branch**: `001-iracing-sdk-diagnostics`

**References**: [plan.md](plan.md) | [spec.md](spec.md) | [data-model.md](data-model.md) | [contracts/](contracts/) | [quickstart.md](quickstart.md)

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Parallelisable — different files, no dependency on an incomplete task in the same phase
- **[US1/2/3]**: User story this task belongs to
- Tasks in the same file are listed in execution order (sequential)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add the new dependency, define all new types, and create the skeleton UI component.
All tasks in this phase can begin immediately. T002/T003 are parallel; T004 must follow T002.

- [X] T001 Add `serde_yaml = "0.9"` to `[dependencies]` in `apps/tauri-client/src-tauri/Cargo.toml`
- [X] T002 [P] Extend `apps/tauri-client/src-tauri/src/iracing/types.rs` — add `SessionInfo`, `VarType`, `TelemetryValue`, `TelemetryField` structs/enums (all `#[derive(Debug, Clone, Serialize, Deserialize, TS)]`); remove the duplicate `ConnectionStatus` definition from `apps/tauri-client/src-tauri/src/state.rs` and replace with `use crate::iracing::types::ConnectionStatus`
- [X] T003 [P] Create `apps/tauri-client/src/pages/Diagnostics.tsx` — skeleton Preact component with four empty `<section>` placeholders labelled: "Connection Status", "Session Info", "Field Browser", "Watchlist"
- [X] T004 Extend `apps/tauri-client/src-tauri/src/state.rs` — add to `AppState`: `field_cache: Mutex<Vec<TelemetryField>>`, `watchlist: Mutex<Vec<String>>`, `current_session: Mutex<Option<SessionInfo>>`, `iracing_status: tokio::sync::watch::Sender<ConnectionStatus>`; update `AppState::default()` accordingly (depends on T002)

**Checkpoint**: `cargo build` passes on non-Windows. New types compile. Diagnostics.tsx renders without errors.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Full iRacing SDK implementation + background watcher task + unit tests.
Nothing in Phase 3+ can start until the SDK reads correctly and the watcher is running.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T005 [P] Add to `apps/tauri-client/src-tauri/src/iracing/defines.rs`: `IRSDK_STATUS_CONNECTED: i32 = 1`, `VAR_HEADER_SIZE: usize = 144`, and header byte offset constants `STATUS_OFFSET: usize = 4`, `TICK_RATE_OFFSET: usize = 8`, `SESSION_INFO_UPDATE_OFFSET: usize = 12`, `SESSION_INFO_LEN_OFFSET: usize = 16`, `SESSION_INFO_OFFSET_OFFSET: usize = 20`, `NUM_VARS_OFFSET: usize = 24`, `VAR_HEADER_OFFSET_OFFSET: usize = 28`
- [X] T006 [P] Update `apps/tauri-client/src-tauri/src/iracing/mod.rs` — re-export `TelemetryField`, `TelemetryValue`, `VarType`, `SessionInfo` from `types` so callers use `crate::iracing::TelemetryField` etc. (depends on T002)
- [X] T007 Implement `IracingSDK::open()` in `apps/tauri-client/src-tauri/src/iracing/sdk.rs` — `#[cfg(target_os = "windows")]` block: call `OpenFileMapping(FILE_MAP_READ, false, "Local\\IRSDKMemMapFileName")`; if handle is null return `Err`; call `MapViewOfFile` for 1 MB; copy mapped bytes into `Vec<u8>`; `#[cfg(not(target_os = "windows"))]` block: return stub `Ok(Self { data: vec![0u8; 1024*1024], var_offsets: HashMap::new() })` (depends on T001, T005)
- [X] T008 Implement `IracingSDK::enumerate_vars()` in `apps/tauri-client/src-tauri/src/iracing/sdk.rs` — read `num_vars` (i32 at `NUM_VARS_OFFSET`) and `var_header_offset` (i32 at `VAR_HEADER_OFFSET_OFFSET`) from `self.data`; iterate `num_vars` × `VAR_HEADER_SIZE`-byte `IrsdkVarHeader` entries; for each: parse `var_type`, `offset`, `count`, null-terminated `name`/`desc`/`unit` byte arrays; populate `self.var_offsets` map (`name → (type, offset, count)`); return `Vec<TelemetryField>` with current values from `self.data` (depends on T005, T007)
- [X] T009 Implement `IracingSDK::read_session_info()` in `apps/tauri-client/src-tauri/src/iracing/sdk.rs` — read `session_info_len` (i32 at `SESSION_INFO_LEN_OFFSET`) and `session_info_offset` (i32 at `SESSION_INFO_OFFSET_OFFSET`); slice `self.data[offset..offset+len]`; decode as UTF-8; return `Some(String)` or `None` if len is 0 (depends on T007)
- [X] T010 Update `IracingSDK::is_connected()` in `apps/tauri-client/src-tauri/src/iracing/sdk.rs` — read i32 at `STATUS_OFFSET`; return `val == IRSDK_STATUS_CONNECTED` (replaces the existing stub that already does this but uses magic offsets — update to use the named constants from T005)
- [X] T011 Update `IracingSDK::read_var_float/int/bool/read_var_float_array()` in `apps/tauri-client/src-tauri/src/iracing/sdk.rs` — replace the current stub that reads from `self.data` at static offsets with reads from the live data buffer: get `buf_offset` from `var_buf[N].buf_offset` (highest `tick_count` in the `IrsdkHeader.var_buf` array); read at `buf_offset + var.offset` (depends on T008)
- [X] T012 Write unit tests in `apps/tauri-client/src-tauri/src/iracing/sdk.rs` inline `#[cfg(test)]` module — test `is_connected()` with a hand-crafted buffer (status byte = 1 → true; status = 0 → false); test `enumerate_vars()` with a minimal 1-var header block; test `read_session_info()` with a buffer containing a known YAML string at a non-zero offset; **also test the crash/force-close detection path**: construct a buffer with status = 1 (Connected), then overwrite status = 0 and confirm `is_connected()` returns false within the same call frame (simulates iRacing process death mid-session); verify all tests pass with `cargo test` on non-Windows (depends on T007, T008, T009, T010)
- [X] T013 Create `apps/tauri-client/src-tauri/src/iracing/watcher.rs` — implement `spawn_connection_watcher(app_handle: AppHandle, state: Arc<AppState>)` as a `std::thread::spawn` loop: every 500 ms attempt `IracingSDK::open()`; on success transition to `Connecting` → `Connected` and emit `iracing://status-changed`; check `is_connected()` while connected; on failure emit `Disconnected`; log every transition with `tracing::info!`; log failed open attempts with `tracing::warn!` (depends on T004, T007, T010)
- [X] T014 Export `spawn_connection_watcher` from `apps/tauri-client/src-tauri/src/iracing/mod.rs` and register it in `apps/tauri-client/src-tauri/src/lib.rs` `run()` — call after `tauri::Builder::default()...run(...)` setup, passing the `AppHandle` (depends on T013)

**Checkpoint**: `cargo test` passes on non-Windows. `cargo build` clean. Watcher compiles and logs connection attempts when run on Windows.

---

## Phase 3: User Story 1 — Connection Status at a Glance (Priority: P1) 🎯 MVP

**Goal**: The Diagnostics tab shows a connection badge that updates within 2 s of iRacing starting or stopping — no manual refresh required.

**Independent Test**: quickstart.md Scenarios 1 and 2 — launch with iRacing closed (badge = Disconnected), start iRacing, badge changes to Connected within 2 s automatically.

- [X] T015 [US1] Add `get_iracing_status` Tauri command to `apps/tauri-client/src-tauri/src/commands.rs` — reads current `ConnectionStatus` from `AppState.iracing_status` watch receiver; returns `Ok(ConnectionStatus)` (depends on T004)
- [X] T016 [US1] Register `get_iracing_status` in the `invoke_handler!` macro in `apps/tauri-client/src-tauri/src/lib.rs` (depends on T015)
- [X] T017 [US1] Wire connection badge in `apps/tauri-client/src/pages/Diagnostics.tsx` — on mount call `invoke<ConnectionStatus>('get_iracing_status')` to set initial state; `listen('iracing://status-changed', ...)` for live updates; unlisten on unmount; render a coloured status badge ("Connected" / "Connecting" / "Disconnected") (depends on T003, T015, T016)
- [X] T018 [US1] Add **Diagnostics** tab to `apps/tauri-client/src/App.tsx` — add `"diagnostics"` to the `Page` union, tab button, and conditional render `<Diagnostics />` (depends on T003)

**Checkpoint**: Launch app → Diagnostics tab → badge shows Disconnected. Start iRacing → badge changes to Connected within 2 s. Close iRacing → Disconnected within 2 s. No manual refresh at any step.

---

## Phase 4: User Story 2 — Session Metadata Confirmation (Priority: P2)

**Goal**: When in a session, the session panel shows track name, car name, session type, and wall-clock time matching the iRacing UI.

**Independent Test**: quickstart.md Scenario 3 — enter a known practice session, verify all four session metadata fields display correctly vs iRacing's own UI.

- [X] T019 [US2] Extend `apps/tauri-client/src-tauri/src/iracing/watcher.rs` — in the watcher loop when connected: read `session_info_update` counter (i32 at `SESSION_INFO_UPDATE_OFFSET`); when it changes call `read_session_info()`, parse YAML with `serde_yaml::from_str::<serde_yaml::Value>()`, extract `WeekendInfo.TrackName`, `WeekendInfo.EventType`, `DriverInfo.Drivers[0].CarScreenNameShort`, capture `wall_clock_time` using `std::time::SystemTime::now()` formatted as HH:MM:SS in **local time** (system clock timezone — this is a developer diagnostic tool; UTC conversion is out of scope for v1); store in `AppState.current_session`; emit `iracing://session-changed` with `Some(SessionInfo)` or `null` when session ends; log with `tracing::info!` (depends on T009, T013)
- [X] T020 [US2] Add `get_session_data` Tauri command to `apps/tauri-client/src-tauri/src/commands.rs` — returns clone of `AppState.current_session` as `Ok(Option<SessionInfo>)` (depends on T004)
- [X] T021 [US2] Register `get_session_data` in `apps/tauri-client/src-tauri/src/lib.rs` invoke handler (depends on T020)
- [X] T022 [US2] Wire session panel in `apps/tauri-client/src/pages/Diagnostics.tsx` — on mount call `invoke<SessionInfo | null>('get_session_data')`; `listen('iracing://session-changed', ...)` for updates; render track, car, session type, wall-clock time when session is present; render "No active session" when null (depends on T017, T020, T021)

**Checkpoint**: Enter a practice session → session panel populates with correct data. Switch session type (practice → qualify) → panel updates automatically. Exit to main menu → "No active session" shown.

---

## Phase 5: User Story 3 — Live Telemetry Field Browser & Watchlist (Priority: P3)

**Goal**: Field browser lists all available SDK variables; user can select any as a watchlist entry and see values update at 10 Hz.

**Independent Test**: quickstart.md Scenarios 4–7 — browse fields, add Speed/RPM/Throttle/Brake/Gear to watchlist, verify live updates visible while driving; verify "Unavailable" shown for nonexistent field; verify watchlist survives disconnect/reconnect.

- [X] T023 [US3] Extend `apps/tauri-client/src-tauri/src/iracing/watcher.rs` — on connect: call `enumerate_vars()` and store result in `AppState.field_cache`; also re-enumerate on `session_info_update` change (in case new car/session exposes different fields) (depends on T008, T013, T019)
- [X] T024 [US3] Implement 10 Hz watchlist tick in `apps/tauri-client/src-tauri/src/iracing/watcher.rs` — add a separate inner loop at 100 ms interval; when connected and `AppState.watchlist` is non-empty: read each field name from watchlist; call `read_var_float/int/bool()` as appropriate (use `var_offsets` to determine type); fields absent from `var_offsets` → `TelemetryValue::Unavailable`; collect into `HashMap<String, TelemetryValue>`; emit `iracing://telemetry-tick` (depends on T011, T023)
- [X] T025 [P] [US3] Add `list_telemetry_fields` Tauri command to `apps/tauri-client/src-tauri/src/commands.rs` — returns clone of `AppState.field_cache` as `Ok(Vec<TelemetryField>)` (depends on T004, T023)
- [X] T026 [P] [US3] Add `get_watchlist` and `set_watchlist` Tauri commands to `apps/tauri-client/src-tauri/src/commands.rs` — `get_watchlist`: returns clone of `AppState.watchlist`; `set_watchlist(fields: Vec<String>)`: replaces `AppState.watchlist` with provided list (depends on T004)
- [X] T027 [US3] Register `list_telemetry_fields`, `get_watchlist`, `set_watchlist` in `apps/tauri-client/src-tauri/src/lib.rs` invoke handler (depends on T025, T026)
- [X] T028 [US3] Wire field browser section in `apps/tauri-client/src/pages/Diagnostics.tsx` — populate the field list on TWO triggers to avoid a race where the field cache is populated but no session-changed event has fired: (1) `listen('iracing://status-changed', ...)` → when status becomes `Connected`, call `invoke('list_telemetry_fields')` immediately; (2) `listen('iracing://session-changed', ...)` → when session is present, call `invoke('list_telemetry_fields')` again (re-enumeration may expose new fields after a car/session change); render scrollable list of `TelemetryField` rows (name, snapshot value, unit); each row has an "Add" button that calls `invoke('set_watchlist', { fields: [...currentWatchlist, field.name] })`; when no session: render "No active session — enter a session to browse fields"; field values shown are a snapshot at connect/session-change time — live values appear in the watchlist panel only (depends on T022, T025, T027)
- [X] T029 [US3] Wire watchlist section in `apps/tauri-client/src/pages/Diagnostics.tsx` — on mount call `invoke('get_watchlist')`; `listen('iracing://telemetry-tick', ...)` and merge tick values into local state; render each watchlist entry as name + live value + unit, or "Unavailable" string; each row has a "Remove" button that calls `invoke('set_watchlist', { fields: currentWatchlist.filter(...) })`; unlisten on unmount (depends on T028, T026, T027)

**Checkpoint**: Field browser populates on session start. Add 5 fields to watchlist. Drive on track — values update visibly. Add a non-existent field — shows "Unavailable". Exit and re-enter iRacing — watchlist field selections survive.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T030 [P] Audit `apps/tauri-client/src-tauri/src/iracing/watcher.rs` for tracing completeness — confirm `tracing::info!` at every Connected/Disconnected/session-changed transition; confirm `tracing::warn!` on every failed `IracingSDK::open()` attempt (Constitution Principle V gate)
- [X] T031 [P] Remove now-superseded stubs from `apps/tauri-client/src-tauri/src/commands.rs` — delete the old `get_connection_status` and `test_connection` commands (they returned hardcoded `Disconnected`; `get_iracing_status` replaces them); remove their registrations from `lib.rs`
- [X] T032 Run `cargo test` in `apps/tauri-client/src-tauri` and fix any failures (Constitution Principle VI gate)
- [X] T033 [P] Run `npm run typecheck -w apps/tauri-client` and fix any TypeScript errors
- [X] T035 [P] Run `cargo fmt --check` and `cargo clippy -- -D warnings` in `apps/tauri-client/src-tauri` — fix any formatting or lint violations before merge (Constitution Principle VI gate)
- [X] T036 Run `npm run lint` and `npm run build` across the workspace from repo root — fix any lint errors; confirm the full workspace build completes cleanly (Constitution Principle VI merge gate)
- [ ] T034 Run quickstart.md Scenarios 1–9 on Windows with iRacing and mark all 9 passing (includes Scenario 8 crash-detection and Scenario 9 full lifecycle) — NOTE: T034 is intentionally the final task in Phase 6 despite its number being out of sequence; it is the terminal validation gate and must run after T033, T035, and T036 are all green

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 — **BLOCKS all user story phases**
- **Phase 3 (US1)**: Depends on Phase 2 completion
- **Phase 4 (US2)**: Depends on Phase 2 completion; may begin in parallel with Phase 3
- **Phase 5 (US3)**: Depends on Phase 3 completion (needs the connected UI state from US1 to wire the field browser meaningfully); also soft-depends on Phase 4 (US2) because T028 listens on `iracing://session-changed` to trigger field browser population — complete Phase 4 before wiring T028
- **Phase 6 (Polish)**: Depends on all story phases

### User Story Dependencies

- **US1 (P1)**: No dependency on US2 or US3
- **US2 (P2)**: No dependency on US1 or US3 (shares watcher infrastructure but UI is independent)
- **US3 (P3)**: Logically depends on US1 (uses the same Diagnostics component and connection state)

### Within Each Phase

- Tasks listed in execution order within each phase
- Tasks marked `[P]` can run in parallel with other `[P]` tasks in the same phase
- Tasks without `[P]` must complete before the next task in that block begins

### Parallel Opportunities

```
Phase 1:  T001 → (T002 ∥ T003) → T004
Phase 2:  (T005 ∥ T006) → T007 → T008 → T009 → T010 → T011 → T012 → T013 → T014
Phase 3:  T015 → T016 → (T017 ∥ T018)
Phase 4:  T019 → T020 → T021 → T022
Phase 5:  T023 → T024 → (T025 ∥ T026) → T027 → T028 → T029
Phase 6:  (T030 ∥ T031) → T032 → (T033 ∥ T035) → T036 → T034
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (**critical — blocks everything**)
3. Complete Phase 3: US1 (connection badge)
4. **STOP and VALIDATE**: Run quickstart.md Scenarios 1 & 2 on Windows with iRacing
5. Merge if connection detection is solid — this is the foundation everything else builds on

### Incremental Delivery

1. Setup + Foundational → SDK reads correctly, watcher logs transitions
2. US1 → connection badge in UI (MVP demo-able)
3. US2 → session metadata panel
4. US3 → field browser + watchlist at 10 Hz
5. Polish → tracing audit, remove old stubs, full lifecycle validation

---

## Notes

- `[P]` tasks touch different files and have no dependency on an incomplete task in the same phase
- `[USN]` label maps each task to its user story for traceability
- Each story phase ends with a named Checkpoint that can be independently tested
- All Rust unit tests (T012) must pass on **non-Windows** — use hand-crafted byte buffers, no Win32 calls
- The `serde_yaml` dep (T001) is required before T019 can compile — do not skip Phase 1
- `wall_clock_time` in `SessionInfo` comes from `std::time::SystemTime::now()` in Rust at emission time, **not** from the iRacing SDK (per clarification Q1)
- Fields absent from `var_offsets` on the watchlist emit `TelemetryValue::Unavailable` (per clarification Q3 / FR-011)
