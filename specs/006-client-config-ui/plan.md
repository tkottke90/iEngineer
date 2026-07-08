# Implementation Plan: Tauri Client Configuration UI

**Branch**: `006-client-config-ui` | **Date**: 2026-07-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-client-config-ui/spec.md`

> **Phase numbering cross-reference (F1/I2)**: The Implementation Phases in this document use letters A–H ordered by dependency flow; `tasks.md` uses Phase 1–9 ordered by story priority and is authoritative for execution sequencing. Mapping: A=1 (Setup), D=2 (US1 Audio), B=3 (US2 Connection/LLM), C=4 (US3 PTT), tasks Phase 5 (US4 Personality) has no plan letter (verification-only phase), E=6 (US5 Debug), F=7 (US7 Logging), G=8 (US6 Voice), H=9 (Polish). When this document says "Phase B," read tasks.md Phase 3.

## Summary

M10 transforms the existing single-page `Setup.tsx` stub into a fully wired, 7-tab configuration UI. ~60% of the underlying infrastructure already exists from M4/M5 (`AppConfig` struct, Tauri commands, `PersonalityPanel` component, `AudioDeviceTestPanel` component, personality Redis sync). The work is: restructuring into tabs, wiring the remaining stubs (audio device selection, PTT interactive binding), adding LLM config fields and runtime hub update, and implementing P3 features (voice profile upload, telemetry logging). No new services are introduced.

**Key reuse**: `PersonalityPanel`, `AudioDeviceTestPanel`, `save_config()`, `list_audio_devices()`, `check_redis()`, `check_hub()`, `test_audio_playback()` are all M4/M5 assets consumed as-is.

## Technical Context

**Language/Version**: TypeScript (Preact, Node.js 22) — UI + hub endpoints; Rust (edition 2021) — Tauri commands

**Primary Dependencies**:
- Hub (new): `music-metadata` (npm — MP3 duration validation in voice profile endpoint). Existing: `ioredis`, `hono`, `@tkottke90/logger`, OpenTelemetry.
- Tauri (new): No new Rust crates required — `tauri-plugin-global-shortcut` already registered (M5/T007). Exception (F4): `scopeguard` MAY be added if T028/I3's RAII guard-release option is chosen over a hand-rolled `Drop` guard — either implementation is acceptable. Existing: `cpal` (audio), `tauri-plugin-global-shortcut` (PTT), `redis` (pub/sub).

**Storage**:
- `AppConfig` (Tauri local store, JSON): extended with LLM fields + telemetry logging fields
- Redis KV `hub:config:llm` (NEW): LLM baseUrl + model for runtime hub switching
- Redis KV `hub:config:voice-profile` (NEW): active voice profile filename + timestamp
- Telemetry log files: `*.ndjson` in the platform-derived app-data directory (`app_data_dir()/logs/telemetry` — displayed read-only in M10, not user-editable; I5)

**Testing**: `cargo test` (Tauri Rust units); `npm test` (hub TypeScript units, mocha + chai); mocha + chai for `packages/ui` component contracts per Constitution VI — **known gap (C1)**: `packages/ui` has NO test infrastructure as of 2026-07-08; T006b bootstraps it; Vitest + `@testing-library/preact` for tauri-client frontend units — **known gap (D2)**: `apps/tauri-client/` currently has NO Vitest config or `test` script (confirmed 2026-07-08); T009/E3 bootstraps it as a Phase 1 prerequisite before the T010 gate clears; manual per `quickstart.md` SC-1 through SC-8 plus sub-scenarios (13 total — see T040); no agent evals needed (no LLM decision paths modified)

**Target Platform**: macOS / Windows desktop (Tauri); local hub server (Node.js)

**Project Type**: npm-workspaces monorepo — extends `apps/tauri-client`, `apps/hub-server`, `packages/ui`

**Performance Goals**: Config save < 200ms locally (hub sync async, off critical path); debug panel ≤ 1s lag; device switch effective on next capture/playback init

**Constraints**: LLM config update MUST NOT restart hub or interrupt active session. Telemetry logging MUST NOT affect Tier 1/2 alert latency (isolated async write path — FR-020). Save failure MUST retain unsaved form state (FR-027).

**Scale/Scope**: Single driver, 7 settings tabs, ~10 new/extended Tauri commands, 1 new hub endpoint (`POST /api/voice-profile`; the upload response's `testClipUrl` reuses the existing M4 `GET /api/audio/:audioId` route — I4).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|-----------|-------|--------|
| I. Real-Time Reliability | Config save + voice upload are async; Racing Engineer path never awaits them? | ✅ `save_config()` spawns a task for Redis sync; hub voice upload is async; telemetry logger is an isolated async task with bounded channel (frames dropped, not blocked). |
| I. Real-Time Reliability | Telemetry logging does not increase alert latency? | ✅ Logging runs on a separate async task via bounded channel. Channel-full → drop frame + warn event; never blocks the telemetry event handler. |
| II. Workspace Isolation | New UI components in `packages/ui`? No cross-app imports? | ✅ `SettingsTabs` added to `packages/ui`. `Setup.tsx` imports only from `packages/ui`. Hub and Tauri remain non-importing of each other. |
| III. Agent Autonomy | No new LLM decision paths? No prompts changed? | ✅ M10 only exposes which LLM endpoint/model is used — no prompt content changes; no evals required. |
| IV. Local-First | LLM endpoint runtime-switchable, no hardcoded provider? | ✅ This feature IS the UI surface that enables runtime switching (Constitution IV's intent). API key stays local — not written to Redis. |
| IV. Local-First | No new cloud dependencies? | ✅ `music-metadata` is an npm package used locally in hub (no network calls). No new services. |
| IV. Local-First | Infrastructure changes in `infra/` before code references them? | ✅ Chatterbox shared volume added to `infra/docker-compose.yml` in Phase G **before** the voice profile hub endpoint is written. |
| V. Observability | Config changes logged? LLM synthesis write path audited? | ✅ `save_config()` emits structured log on every save (fields changed, hub sync result). Voice upload logged on hub side. ⚠️ **Pending T043/D1**: Principle V's requirement that LLM synthesis events are written to Postgres with `llm_model`/`llm_base_url` cannot be marked fully ✅ until T043's write-path unit test passes in CI — see DoD F1. |
| VI. Test-Backed Change | Unit tests for all new commands + hub endpoints + `packages/ui` component contracts? | ✅ Required per Definition of Done — device-not-found, PTT timeout, LLM connect failure, voice format/duration validation, logger channel-full, LLM config Redis read. **C1**: `SettingsTabs` component contract tests (mocha + chai per Constitution VI's `packages/ui` clause) added as T006b — this row previously scoped the gate to commands + endpoints only and missed the ui-component requirement. |
| VII. YAGNI | Stream Engineer config excluded? | ✅ Only Racing Engineer config exposed. `BroadcastPlanEditor` untouched. |

**Constitution violations**: None. No amendments required.

## Project Structure

### Documentation (this feature)

```text
specs/006-client-config-ui/
├── plan.md              # This file
├── research.md          # Phase 0 — technology + architecture decisions
├── data-model.md        # Phase 1 — types, entities, state transitions
├── quickstart.md        # Phase 1 — validation scenarios SC-1 through SC-8
├── contracts/
│   ├── tauri-commands.md        # New/extended Tauri command contracts
│   ├── hub-llm-config.md        # hub:config:llm Redis KV contract
│   └── hub-voice-profile.md     # POST /api/voice-profile hub endpoint
└── tasks.md             # Phase 2 — generated by /speckit-tasks
```

### Source Code

```text
packages/ui/src/components/
└── SettingsTabs/
    └── index.tsx              # NEW — tab bar + content area; 7 tab items;
                               #   unsaved form state preserved on tab switch

apps/tauri-client/
├── src/pages/
│   ├── Setup.tsx              # Extend — restructure into SettingsTabs with 7 tabs
│   │                          #   (Audio, Connection, Hotkeys, Personality, Debug, Voice, Logging);
│   │                          #   add LLM config fields + API key (masked);
│   │                          #   wire audio dropdowns to set_audio_device();
│   │                          #   implement PTT bind flow (bind_ptt_hotkey() + listening state);
│   │                          #   add Voice Profile upload control;
│   │                          #   add Telemetry Logging toggle + path display;
│   │                          #   add Debug tab (absorbs Diagnostics.tsx live content)
│   └── Diagnostics.tsx        # Thin redirect/wrapper to Debug tab (URL compatibility)
└── src-tauri/src/
    ├── state.rs               # Extend AppConfig: add llm_base_url, llm_model, llm_api_key,
    │                          #   telemetry_logging_enabled, telemetry_log_dir;
    │                          #   remove deprecated M4 stubs (chattiness, familiarity, aggression)
    ├── commands.rs            # Extend save_config(): write hub:config:llm to Redis;
    │                          #   implement set_audio_device() (cpal device switch via watch channel);
    │                          #   implement bind_ptt_hotkey() (global-shortcut capture flow);
    │                          #   add check_llm(), upload_voice_profile(),
    │                          #       toggle_telemetry_logging(), get_debug_snapshot()
    ├── hotkeys/ptt.rs         # Extend — global-shortcut capture for interactive key binding
    ├── audio/
    │   ├── capture.rs         # Extend — accept device-switch signal via tokio watch channel
    │   └── playback.rs        # Extend — accept device-switch signal via tokio watch channel
    └── telemetry/
        └── logger.rs          # NEW — async NDJSON writer; bounded channel (cap 1000);
                               #   session-scoped file naming; graceful drain on stop

apps/hub-server/
├── src/
│   ├── api.ts                 # Add POST /api/voice-profile (multipart, music-metadata validation)
│   └── engineer/
│       ├── llm-client.ts      # Extend — per-request read of hub:config:llm from Redis;
│       │                      #   fallback to engineer-config.json if absent/malformed (log once)
│       └── tts-client.ts      # Extend — read hub:config:voice-profile on startup;
│                              #   apply active profile filename
├── config/
│   └── engineer-config.json   # Add chatterboxReferenceAudioDir field
└── package.json               # Add music-metadata dependency

infra/
└── docker-compose.yml         # Add shared volume between hub-server and chatterbox
                               #   for reference audio files (required before Phase G)
```

**Structure Decision**: Extends the M4/M5 layout. The tab restructure is entirely contained in `Setup.tsx` + a new `SettingsTabs` UI component. All new Tauri commands are in the existing `commands.rs`. Hub changes are additive only (new route + extended existing clients). No new packages or apps.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Voice profile requires Docker shared volume coordination | Chatterbox has no file upload API; reference audio must exist on its filesystem | Direct Tauri → Chatterbox filesystem write not viable (Docker network boundary); hub-proxy is the only path within the existing stack that doesn't modify Chatterbox |
| Per-request Redis read for LLM config | SC-002 requires next Tier 3 uses new model after save, no restart | A cached value at startup requires a restart; a Redis pub/sub watch adds a subscription with reconnect logic; per-request read is 1–2ms, well within the 5s Tier 3 budget |

## Implementation Phases

> **F3 — Phase letter ordering note**: Phases A–H below reflect implementation dependency flow, NOT user story priority. US1 Audio (P1) maps to Phase D (fourth phase) because its implementation depends on Phase A's AppConfig + tab structure. US2 Connection (P1) maps to Phase B (second phase) for the same reason. During implementation, **follow tasks.md phase numbering** (Phase 2 = US1 Audio P1, Phase 3 = US2 Connection P1), which correctly sequences by user story priority. The phase letters here are a reference architecture for understanding dependencies; the task phases are authoritative for sprint planning and sequencing.
>
> **I2 — Phase letter-to-number mapping**: see the cross-reference table at the top of this document (directly below **Input**). Quick recall: Phase B = tasks.md Phase 3.

### Phase A: AppConfig Extension + Tab Restructure (Prerequisite)

1. Extend `AppConfig` in `apps/tauri-client/src-tauri/src/state.rs`:
   - Add: `llm_base_url: String` (default: `"https://lemonade.tdkottke.com/v1"`), `llm_model: String` (default: existing M5 model), `llm_api_key: String` (default: `""`).
   - Add: `telemetry_logging_enabled: bool` (default: `false`), `telemetry_log_dir: String` (default: `""` sentinel — resolved at startup via `app_handle.path().app_data_dir()` in the T001 init flow; `Default::default()` cannot call `app_data_dir()` without a Tauri app handle).
   - Add: `first_launch_seen: bool` (default: `false` — FR-007 hint lifecycle); change `ptt_hotkey` default from `"F13"` to `""` (never-configured sentinel; startup registration skips `""` — T001/I1). (I6 — this list previously omitted both; T001 is authoritative for the full field set.)
   - Remove: deprecated M4 stub fields `chattiness`, `familiarity`, `aggression` — confirm zero remaining call sites.
   - Update `Default` impl.
2. Add `SettingsTabs` to `packages/ui/src/components/SettingsTabs/index.tsx` — tab bar + content area; accepts tab definitions as props; preserves unsaved state object across tab switches (single lifted state in parent).
3. Restructure `Setup.tsx` using `SettingsTabs` (7 tabs). Move existing sections into appropriate tabs. Debug tab absorbs `Diagnostics.tsx` live content. Export from `packages/ui/src/index.ts`. **Note (F3)**: `Diagnostics.tsx` is an existing page from M4 that previously served a standalone diagnostics view. Any in-app navigation links that reference `/diagnostics` (check the router config and any nav components) must be verified to still resolve — the redirect/alias in T009 preserves backward compatibility for these links.

**Gate**: `npm run build && npm run typecheck` workspace-wide; `cargo check`; `npm test --workspace=packages/ui` (SettingsTabs contract tests — T006b, ≥1 passing test); existing Setup.tsx functionality unchanged.

---

### Phase B: Hub — LLM Config Runtime Update + Connection Tab (US2, P1)

1. Extend `save_config()` in `commands.rs`: in the existing async Redis sync task, write `hub:config:llm = { baseUrl, model }` (no apiKey) when LLM fields differ from current persisted values.
2. Extend `apps/hub-server/src/engineer/llm-client.ts`: at the top of each synthesis call, `redis.get("hub:config:llm")` → parse → apply values; fall back to `engineer-config.json` if absent or malformed (one warn log per fallback type per startup — mirrors `personality-config.ts` pattern).
3. Add `check_llm(base_url, model, api_key)` Tauri command — minimal HTTP probe of LLM endpoint; returns `ConnectionTestResult`. Wire "Test" button in Connection tab.
4. Add LLM fields (baseUrl, model, API key masked) to Connection tab in `Setup.tsx` with inline URL validation (FR-026).

**Gate**: Unit test — `llm-client.ts` with mocked `ioredis`: absent key → fallback + single warn; present key → applied values on next call; malformed JSON → fallback + single warn. Integration (SC-2): change model name in UI → hub log shows new model on next Tier 3.

---

### Phase C: PTT Interactive Binding (US3, P2)

1. Implement `bind_ptt_hotkey()` Tauri command in `commands.rs` + extend `apps/tauri-client/src-tauri/src/hotkeys/ptt.rs`:
   - Enter "listening" mode via `tauri-plugin-global-shortcut`.
   - Await first non-modifier keypress (10s timeout via `tokio::time::timeout`).
   - Unregister catch-all; register captured key as PTT binding.
   - Return `Ok(key_name)` or `Err(reason)` per `contracts/tauri-commands.md`.
2. Wire Hotkeys tab in `Setup.tsx`: "Set PTT Key" → invoke `bind_ptt_hotkey()` → show "listening..." indicator while awaiting → update display on result → surface error with specific message (FR-012).
3. Confirm PTT press/release pipeline uses the bound key (not hardcoded).

**Gate**: `cargo test` — timeout path returns `Err("ptt:timeout")`; key-conflict returns `Err("ptt:key-conflict")`; accessibility-denied mock returns `Err("ptt:accessibility-denied")`. Manual: SC-3, SC-3b.

---

### Phase D: Audio Device Selection Wiring (US1, P1)

1. Implement `set_audio_device(device_name, device_type)` in `commands.rs`:
   - Validate device exists in `cpal` device list; return `Err("device not found")` if not.
   - Send new device name via `tokio::sync::watch` channel to running `AudioCapture` / `AudioPlayback` tasks.
2. Extend `audio/capture.rs` and `audio/playback.rs` to watch the channel and reinitialize the `cpal` stream on device change.
3. Wire Audio tab: on dropdown selection change, call `set_audio_device()` immediately; persist on "Save." On app startup, if saved device not in current list, fall back to system default + emit `audio:device-unavailable` Tauri event; show "unavailable" state in Audio tab (US1 acceptance scenario 5 — I6: previously miscited as "FR-004 acceptance scenario 4"; FR-004 has no scenarios and scenario 4 is the mic meter).

**Gate**: `cargo test` — device-not-found returns `Err`; invalid `device_type` value (not `"input"` or `"output"`) returns `Err("invalid device type")`; watch channel receives correct device name signal. Manual: SC-1. **U5 note**: T015 uses the existing M4 `test_audio_playback()` command for the "Test Playback" button — verify during SC-1 that the M4 clip is audible (non-silent, approximately 1 second duration). If the M4 command plays silence or a very short clip, the SC-001 timing and FR-006 acceptance criteria cannot be verified.

---

### Phase E: Telemetry Debug Tab (US5, P2)

1. Implement `get_debug_snapshot()` Tauri command — returns current `DebugSnapshot` for initial tab load (see `data-model.md`).
2. Wire Rust telemetry subscription loop to emit `telemetry:debug-snapshot` Tauri events at ~1 Hz while session active (extend existing telemetry listener).
3. Wire Debug tab in `Setup.tsx`: call `get_debug_snapshot()` on mount; subscribe to `telemetry:debug-snapshot` events; display fixed variable set + infrastructure status; "No active session" when `sessionActive: false`; Redis stream lag > 500ms highlighted in red (FR-018).
4. Make `Diagnostics.tsx` a thin redirect/wrapper so existing navigation links still work.

**Gate**: Unit tests (T029b) — `DebugSnapshot` serialization round-trip, `get_debug_snapshot()` no-session default, single-flight guard release on probe timeout. Manual: SC-5.

---

### Phase F: Telemetry Logging Toggle (US7, P3)

1. Implement `apps/tauri-client/src-tauri/src/telemetry/logger.rs`:
   - Bounded channel (capacity: 1000 `TelemetryLogFrame`s); channel-full → drop + increment counter.
   - New log file per session: `iracing-telemetry-{sessionId}-{YYYYMMDD-HHmmss}.ndjson` in `AppConfig.telemetry_log_dir`.
   - Graceful stop: drain channel, flush, close file on `toggle_off` signal.
   - Emits `telemetry:log-warning` Tauri event on channel-full or disk-full.
2. Implement `toggle_telemetry_logging(enabled)` Tauri command — signals logger task; persists `AppConfig.telemetry_logging_enabled`.
3. Wire Logging tab: toggle + directory path display + warning banner on `telemetry:log-warning`.

**Gate**: `cargo test` — channel-full drops without panic; file created on enable; file closed on disable. Manual: SC-8.

---

### Phase G: Voice Profile Upload (US6, P3)

**Prerequisite**: Confirm `infra/docker-compose.yml` has a shared volume between hub-server and chatterbox for reference audio. Add if not present. This MUST be done before hub code references the directory.

1. Add `music-metadata` to `apps/hub-server/package.json`; `npm install` at repo root.
2. Add `chatterboxReferenceAudioDir: "/data/chatterbox/reference"` to `engineer-config.json`.
3. Implement `POST /api/voice-profile` in `apps/hub-server/src/api.ts` per `contracts/hub-voice-profile.md`:
   - Multipart receive → format check (MIME + magic bytes) → duration check via `music-metadata` → write to `chatterboxReferenceAudioDir/{filename}` → update `hub:config:voice-profile` in Redis → synthesize test clip → return 200 JSON.
4. Extend `tts-client.ts` to read `hub:config:voice-profile` from Redis on startup and apply the active profile filename.
5. Implement `upload_voice_profile(file_path)` Tauri command — read file, validate MP3 magic bytes, multipart POST to hub, return `VoiceProfileResult`.
6. Wire Voice tab in `Setup.tsx`: file picker (MP3 filter) → call `upload_voice_profile()` → progress indicator → result display (filename + timestamp) → "Test Voice" button calls `test_audio_playback()` (the existing M4 command; after upload the hub uses the new profile, so the standard audio test naturally plays the cloned voice).

**Gate**: Unit tests — format validation rejects non-MP3; duration < 3s and > 60s rejected with specific messages. Integration: upload 10s MP3 → hub writes file → test clip URL returns audio. Manual: SC-7, SC-7b, SC-7c.

---

### Phase H: Save Failure Handling + End-to-End

1. Implement save failure surface (FR-027) in `Setup.tsx`:
   - If `save_config()` returns `Err`: retain all tab form state, show inline error with specific cause. Block repeated saves until issue resolved.
   - If `save_config()` returns `Ok` but includes a hub sync warning: show non-blocking dismissable banner ("Settings saved locally. Hub sync failed: [reason]").
2. Run all 13 quickstart scenarios (SC-1 through SC-8 plus SC-3b, SC-5b, SC-6b, SC-7b, SC-7c) end-to-end against local infra.
3. `npm run build && npm run typecheck` workspace-wide; `cargo test`; `rustfmt`; `clippy`; ESLint + Prettier.

**Gate**: All SC scenarios pass; workspace builds cleanly with no type or lint errors.

## Definition of Done

- [ ] `npm run build && npm run typecheck` workspace-wide passes.
- [ ] `cargo test` passes; `rustfmt` + `clippy` clean; ESLint + Prettier clean.
- [ ] Unit tests: device-not-found (`set_audio_device`), PTT timeout + accessibility error (`bind_ptt_hotkey`), LLM connect failure (`check_llm`), voice format/duration validation (`upload_voice_profile` + hub endpoint), logger channel-full (`logger.rs`).
- [ ] Unit tests: `SettingsTabs` component contract in `packages/ui` (mocha + chai per Constitution VI): tab rendering, tab switching, first-tab default, parent-state preservation across switches (T006b — includes bootstrapping the package's test infrastructure, absent as of 2026-07-08).
- [ ] Unit tests: `llm-client.ts` Redis read — absent key → fallback + one warn; present key → applied; malformed → fallback + one warn.
- [ ] Unit test: `POST /api/voice-profile` — format check, duration check, Redis write.
- [ ] All 13 quickstart scenarios pass manually (SC-1 through SC-8 plus SC-3b, SC-5b, SC-6b, SC-7b, SC-7c — T040's enumeration is authoritative; do not rely on this count if quickstart.md gains scenarios; I3). For spec SC-008: P99 Tier 1 alert latency MUST NOT increase by more than 50ms when telemetry logging channel is at 80% capacity vs. disabled baseline (per spec SC-008 quantitative threshold — "no measurable increase" alone is not an acceptable pass condition).
- [ ] SC-002 verified: LLM model name change in UI → next Tier 3 uses new model; no hub restart.
- [ ] Quickstart SC-7 verified: voice profile upload → test clip plays with cloned voice. (I2 — this line previously read "SC-007", the three-digit spec numbering; per the numbering convention, spec SC-007 is the persistence criterion on the next line.)
- [ ] Spec SC-007 verified: all settings survive an app restart — every field displays its saved value on next open, none revert to defaults (T040's timing checks include this force-quit/relaunch pass).
- [ ] Deprecated M4 fields (`chattiness`, `familiarity`, `aggression`) removed from `AppConfig` with zero remaining references.
- [ ] `hub:config:llm` key format matches `contracts/hub-llm-config.md`; confirm `apiKey` is absent from the Redis value at all times.
- [ ] **C1 — Constitution III & V / Cloud API key gap** (F6 — both principles apply: III, auditable agent decisions; V, LLM interactions written to Postgres): For M10, the Constitution III & V LLM audit gate (FR-029/T043) is fully satisfied only for local endpoints (Lemonade homelab default). Cloud provider endpoints (e.g., `api.anthropic.com`) that receive silent 401 failures produce NO `engineer_events` audit row — the synthesis never reaches `tier3-synthesizer.ts`. This is a known M10 limitation (documented in spec Assumptions). The PR description MUST explicitly note: "Constitution III & V are partially satisfied in M10 — LLM synthesis audit trail is complete for the Lemonade endpoint but absent for cloud providers that 401. Full cloud audit compliance is a M10+ follow-up." Do NOT mark this DoD item as unblocking — it is an acknowledgement gate, not a blocker. **B1 — Project-owner sign-off (explicit Constitution III & V exception; F6 — both principles apply)**: The project owner has given explicit approval for the M10 Constitution III & V partial exception for cloud LLM endpoints (2026-07-08). The analysis noting this as a Constitution III & V partial violation (cloud 401 silent audit gap) is acknowledged and accepted as a known M10 limitation. This sign-off satisfies the constitution's governance requirement; no constitution amendment is required. The PR description note above (C1) remains mandatory. **C1-IV extension (2026-07-08)**: This sign-off is extended to cover the Constitution IV / Technology Constraints clause naming the LLM default ("LLM: Claude API is the default"; table row "LLM default | Anthropic Claude API"). M10 ships the Lemonade homelab endpoint (`https://lemonade.tdkottke.com/v1`) as the configured default — a deviation that has existed since M5's `engineer-config.json`, which M10 surfaces rather than introduces — and the Claude API is not usable end-to-end in M10 because the API key is not forwarded to the hub (per the Constitution V exception above). The owner accepts the local-endpoint default for M10. Constitution IV's MUST clause (runtime-switchable provider, no hard-coded lock-in) remains fully satisfied — this feature builds exactly that switchability surface. The wording PATCH was applied 2026-07-08 (constitution v1.2.0 → v1.2.1 — Principle IV LLM bullet + Technology Constraints LLM row); this sign-off record is retained for audit.
- [ ] **F1 / C2 — Constitution III gate (BLOCKING)**: The unit test added in T043/D1 (`tier3-synthesizer.test.ts` asserting `llm_model` appears in the `engineer_events` audit row) MUST pass before merge. Preferred enforcement: CI workflow. **I1 (workflow contents verified 2026-07-08)**: `.github/workflows/ci.yml` EXISTS but currently runs only `cargo test -p iracing-engineer-lib` and `npm run build -w apps/hub-server` — it does NOT run `npm test`, so the write-path test would never execute in CI as-is. T043's gate work includes ADDING an `npm test -w apps/hub-server` step to `ci.yml` before any T017–T021 merge (see T042/C2 branch (a2)). If CI were ever absent: pre-commit hook or mandatory PR checklist item (see T042/D1/C2). One of these three mechanisms MUST be in place — undocumented manual verification is NOT acceptable. This is an automated CI gate — human inspection of the schema or manual checklist verification in T042 is supplementary, not a substitute. A missing test, skipped test, or failing test is a merge blocker. A model switch enabled by M10 without an automated audit-trail verification violates Constitution III.
- [ ] `POST /api/voice-profile` response matches `contracts/hub-voice-profile.md`.
- [ ] `infra/docker-compose.yml` has shared volume for Chatterbox reference audio before Phase G code is merged.
- [ ] **C4/E2 — AppConfig round-trip test**: Unit test verifying that `AppConfig` deserialization from an old-format JSON (without `first_launch_seen`) defaults the field to `false` — confirms backward-compatibility of the new field (T001/E2).
- [ ] **C4/E2 — SC-005 lag hysteresis test**: Unit test (mocked `Date.now()`) asserting that a first `telemetry:debug-snapshot` event with `redisStreamLagMs > 500` does NOT show the lag warning (`hasReceivedFirstSnapshot` guard); and that the warning only appears after sustained ≥5000ms above threshold (T029/B2).
