# Implementation Plan: Redis Telemetry Publishing

**Branch**: `002-redis-telemetry-publish` | **Date**: 2026-06-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-redis-telemetry-publish/spec.md`

> **Note**: Task IDs in this plan (T000–T030) were provisional and are now superseded by `tasks.md` (T001–T042), which is the authoritative task list. Do not cross-reference plan.md task IDs with tasks.md task IDs — the numbering schemes differ.

---

## Summary

Wire the Tauri client's existing iRacing watcher (spec 001) to publish connection events, session events, live telemetry (60 Hz), and session-rate telemetry (15 Hz) to Redis Streams so downstream consumers (hub server, Racing Engineer, Stream Engineer) can subscribe to the data bus. A new `publisher_task` tokio task (spawned via `tauri::async_runtime::spawn`) communicates with the watcher through existing AppState watch channels, handles Redis reconnect with exponential backoff, and publishes best-effort snapshots on reconnect. Publishing is a soft dependency — the client degrades gracefully if Redis is unavailable.

---

## Technical Context

**Language/Version**: Rust 2021 (`apps/tauri-client/src-tauri`) + TypeScript 5.4 (`packages/types`)

**Primary Dependencies**:
- `redis 0.25` with `tokio-comp` and `streams` features — already in `Cargo.toml`
- `tokio 1` full — already in `Cargo.toml`
- `tracing 0.1`, `serde_json 1`, `serde 1` — already in `Cargo.toml`
- `tauri::async_runtime` — Tauri 2 built-in, no new crate
- `mocha`, `chai`, `@types/mocha`, `@types/chai` — new devDependencies in `packages/types`

**Storage**: Redis Streams (telemetry bus only); no new Postgres tables in this feature

**Testing**:
- Rust: `cargo test -p iracing-engineer-lib` (unit + integration against local Docker Redis)
- TypeScript: `mocha + chai` for `packages/types` validators (new test infrastructure)
- Integration CI: `ubuntu-latest` + Docker Redis (7-alpine)

**Target Platform**: Windows (production — iRacing runs on Windows); Linux (CI integration tests via non-Windows SDK stubs)

**Performance Goals**:
- Live telemetry: ≥ 60 msg/s with no inter-message gap > 50 ms (SC-002)
- Session-rate: ≥ 15 msg/s (SC-003)
- Connection/session events: within 2 s of state transition (SC-001, SC-006)
- Redis reconnect: resume within 10 s (SC-004)

**Constraints**: Publisher MUST NOT crash or degrade diagnostic UI if Redis is unavailable (FR-007). Publishing is stateless/best-effort — no buffering, no replay (FR-009). Windows 15–20 ms timer jitter is an accepted source of gap variance (documented in SC-002).

**Scale/Scope**: Single-session local data bus; ~350 iRacing SDK fields across two streams; ≤ 5 concurrent subscribers

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Assessment | Status |
|-----------|-----------|--------|
| **I. Real-Time Reliability** | Publisher is an isolated tokio task — Redis failure cannot block the watcher std::thread or the Tauri UI. Two stream speeds (60 Hz + 15 Hz) align with the constitution's mandated dual-speed fan-out. Consumer group separation for Racing vs. Stream Engineer is downstream of this feature; out of scope here. | ✅ PASS |
| **II. Workspace Isolation** | New TypeScript types go to `packages/types/src/redis-events.ts`. No cross-app imports. Rust types stay in `apps/tauri-client/src-tauri`. | ✅ PASS |
| **III. Agent Autonomy Contract** | No agent code in this feature. | N/A |
| **IV. Local-First Infrastructure** | Redis `7-alpine` service already present in `infra/docker-compose.yml` on port 6379. FR-012 is pre-satisfied; T000 verifies it as a phase gate. | ✅ PASS |
| **V. Observability-Driven** | Telemetry flows through Redis Streams at exactly 60 Hz (live) and 15 Hz (session). FR-013 mandates structured tracing logs for all connection events. FR-014 makes all data flows inspectable via living documentation served at `/docs/data-model` and `/docs/contracts/redis-streams` on the hub server — satisfying "all data flows MUST be inspectable." | ✅ PASS |
| **VI. Test-Backed Change** | 7 round-trip integration tests in CI (SC-007). `packages/types` validators tested with mocha+chai. Rust unit tests for downsampler, serialization, FR-009 logic. **Accepted limitation**: FR-009 path (b) branching decision (`if status == Connected` in publisher_task) validated manually in quickstart.md Scenario 7 — the CI test verifies serialization round-trip only, not the branching logic under live Redis conditions. This limitation is accepted and documented. | ✅ PASS (with documented limitation) |
| **VII. Incremental Delivery (YAGNI)** | Feature delivers a working publisher in one branch. No hub server code written here. No speculative infra added. All complexity justified in table below. | ✅ PASS |

**Post-Phase-1 re-check**: Constitution Check passes. The `publisher_task.rs` isolates all Redis I/O from the watcher thread, preserving principle I. The field classification in `data-model.md` covers all SDK fields without publisher-side filtering, preserving principle V.

---

## Complexity Tracking

> Principle VII requires justification for added complexity.

| Addition | Why Needed | Simpler Alternative Rejected Because |
|----------|------------|-------------------------------------|
| Separate `publisher_task` tokio async task | Redis async I/O (`redis 0.25 tokio-comp`) cannot run on the watcher's `std::thread`; backoff reconnect requires async sleep | Moving publish calls into the watcher requires `block_on` inside a `std::thread`, which would block iRacing reads for the duration of each Redis XADD |
| `watch::Receiver<ConnectionStatus>` from AppState | Publisher must react to connection transitions without polling the Mutex every 16ms | Already exists in `AppState` — zero added complexity |
| Watcher tick rate upgrade (100ms → 16ms) | Live telemetry requires 60 Hz SDK reads; the watcher is the only code path that opens the SDK | A second SDK-reading thread would duplicate connection detection and risk out-of-sync state between two threads observing shared memory |
| mocha+chai test infra in `packages/types` | Constitution Principle VI is NON-NEGOTIABLE for all `packages/types` validators | Skipping is not an option; this is the correct place to invest it |
| MDX documentation infrastructure (`@mdx-js/rollup` + `contentRoutes`) | FR-014 requires in-app stream contract documentation on the hub server; MDX composes with the existing Vite + hono-preact setup without a separate docs build | A static markdown file is insufficient — it is not served by the app and requires local filesystem access to read |
| `redis_url_watch_tx: watch::Sender<String>` in AppState | Enables publisher_task to read the latest configured URL at the start of each reconnect attempt without holding the config Mutex across an async await point; `save_config` sends on this channel whenever the URL changes | Reading `AppState.config.lock()` directly on each reconnect attempt also works, but requires careful drop-before-await discipline to avoid deadlocking the async executor |

---

## Project Structure

### Documentation (this feature)

```text
specs/002-redis-telemetry-publish/
├── plan.md              ← this file
├── research.md          ← Phase 0: decisions and rationale
├── data-model.md        ← Phase 1: entity schemas and field classification
├── quickstart.md        ← Phase 1: validation scenarios
├── contracts/
│   └── redis-streams.md ← Phase 1: stream keys, MAXLEN, wire format, consumer notes
└── tasks.md             ← Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code

```text
apps/tauri-client/src-tauri/src/
├── iracing/
│   └── watcher.rs              MODIFY  tick 100ms→16ms; watchlist fires every 6th tick (~96ms)
├── telemetry/
│   ├── mod.rs                  MODIFY  wire publisher_task
│   ├── publisher_task.rs       NEW     top-level tokio task: reconnect loop, snapshot, 60Hz+15Hz publish
│   ├── publisher.rs            MODIFY  update stream keys + MAXLEN; add event publish methods
│   ├── sampler.rs              SUPERSEDED  Arc<IracingSDK> design is incorrect — IracingSDK::open() produces a fresh Vec<u8> snapshot each call and cannot be shared; publisher_task.rs calls IracingSDK::open() directly per tick (same pattern as watcher.rs); sampler.rs is not modified or called
│   └── downsampler.rs          unchanged
├── state.rs                    MODIFY  add watch::Sender<Option<SessionInfo>> for publisher subscription
└── lib.rs                      MODIFY  spawn publisher_task in .setup()

packages/types/
├── src/
│   ├── redis-events.ts         NEW     ConnectionEvent, SessionEvent TypeScript interfaces + validators
│   └── index.ts                MODIFY  re-export from redis-events.ts
├── test/
│   └── redis-events.test.ts    NEW     mocha+chai tests for redis-events validators
└── package.json                MODIFY  add mocha+chai devDeps + test script

apps/hub-server/
├── vite.config.ts              MODIFY  add @mdx-js/rollup plugin
├── src/
│   ├── routes.ts               MODIFY  add /docs subtree via contentRoutes
│   └── docs/
│       ├── index.mdx           NEW     docs landing page
│       ├── data-model.mdx      NEW     entity schemas + field classification
│       └── contracts/
│           └── redis-streams.mdx  NEW  stream keys, wire formats, consumer notes
└── package.json                MODIFY  add @mdx-js/rollup devDep
```

**Structure Decision**: Monorepo layout unchanged. All publisher logic is isolated in `telemetry/publisher_task.rs`. TypeScript types follow the existing `packages/types/src/` pattern. No new packages or apps.

---

## Implementation Phases

### Phase 0 — Infrastructure Gate (T000)

**Gate**: Verify `infra/docker-compose.yml` has a `redis:7-alpine` service on port 6379 with `--appendonly yes` before any publisher code is written.

**Status**: Pre-satisfied (confirmed in spec §Assumptions and directly verified in `infra/docker-compose.yml`). T000 is a verification task, not a build task.

---

### Phase 1 — Shared Types (T001–T003)

Wire the shared TypeScript contract layer before any consuming code is written (Constitution Principle II).

- **T001**: Add `ConnectionEvent` and `SessionEvent` TypeScript interfaces to `packages/types/src/redis-events.ts`. Add runtime validators. Export from `packages/types/src/index.ts`.
- **T002**: Add mocha+chai devDependencies and test script to `packages/types/package.json`. Write `test/redis-events.test.ts` with full validator coverage.
- **T003**: Define Rust `ConnectionEventPayload` and `SessionEventPayload` structs in `telemetry/publisher_task.rs` (new file stub). Define `SESSION_RATE_FIELDS` const set and stream key constants.

---

### Phase 2 — AppState Plumbing (T004–T005)

- **T004**: Add `session_watch_tx: watch::Sender<Option<SessionInfo>>` and `_session_watch_rx` to `AppState`. Update watcher to send on this channel when `current_session` changes.
- **T005**: Add `redis_url_watch_tx: watch::Sender<String>` to `AppState`. Update `save_config` command to send new URL on change. Publisher task uses this receiver to detect URL changes and apply them on next reconnect.

---

### Phase 3 — Publisher Task Core (T006–T010)

Build the `publisher_task` async function in `telemetry/publisher_task.rs`.

- **T006**: Reconnect loop with exponential backoff (100ms initial, 2× multiplier, 8s ceiling per FR-008). `warn!` on each failed attempt; `info!` on success.
- **T007**: FR-009 snapshot logic. On Redis connect: read current `iracing_status` and `current_session` from AppState; apply three-path snapshot behavior:
  - Path (a): handled by iRacing disconnect detection (see T009)
  - Path (b): `status == Disconnected` → publish `ConnectionEvent(Disconnected)` only
  - Path (c): `status == Connected` → publish `ConnectionEvent(Connected)` + `SessionEvent(current_session_or_none)`
- **T008**: Inner publish loop at 60 Hz tokio interval. On each tick: open SDK, read all live-stream fields, XADD to `iracing:telemetry:live`. On Downsampler tick (every 4th): read session-rate fields, XADD to `iracing:telemetry:session`. Exit inner loop on Redis error.
- **T009**: iRacing disconnect detection in publisher task. Watch `iracing_status` receiver. On transition to `Disconnected`: publish `ConnectionEvent(Disconnected)` + `SessionEvent(active:false)` (FR-009 path a). Stop telemetry publishing until reconnect.
> **⚠️ T010 SUPERSEDED — do not implement.** See **tasks.md T015** instead.
> Session change detection uses the counter-based `sdk.session_info_update()` diff (identical to `watcher.rs`). No `last_published_session` field is tracked or compared. The deep-equality approach originally described here is incorrect.
>
> *Original (struck)*: Track `last_published_session`; compare on each tick; publish `SessionEvent` on change.

---

### Phase 4 — Watcher Tick Rate Upgrade (T011–T012)

- **T011**: Change `TICK_SLEEP` to 16ms. Add `WATCHLIST_EVERY_N_TICKS = 6` constant. Move watchlist UI emit inside the N-tick gate. Update `CONNECT_EVERY_N_TICKS` to 30 (30 × 16ms ≈ 480ms, equivalent to current 5 × 100ms).
- **T012**: Verify watchlist UI still receives updates at ~10 Hz (6 × 16ms = 96ms). Add a comment documenting the tick rate rationale.

---

### Phase 5 — Wire Into App (T013–T014)

- **T013**: In `lib.rs`, call `tauri::async_runtime::spawn(telemetry::spawn_publisher_task(app.handle().clone()))` in the `.setup()` closure, after `spawn_connection_watcher`.
- **T014**: Settings UI — confirm the Redis URL field in the client settings panel reads/writes `AppConfig.redis_url`. If the settings panel does not yet have a Redis URL field, add one to the existing settings page in `apps/tauri-client/src/pages/`.

---

### Phase 6 — Tests and Logging Audit (see tasks.md: Phase 7 Wire & Polish)

> **⚠️ Task IDs below (T015–T019) are plan.md provisional IDs.** Authoritative implementation steps are in tasks.md Phase 7 (T029–T032). Do not execute the T-numbers below directly.

- **T015**: Write 7 Rust integration tests (SC-007) in a `#[cfg(test)]` module in `telemetry/publisher_task.rs` or a separate `tests/` file. Each test spins up a real Redis connection (`redis://localhost:6379`).
- **T016**: Run `cargo test` workspace-wide. All tests green.
- **T017**: Tracing audit — review all connection/reconnect code paths for presence of `info!` (connect, disconnect) and `warn!` (failed attempt) per FR-013.
- **T018**: Run `npm run build && npm run typecheck && npm run lint && npm run format:check` workspace-wide. All pass.
- **T019**: FR-013 final check — verify logging is complete per spec.

---

### Phase 7 — Manual Validation (see tasks.md: Phase 8 Manual Validation)

All scenarios require Windows + iRacing.

- **T020**: Verify `infra/docker-compose.yml` Redis service (T000 formal sign-off).
- **T021**: Run quickstart.md Scenario 1 (graceful degradation — no Redis at start).
- **T022**: Run quickstart.md Scenario 3 (connection events within 2s).
- **T023**: Run quickstart.md Scenario 4 (session metadata within 2s).
- **T024**: Run quickstart.md Scenario 6 (session-rate telemetry fields and rate).
- **T025**: Run quickstart.md Scenario 5 (live telemetry rate + gap ≤ 50ms). **Post `XRANGE iracing:telemetry:live - + COUNT 20` output as PR comment — required for merge (SC-002).**

---

### Phase 8 — Documentation (see tasks.md: Phase 9 Documentation)

Publish the data model and stream contracts as living documentation served by the hub server, browsable at `http://localhost:3000/docs/...`. Uses `@mdx-js/rollup` (Vite plugin) + `contentRoutes` (built into hono-preact) to compile MDX files to Preact components and auto-register them as routes.

> **⚠️ Task IDs below (T026–T030) are plan.md provisional IDs.** Authoritative implementation steps are in tasks.md Phase 9 (T038–T043). Do not execute the T-numbers below directly.

- **T026**: Add `@mdx-js/rollup` devDependency to `apps/hub-server`. Update `vite.config.ts` to add the MDX plugin before `honoPreact()` with `jsxImportSource: 'preact'`. Verify `npm run build` still passes.
- **T027**: Create `apps/hub-server/src/docs/` with three MDX files adapted from the spec artifacts:
  - `data-model.mdx` — entity schemas (ConnectionEvent, SessionEvent, LiveTelemetryFrame, SessionTelemetryFrame), field classification table
  - `contracts/redis-streams.mdx` — stream keys, MAXLEN, wire formats, publisher guarantees, consumer notes
  - `index.mdx` — docs landing page with links to the above
- **T028**: Register docs routes in `src/routes.ts` using `contentRoutes`:
  ```ts
  import { defineRoutes, contentRoutes } from 'hono-preact';
  export default defineRoutes([
    // existing routes ...
    {
      path: '/docs',
      children: contentRoutes(import.meta.glob('./docs/**/*.mdx')),
    },
  ]);
  ```
- **T029**: Add a `DocsLayout` wrapper component passed to `contentRoutes` as `options.wrapper`. Provides a minimal prose container (max-width, readable line-length) so the docs are navigable without a full design pass.
- **T030**: Verify all three docs pages render correctly under `npm run dev`. Confirm the `contracts/redis-streams` route resolves (tests the nested path slug derivation in `contentRoutes`).
