# Contract: Tauri Commands — Client Config UI

**Purpose**: Define the new and extended Tauri commands for M10. All commands are invoked from the Preact frontend via `invoke()`. Existing M4/M5 commands (`get_config`, `save_config`, `list_audio_devices`, `check_redis`, `check_hub`, `test_audio_playback`) are extended — their signatures are noted where they change.

---

## Extended: `save_config(config: AppConfig) → Result<(), String>`

**Change from M5**: Writes `hub:config:llm` to Redis in addition to the existing `hub:config:personality` write. Also writes `hub:config:voice-profile` reference filename if the active profile has changed.

```rust
// Writes hub:config:llm = { baseUrl, model } (NOT apiKey — local only)
// Writes hub:config:personality = { openness, warmth, energy, conscientiousness, assertiveness }
// Both writes are best-effort (spawned task); local save returns immediately
```

**On local save failure** (disk error): Returns `Err(String)` with a human-readable reason. The frontend retains the unsaved form state (FR-027).

**On hub sync failure** (Redis unreachable): Returns `Ok(())` with a `warning` field in the response envelope so the frontend can surface a non-blocking warning.

---

## Extended: `set_audio_device(device_name: String, device_type: String) → Result<(), String>`

**Change from M5**: Was a no-op stub. Now:
1. Validates `device_type` is `"input"` or `"output"`.
2. Checks the named device exists in the current `cpal` device list.
3. Signals the running `AudioCapture` or `AudioPlayback` task to switch devices (via a tokio watch channel).
4. Persists the selection to `AppConfig`.

**Returns**: `Ok(())` on success, `Err("device not found: {name}")` (interpolating the requested device name) if the name doesn't match any device, `Err("invalid device type")` for bad `device_type`. (I5 — aligned with T011's interpolated form.)

---

## New: `bind_ptt_hotkey() → Result<String, String>`

**Purpose**: Enter "listening" mode — registers a one-shot global keypress listener, captures the next non-modifier keypress, registers it as the PTT hotkey, and returns the captured key name.

**Flow**:
1. Temporarily registers a catch-all listener via `tauri-plugin-global-shortcut`.
2. Waits for the first non-modifier keypress (timeout: 10 seconds).
3. Unregisters the catch-all.
4. Calls `register(capturedKey, ptt_handler)`.
5. On success: persists to `AppConfig.ptt_hotkey` AND saves the config immediately (auto-save — see T022/C5; no Save-button press required), then returns `Ok(key_name)`. This auto-save does NOT set `first_launch_seen` (T022/A2 — the first-launch LLM hint is suppressed only by an explicit Save-button save).
5a. If registration succeeds but the auto-save fails (disk error): still returns `Ok(key_name)` — the binding is active for the current session and is NOT rolled back; emits a `ptt:save-failed` Tauri event + structured warn `{ event: "ptt-save-failed", reason }`. The frontend shows a dismissable warning ("binding will revert on restart"); persistence recovers on the next explicit Save (T022/U2).
6. On timeout: returns `Err("ptt:timeout")`.
7. On register failure (OS key conflict): returns `Err("ptt:key-conflict")`.
8. On permission denied (macOS Accessibility): returns `Err("ptt:accessibility-denied")`.
9. Precondition: if invoked while a PTT capture is physically in progress (the PTT key is held down), returns `Err("ptt:capture-in-progress")` immediately without entering listening mode (T022/U2).

**Error code contract (I1 — updated 2026-07-08)**: All error returns are structured codes — `ptt:timeout`, `ptt:key-conflict`, `ptt:accessibility-denied`, `ptt:capture-in-progress` — NOT human-readable strings. The frontend (T023) owns the mapping from each code to its user-facing message and any associated actions (e.g., the macOS "Open Accessibility Settings" button). T022 (implementation), T023 (UI mapping), and T024 (tests) MUST all use exactly these codes; update this list and all three tasks together if a code is ever added or changed.

**Frontend contract**: The Hotkeys tab shows a "listening..." indicator while this command is awaited, then displays the captured key or the mapped error message.

---

## New: `check_llm(base_url: String, model: String, api_key: String) → Result<ConnectionTestResult, String>`

**Purpose**: Test connectivity to the configured LLM endpoint. Makes a minimal non-inference API call — `GET {base_url}/models` ONLY, never a completions call (A1/FR-008-D3: any completions/inference-endpoint call counts as synthesis regardless of token count and would void this command's Constitution V audit-gate exemption) — and returns latency.

```typescript
interface ConnectionTestResult {
  service: 'llm';
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}
```

**On success**: Returns `Ok({ ok: true, latencyMs: N, error: null })`.
**On failure**: Returns `Ok({ ok: false, latencyMs: null, error: <enum string> })` where `error` is one of the exact strings below (T019/A1 error enum, written here 2026-07-08 per T019/D2's contract-first gate — the UI displays these verbatim):

- `"connection refused"` — TCP connect failed
- `"timeout after 5s"` — no response within the 5-second budget
- `"HTTP 401 — check API key"` — auth failure
- `"HTTP 404 — verify base URL and model path"` — endpoint or model path not found
- `"HTTP {status} — unexpected response"` — any other non-2xx HTTP status
- `"invalid URL"` — malformed `base_url`

---

## New: `upload_voice_profile(file_path: String) → Result<VoiceProfileResult, String>`

**Purpose**: Read an MP3 from the local filesystem and POST it to the hub `POST /api/voice-profile`.

**Input**: `file_path` — absolute path on the local filesystem to the MP3 file the driver selected.

**Flow**:
1. Reads file bytes from `file_path`.
2. Validates file header is MPEG (magic bytes `FF FB` or `FF F3` or `FF F2` or `49 44 33`).
3. POSTs as `multipart/form-data` with field `audio` to `{hub_url}/api/voice-profile`, with a **90-second client-side timeout** (hub processing budget is 50s per T034/C4b; SC-006's 60s is the user-side budget; the 90s client timeout covers hub budget plus network transfer margin — see T036/I3).
4. Returns the hub's response.

```typescript
interface VoiceProfileResult {
  filename: string;       // server-assigned filename (e.g., "profile-2026-07-07.mp3")
  uploadedAt: string;     // ISO 8601
  durationSeconds: number;
  testClipUrl: string;    // URL to a short test clip using the new voice
}
```

**On format error** (not MP3): Returns `Err("File must be an MP3")` before upload.
**On hub error**: Returns `Err(hub_error_message)`.
**On timeout** (90s elapsed with no hub response): Returns `Err("Upload timed out — hub did not respond within 90s")`. (I6 — matches T036/T038's timeout test.)

---

## New: `get_voice_profile() → Result<Option<VoiceProfileState>, String>`

**Purpose**: Read the active voice profile state from Redis `hub:config:voice-profile` for display in the Voice tab (called on tab mount — voice profile state is intentionally NOT stored in `AppConfig`; see T037/E4).

```typescript
interface VoiceProfileState {
  status: 'uploading' | 'active';   // 'none' is never stored — key absence = no profile
  filename: string;
  uploadedAt: string;               // ISO 8601
  durationSeconds: number;
}
```

**Returns (I1 — three distinct states, do NOT collapse)**:
- `Ok(Some(state))` — profile exists; Voice tab shows filename + timestamp + duration.
- `Ok(None)` — Redis reachable but the key is absent (no profile uploaded); Voice tab shows "Default voice (no profile uploaded)" (FR-024).
- `Err(reason)` — Redis unreachable; Voice tab shows "Redis unreachable — profile status unavailable" and emits a structured warn `{ event: "voice-profile-read-failed", reason }`. (Renamed from an earlier "Hub offline" draft — the failing dependency is Redis, not the hub process.)

---

## New: `toggle_telemetry_logging(enabled: bool) → Result<(), String>`

**Purpose**: Enable or disable raw telemetry frame logging.

**Flow**:
- `enabled: true`: Starts a new log file in `AppConfig.telemetry_log_dir` for the current session (or on next session start if no session is active). Returns `Ok(())` immediately; logging begins asynchronously.
- `enabled: false`: Signals the log writer to stop after the current write (graceful — no partial frames). Returns `Ok(())`.
- Persists `AppConfig.telemetry_logging_enabled`.

**On disk-full** (while logging): The log writer emits a `telemetry:log-warning` Tauri event with `{ reason: "disk-full" }`; logging stops automatically. The Racing Engineer path is unaffected.

---

## Extended: `get_debug_snapshot() → Result<DebugSnapshot, String>`

**Purpose**: Return the current debug snapshot on demand (for initial page load). Subsequent updates arrive via the `telemetry:debug-snapshot` Tauri event at ~1 Hz.

See `data-model.md` for the `DebugSnapshot` type.
