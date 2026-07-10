# Phase 0 Research: Tauri Client Configuration UI

**Date**: 2026-07-07 | **Feature**: specs/006-client-config-ui

---

## R1 — Existing M4/M5 Infrastructure (What Already Exists)

**Decision**: Treat M10 primarily as a wiring + extension milestone, not a greenfield build.

**Rationale**: The Explore audit confirmed that ~60% of the required functionality exists in some form:

| Requirement | Status | Location |
|-------------|--------|----------|
| AppConfig struct (all OCEAN traits, PTT hotkey, audio device fields) | ✅ Complete | `state.rs` |
| `save_config()` → local persist + personality Redis sync | ✅ Complete | `commands.rs` |
| `list_audio_devices()`, `check_redis()`, `check_hub()` | ✅ Complete | `commands.rs` |
| `test_audio_playback()` → hub `/api/audio/test` | ✅ Complete | `commands.rs` |
| PersonalityPanel (5 sliders, word anchors) | ✅ Complete | `packages/ui` |
| AudioDeviceTestPanel (mic meter, playback test, PTT detection) | ✅ Complete | `packages/ui` |
| Setup.tsx (connection + audio + personality sections, single page) | ✅ Mostly done | `Setup.tsx` |
| Diagnostics.tsx (telemetry debug readout, stub wiring) | Stub | `Diagnostics.tsx` |
| `set_audio_device()` command | Stub (no-op) | `commands.rs` |
| PTT hotkey binding (interactive capture) | Stub | `hotkeys/ptt.rs` |
| LLM config fields in AppConfig | ❌ Missing | — |
| LLM config runtime update (hub) | ❌ Missing | — |
| Telemetry logging toggle | ❌ Missing | — |
| Voice profile upload | ❌ Missing | — |
| Tabbed settings UI | ❌ Missing (single-page currently) | — |
| Save failure handling (FR-027) | ❌ Missing (fire-and-forget) | — |

**Alternatives considered**: Rewriting Setup.tsx from scratch. Rejected — the existing page has the
right Tauri command wiring; a tab wrapper is additive, not a rewrite.

---

## R2 — LLM Config Runtime Update Mechanism

**Decision**: Extend the existing `hub:config:personality` Redis pattern to `hub:config:llm`. The hub reads this key at the start of each LLM request (or watches via pub/sub on config-change events).

**Rationale**: The hub server already loads `hub:config:personality` from Redis on each request (via `parsePersonality()` in `personality-config.ts`). The same read-per-request pattern for `hub:config:llm` gives free runtime switching with zero new infra. The Tauri `save_config()` command already writes to Redis for personality — extending it to also write `hub:config:llm` is two extra lines.

**Format** (matches personality pattern):
```json
{
  "baseUrl": "https://lemonade.tdkottke.com/v1",
  "model": "user.Ornith-1.0-35B-GGUF",
  "apiKey": ""
}
```

**API key security**: For a local-only desktop app, storing the API key in the OS credential store (Tauri stronghold or system keychain) is the ideal approach. However, `tauri-plugin-stronghold` requires additional setup. For M10, the API key is stored in AppConfig (local Tauri config file, not synced to hub or Redis — only the base URL and model are written to `hub:config:llm`). The key is passed to the hub at request time via a Tauri command that the hub invokes, or stored in the hub's own config. See contract: `hub-llm-config.md`.

**Alternatives considered**:
- New HTTP `POST /api/config/llm` endpoint on hub. Rejected — Redis is already the config channel; a second channel adds complexity with no benefit.
- Restart the hub when LLM config changes. Rejected — M10 SC-002 requires no restart.

---

## R3 — PTT Interactive Hotkey Binding

**Decision**: Use `tauri-plugin-global-shortcut` (already registered in M5/T007) to implement the "press a key to record binding" flow. The plugin's `register()` API can be called dynamically after the user presses a key.

**Rationale**: `tauri-plugin-global-shortcut` exposes a `register(shortcut, handler)` API that returns an error if the binding fails (OS conflict or permission denied). The "listening" mode is implemented by:
1. Registering a catch-all keyboard listener temporarily using the plugin's `isRegistered` and `unregister` helpers.
2. Capturing the first non-modifier keypress.
3. Unregistering the catch-all and registering the captured key as the PTT binding.

On macOS, the Accessibility permission must be granted; `tauri-plugin-global-shortcut` returns a specific error if denied, which the UI surfaces as FR-012 requires.

**Stream Deck passthrough**: Works via the same global hotkey path — Stream Deck maps a button to a keypress (e.g., F13), which the plugin captures identically to a keyboard key.

**Alternatives considered**: `rdev` crate for raw key listening. Rejected — already have the global-shortcut plugin registered; adding a second input library would duplicate functionality.

---

## R4 — Audio Device Selection Persistence

**Decision**: Extend the existing `set_audio_device()` stub in `commands.rs` to write the selected device name to the `cpal` device selector and persist it in `AppConfig`. On app startup, the audio subsystem reads `AppConfig.audio_input_device` and `AppConfig.audio_output_device` to initialize `AudioCapture` and `AudioPlayback` with the correct device.

**Rationale**: `cpal` supports named device selection — `cpal::default_host().input_devices()` and `output_devices()` return iterators filterable by name. `AudioCapture::new(device_name)` already takes `Option<String>` (matching the AppConfig field). The wire-up is missing, not the design.

**Device unavailability**: If a saved device name is not in the current system device list on startup, the system falls back to the system default and emits a structured log. The UI shows "unavailable — using system default."

---

## R5 — Voice Profile Upload (P3)

**Decision**: Tauri sends the MP3 to the hub server `POST /api/voice-profile` (multipart). The hub:
1. Validates format (must be MIME type `audio/mpeg`) and duration (3–60 seconds).
2. Writes the file to the configured Chatterbox reference audio directory (Docker volume path, configurable in `engineer-config.json`).
3. Updates `chatterboxVoiceFile` in the hub's runtime config.
4. Returns a test-clip URL by triggering a test TTS synthesis with the new profile.

**Rationale**: The Chatterbox TTS server expects the reference file to exist on its filesystem — it does not expose a file-upload API (its `/tts` endpoint accepts `reference_audio_filename` as a string path, not file data). The hub is colocated with Chatterbox (same Docker Compose stack) and can write to the shared volume. This is the only viable approach without modifying Chatterbox itself.

**Duration validation**: `ffprobe` (available in the hub server container) or the Node.js `music-metadata` package can extract MP3 duration. `music-metadata` is preferred (no subprocess).

**Alternatives considered**:
- Direct Tauri-to-Chatterbox upload: Rejected — Chatterbox has no upload API and may not be network-accessible from the Tauri client (host network vs. Docker network).
- Allow WAV in addition to MP3: Rejected (spec clarification Q2 — MP3 only).

---

## R6 — Telemetry Logging Toggle

**Decision**: When enabled, Tauri appends each incoming telemetry frame (received from the hub via Redis pub/sub or Tauri events) to a newline-delimited JSON file in the configured log directory. Logging starts at session start and stops at session end or when toggled off. The write path is a separate async task — it never blocks the event handler (Constitution I).

**Rationale**: Telemetry is already flowing into the Tauri client as Tauri events (Dashboard.tsx receives them). Logging is a tap on that pipeline, not a new source. The async file writer uses a bounded channel — if the channel is full (disk too slow), frames are dropped with a warning log; the racing engineer path is never affected (FR-020).

**Format**: Newline-delimited JSON (`*.ndjson`), one object per frame, fields matching the existing `TelemetryFrame` type.

**Alternatives considered**: Binary format (IBT-compatible): Rejected for M10 — M9 handles IBT analysis tooling. The NDJSON format is human-readable and sufficient for future parsing.

---

## R7 — Settings Tab Structure

**Decision**: Restructure `Setup.tsx` into 7 tabs using a lightweight tab component built in-project (Preact + CSS, no new UI library). Tab state is kept in local component state; unsaved changes in all tabs are preserved in a single form-state object while the user switches tabs, committed only on explicit "Save."

**Tabs and content mapping**:

| Tab | Content | Primary FR |
|-----|---------|------------|
| Audio | Device dropdowns, mic meter, playback test | FR-001–006 |
| Connection | Redis URL, hub URL, LLM URL, model, API key, test buttons | FR-007–009 |
| Hotkeys | PTT binding capture, Stream Deck note | FR-010–012 |
| Personality | PersonalityPanel (5 sliders) | FR-013–015 |
| Debug | Live telemetry vars, stream lag, connection status | FR-016–018 |
| Voice | MP3 upload, duration validation, test voice | FR-021–024 |
| Logging | Toggle + log directory path | FR-019–020 |

**Deferred from Diagnostics.tsx**: The existing `Diagnostics.tsx` page content overlaps with the Debug tab. In M10 it is refactored into the Debug tab; `Diagnostics.tsx` becomes a thin wrapper or redirect.

---

## R8 — Save Failure Handling (FR-027)

**Decision**: The `save_config()` Tauri command is split into two sub-operations:
1. **Local save** (AppConfig to disk) — synchronous; if this fails, the entire save is aborted with a clear error.
2. **Hub sync** (personality + LLM config → Redis) — async; if this fails, the local save is already committed but the hub sync failure is surfaced as a non-blocking warning: "Settings saved locally. Could not sync to hub: [reason]."

**Rationale**: The driver can still race with locally-saved config (PTT, audio devices). The hub sync failing is recoverable — it will sync on next save or hub restart. Making the entire save atomic (rollback local if hub fails) is unnecessarily strict for a local desktop app.

**UI behavior on failure**: FR-027 (retain unsaved form state + specific error + retry) applies to **local save failure** (disk full, permission error) — these are surfaced as blocking errors that prevent dismissal. Hub sync failures are surfaced as warnings that allow the driver to proceed.
