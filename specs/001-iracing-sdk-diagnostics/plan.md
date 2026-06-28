# Implementation Plan: iRacing SDK Connection & Diagnostic UI

**Branch**: `001-iracing-sdk-diagnostics` | **Date**: 2026-06-26 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-iracing-sdk-diagnostics/spec.md`

## Summary

Implement the iRacing shared-memory reader in the Tauri client's Rust layer and wire a
minimal Preact diagnostic UI that shows connection status, session metadata, and a live
10 Hz telemetry watchlist. This is the foundational data-ingestion layer for the entire
Racing Engineer path — everything downstream (LLM prompting, voice feedback, Redis publish)
blocks on this being correct.

## Technical Context

**Language/Version**: Rust 2021 edition, TypeScript 5.6, Preact 10.29

**Primary Dependencies**:
- Rust: `windows 0.58` (already — Win32 shared memory APIs), `serde_yaml 0.9` (add —
  session YAML parsing), `tauri 2.0` (already), `tokio 1.x` (already), `tracing 0.1`
  (already), `serde 1.x` (already), `std::time::SystemTime` (standard library — used for
  wall-clock time capture at session-event emission; no new crate dependency)
- Frontend: `@tauri-apps/api` (Tauri JS bridge — already in tauri-client), Preact hooks

**Storage**: In-memory only (Tauri managed state). Watchlist persists for the app session
lifetime only — no disk persistence in this iteration.

**Testing**: `cargo test` for Rust unit tests (header parsing, var enumeration, session YAML
extraction, `is_connected` logic). Tests run on non-Windows using stub shared-memory buffers.
Manual end-to-end validation via `quickstart.md`.

**Target Platform**: Windows 10/11 (iRacing is Windows-only). All Win32 calls behind
`#[cfg(target_os = "windows")]` guards so the crate compiles cleanly on macOS/Linux for CI.

**Project Type**: Desktop app (Tauri 2 — Rust backend + Preact webview)

**Performance Goals**: Connection state detection ≤ 2 s of iRacing start/stop; watchlist UI
refresh at 10 Hz (100 ms tick).

**Constraints**:
- `OpenFileMapping` / `MapViewOfFile` are Win32 blocking calls — must run on a dedicated
  `std::thread`, not inside a tokio async task directly.
- The raw mapped pointer must be wrapped in a `Send`-safe newtype so it can cross thread
  boundaries through `Arc`.
- Non-Windows builds must produce a stub that compiles and returns `is_connected() = false`.

**Scale/Scope**: Single-user, single-process. iRacing exposes ≤ 350 live telemetry variables
per session; 10–20 fields in the watchlist at a time.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Real-Time Reliability | ✅ Pass | Polling task is detached; won't block the future voice path. 10 Hz watchlist push is well within the 3 s latency budget. |
| II. Workspace Isolation | ✅ Pass | All new types live in `apps/tauri-client/src-tauri`. No cross-workspace imports. Preact UI uses Tauri events, not workspace package imports. |
| III. Agent Autonomy Contract | ✅ N/A | No LLM or agent decisions in this feature. |
| IV. Local-First Infrastructure | ✅ Pass | Reads directly from Windows shared memory — zero network dependency. |
| V. Observability-Driven | ⚠️ Gate | Connection transitions (Connected ↔ Disconnected) MUST be logged via `tracing::info!`. Session-change events MUST be logged. Failed connection attempts MUST emit `tracing::warn!`. |
| VI. Test-Backed Change | ⚠️ Gate | Unit tests required for: `parse_header()`, `enumerate_vars()`, `extract_session_yaml()`, `is_connected()`. Must pass on non-Windows in CI. No `packages/types` TypeScript validators are added in this feature — all new types are Rust structs exported to TypeScript via `ts-rs` auto-generated bindings; mocha + chai TypeScript test requirement is N/A for this feature. |
| VII. Incremental Delivery | ✅ Pass | Scoped to diagnostic UI only. No Redis publish, no LLM, no audio in this feature. |

**Post-Phase 1 re-check**: Pass. Design preserves all gates — tracing calls integrated at
every state transition; unit tests are plannable against the stub buffer path.

## Project Structure

### Documentation (this feature)

```text
specs/001-iracing-sdk-diagnostics/
├── plan.md                  ← this file
├── research.md              ← Phase 0 decisions
├── data-model.md            ← Phase 1 entities and state
├── quickstart.md            ← Phase 1 validation guide
├── contracts/
│   ├── tauri-commands.md    ← invoke() API surface
│   └── tauri-events.md      ← Rust → Frontend push events
└── tasks.md                 ← Phase 2 (/speckit-tasks)
```

### Source Code

```text
apps/tauri-client/
├── src-tauri/
│   ├── Cargo.toml                        ← add serde_yaml
│   └── src/
│       ├── iracing/
│       │   ├── defines.rs                ← add IRSDK_STATUS_CONNECTED, VAR_HEADER_SIZE, header byte offsets
│       │   ├── sdk.rs                    ← implement open(), enumerate_vars(), read_session_info(), read_var_*()
│       │   ├── types.rs                  ← add TelemetryField, TelemetryValue, VarType; fix duplicate ConnectionStatus
│       │   └── mod.rs                    ← re-export new public types
│       ├── commands.rs                   ← add: get_iracing_status, get_session_data, list_telemetry_fields, get_watchlist, set_watchlist
│       ├── state.rs                      ← add IracingState + watchlist; remove duplicate ConnectionStatus
│       └── lib.rs                        ← register new commands; spawn connection_watcher task
└── src/
    ├── App.tsx                           ← add Diagnostics tab
    └── pages/
        └── Diagnostics.tsx               ← new: connection badge, session panel, field browser, watchlist
```

## Complexity Tracking

| Addition | Justification |
|----------|---------------|
| `serde_yaml = "0.9"` (new Rust crate) | Required to parse the session YAML blob embedded in iRacing's shared memory. No alternative without writing a custom YAML parser; this is the established community crate for this use case. Scoped to this crate only — no transitive workspace impact. |

No constitution violations requiring justification beyond the above.
