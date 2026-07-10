# Data Model: Tauri Client Configuration UI

**Date**: 2026-07-07 | **Feature**: specs/006-client-config-ui

---

## AppConfig (Tauri client — `state.rs`)

Extends the existing M4/M5 `AppConfig`. All fields persist to the Tauri app data directory as JSON.

```rust
pub struct AppConfig {
    // === Connection ===
    pub redis_url: String,           // default: "redis://localhost:6379"
    pub hub_url: String,             // default: "http://localhost:5173"
    pub connection_token: String,    // (existing, unused in M10 — intentionally not exposed in Connection tab UI; see FR-007 note)

    // === LLM (NEW in M10) ===
    pub llm_base_url: String,        // default: "https://lemonade.tdkottke.com/v1"
    pub llm_model: String,           // default: "user.Ornith-1.0-35B-GGUF"
    pub llm_api_key: String,         // default: "" (empty = no auth; stored locally only)

    // === Audio ===
    pub audio_input_device: Option<String>,
    pub audio_output_device: Option<String>,

    // === PTT ===
    pub ptt_hotkey: String,          // default: "" (empty = never configured; sentinel for first-run "No PTT key set" prompt — see T023/F4)

    // === Personality (M5 OCEAN traits) ===
    pub openness: u8,                // 1–5, default: 3
    pub warmth: u8,                  // 1–5, default: 3
    pub energy: u8,                  // 1–5, default: 3
    pub conscientiousness: u8,       // 1–5, default: 3
    pub assertiveness: u8,           // 1–5, default: 3

    // === Telemetry Logging (NEW in M10) ===
    pub telemetry_logging_enabled: bool,        // default: false
    pub telemetry_log_dir: String,              // sentinel default: "" — resolved to app_data_dir()/logs/telemetry at startup (Default::default() cannot call app_data_dir(); see T001)

    // === First-Launch UX (NEW in M10) ===
    pub first_launch_seen: bool,                // default: false — set to true after first successful Save; suppresses the first-launch LLM field hint (FR-007 Note C1, T020/F1)

    // === REMOVED in M10 (deprecated M4 stubs) ===
    // pub chattiness: String        ← removed; superseded by energy
    // pub familiarity: String       ← removed
    // pub aggression: String        ← removed

    // === NOT in AppConfig (fetched from Redis on demand) ===
    // VoiceProfile state (filename, uploadedAt, durationSeconds, status) is stored in
    // hub:config:voice-profile (Redis). The Voice tab reads it via get_voice_profile()
    // Tauri command on mount (see T036, T037). Local-First rule does not apply here
    // because the voice reference file lives on the hub side — if Redis is unreachable,
    // the Voice tab shows "Redis unreachable — profile status unavailable" (get_voice_profile() Err — I1).
}
```

**Validation rules**:
- `redis_url`, `hub_url`, `llm_base_url`: Must parse as a valid URL before save is allowed (FR-026).
- **MP3 magic byte sequences (D3 — shared reference)**: Valid MP3 files begin with one of: `FF FB`, `FF F3`, `FF F2` (raw MP3 frame sync), or `49 44 33` (ID3 header). Both T034 (hub second gate) and T036 (Tauri client first gate) MUST validate against this same set. The constant is defined once in this document to prevent the two implementations from diverging.
- `openness`, `warmth`, `energy`, `conscientiousness`, `assertiveness`: Clamped to 1–5; out-of-range values from corrupted config are silently clamped on load, logged once.
- `llm_api_key`: No format validation (any string, including empty). Never written to Redis or the hub — local only. Empty string `""` is the canonical "no auth" sentinel and is treated identically to a missing field at all call sites — `check_llm()` omits the auth header when `api_key` is `""`, and no code path distinguishes between absent and empty.
- `ptt_hotkey`: Non-empty string; validated by attempting `global_shortcut.register()`.
- `telemetry_log_dir`: Must be a writable directory path; validated at save time by attempting `std::fs::create_dir_all`.

---

## hub:config:llm (Redis KV — NEW)

Written by Tauri `save_config()` when any LLM field changes. Read by the hub `llm-client.ts` at the start of each LLM request.

**Redis key**: `hub:config:llm`
**Format**: JSON string

```json
{
  "baseUrl": "https://lemonade.tdkottke.com/v1",
  "model": "user.Ornith-1.0-35B-GGUF"
}
```

**Note**: `apiKey` is intentionally excluded from this Redis key — it stays in the Tauri client's local config and is passed to the hub via a separate secure channel if needed (out of scope for M10; Lemonade endpoint does not require auth). If the Claude API endpoint is configured, the API key flow is a M10+ follow-up.

**Absent key behavior**: Hub falls back to `engineer-config.json` defaults + emits one warning log (identical to the `hub:config:personality` pattern).

**Fallback source (I3)**: When `hub:config:llm` is absent from Redis, the hub reads LLM configuration from `apps/hub-server/config/engineer-config.json` → `llm` object: `{ "baseUrl": "https://lemonade.tdkottke.com/v1", "model": "user.Ornith-1.0-35B-GGUF" }`. This `llm` section MUST be present in `engineer-config.json` (added by T004) and included in the `EngineerConfig` TypeScript type. If this section is missing, the hub's fallback path is broken and Tier 3 synthesis will error on absent-key paths.

---

## VoiceProfile (runtime state — hub)

Not persisted to a dedicated table; the active profile is represented by the file on disk and the hub's in-memory `chatterboxVoiceFile` string.

**Two distinct types — do not conflate (F1)**:

```typescript
// VoiceProfileState — persisted (Redis hub:config:voice-profile); shown in Voice tab on mount via get_voice_profile()
// C4: status 'none' is NOT persisted — when no profile exists, the Redis key is simply absent.
// I1: get_voice_profile() returns Result<Option<VoiceProfileState>, String> — Ok(Some) = profile active;
// Ok(None) = Redis reachable, key absent (render "Default voice (no profile uploaded)");
// Err(reason) = Redis unreachable (render "Redis unreachable — profile status unavailable").
// The two non-profile states are DISTINCT and must not be collapsed into a single null.
interface VoiceProfileState {
  status: 'uploading' | 'active';  // 'none' is never stored — key absence = no profile
  filename: string;
  uploadedAt: string;          // ISO 8601
  durationSeconds: number;     // shown in Voice tab as "Uploaded: 15s" (F2)
}

// VoiceProfileResult — transient response from POST /api/voice-profile; NOT persisted
interface VoiceProfileResult {
  filename: string;
  uploadedAt: string;             // ISO 8601
  durationSeconds: number;
  testClipUrl: string;            // ephemeral; use test_audio_playback() for on-demand playback
}
```

`VoiceProfileResult` exists only in the immediate upload response. `testClipUrl` is NEVER stored in `AppConfig`, `VoiceProfileState`, or `hub:config:voice-profile`. After the upload response is consumed, `testClipUrl` is discarded.

- `VoiceProfileState` is written to `hub:config:voice-profile` (Redis KV) after successful upload so the hub survives restarts with the correct reference file.
- Tauri reads `hub:config:voice-profile` via `get_voice_profile()` on Voice tab mount to display the current profile name, timestamp, and duration.

**`hub:config:voice-profile` Redis schema (F3)**: The persisted JSON value includes `durationSeconds` so T036's `get_voice_profile()` can return it without re-reading the file from disk:

```json
{
  "filename": "profile-2026-07-07T12-00-00.mp3",
  "uploadedAt": "2026-07-07T12:00:00.000Z",
  "durationSeconds": 15
}
```

`durationSeconds` is written by T034's upload endpoint (sourced from `music-metadata`) alongside `filename` and `uploadedAt`. `testClipUrl` is NEVER stored here.

---

## TelemetryLogFrame (Tauri — NDJSON)

Each frame appended to the active log file when telemetry logging is enabled.

```typescript
interface TelemetryLogFrame {
  ts: number;           // Unix timestamp ms (Tauri system time)
  sessionId: string;
  fuel: number;         // FuelLevel (liters)
  lapDistPct: number;   // LapDistPct (0.0–1.0)
  lap: number;          // Lap (integer)
  speed: number;        // Speed (m/s)
  gear: number;         // Gear
  rpm: number;          // RPM
  throttle: number;     // Throttle (0.0–1.0)
  brake: number;        // Brake (0.0–1.0)
  latAccel: number;     // LatAccel (m/s²)
  lonAccel: number;     // LonAccel (m/s²)
}
```

**Note (I2)**: `lapTimeDelta` is intentionally absent from the log frame — it is a derived value (vs. personal best) shown only in the debug panel (see spec FR-019/F3). The log captures raw telemetry only; derived values are recomputed during analysis. Do not add it here without amending FR-019/F3.

**File naming**: `iracing-telemetry-{sessionId}-{YYYYMMDD-HHmmss}.ndjson` in `telemetry_log_dir`.

---

## DebugSnapshot (Tauri event — existing, extended)

Emitted by the Rust side to the frontend as a Tauri event `telemetry:debug-snapshot` at ~1 Hz while a session is active.

```typescript
interface DebugSnapshot {
  sessionActive: boolean;
  sessionId: string | null;
  // Fixed variable set (R3 — FR-016)
  fuelRemaining: number | null;      // liters
  currentLap: number | null;
  trackPosition: number | null;      // 0.0–1.0
  lapTimeDelta: number | null;       // seconds vs personal best
  // Infrastructure
  redisStreamLagMs: number | null;
  hubConnected: boolean | null;       // Wire type: Rust Option<bool> serializes None → JSON null; frontend maps null → display string "unknown" (I3 — do not use "unknown" as the interface type; null is the actual wire value at the Tauri IPC boundary)
  redisConnected: boolean;            // true if last Redis command on this connection succeeded; false on RedisError from the crate's connection pool
  whisperModelLoaded: boolean | null;  // Wire type: null = loading/pending, true = ready, false = load failed. Frontend maps: null → "Loading…", true → "Ready", false → "Load failed." (C2 — AtomicBool cannot represent failure; use Option<bool> in Rust: None → null, Some(true) → true, Some(false) → false)
}
```

**Lag threshold**: `redisStreamLagMs > 500` triggers the FR-018 warning indicator.

**`redisStreamLagMs` measurement formula**: `current_wall_clock_ms − oldest_pending_entry_timestamp_ms`, where `oldest_pending_entry_timestamp_ms` is the millisecond epoch embedded in the Redis Streams entry ID (format: `{ms}-{seq}`) of the oldest unacknowledged entry in the telemetry consumer group. Set to `null` when the consumer group has no unacknowledged entries (fully caught up) or when the Redis connection is unavailable.

**`hubConnected` Rust type (B3)**: Use `Option<bool>` in the Rust `DebugSnapshot` struct — serialize `None` as JSON `null` (always, not with `skip_serializing_if`). The TypeScript interface declares `hubConnected: boolean | null` to match the wire type. The frontend maps `null → "unknown"` (grey indicator), `true → "Connected"` (green), `false → "Disconnected"` (red). Do NOT declare `hubConnected: boolean | "unknown"` in the TypeScript interface — `"unknown"` is a display string, not the wire value, and using it as an interface type causes a TypeScript type error when Tauri IPC delivers `null`. T029 MUST perform this mapping explicitly: `const display = snapshot.hubConnected === null ? "unknown" : snapshot.hubConnected ? "Connected" : "Disconnected";`.

**`hubConnected` stale threshold semantics (B3)**: The transition from `true` to `false` is a hard boundary — hub is "connected" if `last_hub_probe_ok_ms` is within 10,000ms of the current wall clock; "disconnected" the instant it exceeds 10,000ms. There is no grace period or soft transition. The stale threshold is measured from the last probe that returned `Ok` (a successful HTTP response), NOT from the last probe attempt — probes skipped by the single-flight guard do not reset or extend the window.

---

## ConnectionTestResult

Returned by Tauri commands `check_redis()`, `check_hub()`, and the new `check_llm()`.

```typescript
interface ConnectionTestResult {
  service: 'redis' | 'hub' | 'llm';
  ok: boolean;
  latencyMs: number | null;
  error: string | null;   // human-readable reason on failure
}
```

---

## State Transitions: PTT Binding

```
Idle
  → [driver clicks "Set PTT Key"] → Listening
Listening
  → [keypress captured]          → Registering
  → [driver cancels]             → Idle
Registering
  → [register() succeeds]        → Bound(key)
  → [register() fails: conflict] → Error("Key already used by OS — try another")
  → [register() fails: perm]     → Error("Accessibility permission required — open System Preferences")
Bound(key)
  → [driver clicks "Set PTT Key"] → Listening (re-binding flow)
  → [key cleared]                → Idle
```

---

## State Transitions: Voice Profile

```
None
  → [driver selects file]         → Selected(file)
Selected(file)
  → [validation fails]            → Error(reason)
  → [driver confirms upload]      → Uploading
Uploading
  → [hub returns 200 + filename]  → Active(filename, uploadedAt)
  → [hub returns error]           → Error(reason)
Active(filename, uploadedAt)
  → [driver selects new file]     → Selected(newFile)
```
