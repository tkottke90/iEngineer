# Data Model: Rule-Based Alerts + Voice

**Feature**: 004-rule-based-alerts-voice  
**Date**: 2026-06-30

---

## New Types in `packages/types`

### `src/engineer.ts` (new file)

```typescript
// Alert tiers
export type AlertTier = 1 | 2;

// Canonical alert type keys (subset of EventType)
export type AlertEventType =
  | 'hero:fuel_critical'
  | 'hero:blue_flag'
  | 'session:safety_car_deployed'
  | 'hero:pit_limiter_active'   // new event type — added to EventType
  | 'hero:pit_window_open'
  | 'competitor:pit_entry'
  | 'competitor:pit_exit'
  | 'gap:closing'
  | 'gap:pulling_away'
  | 'hero:pace_degradation';

// A queued alert, ready for TTS
export interface QueuedAlert {
  tier: AlertTier;
  eventType: AlertEventType;
  messageText: string;          // pre-rendered string, e.g. "Fuel critical — 2 laps remaining"
  lapNumber: number;
  sessionTime: number;
  dedupKey: string;             // two strategies (FR-006): per-lap alerts (hero:fuel_critical) → `${eventType}:${lapNumber}`; event-cleared alerts (blue flag, safety car, pit limiter, pit window) → `${eventType}` (no lap number; reset via recordCleared)
}

// Reference pushed to Tauri over pub/sub
export interface AudioClipRef {
  audioId: string;              // UUID
  clipUrl: string;              // RELATIVE path `/api/audio/${audioId}` — Tauri subscriber (T024) prepends its configured hub_url before fetching
  tier: AlertTier;
  eventType: AlertEventType;
  generatedAt: number;          // epoch ms
}

// Failure log payload (emitted to structured console log)
export interface EngineerFailureLog {
  msg: string;                  // always "[engineer] TTS failure"
  alertType: AlertEventType;
  tier: AlertTier;
  lapNumber: number;
  failureReason: string;
  timestamp: number;            // epoch ms
}

// Radio blackout zone (from static config)
export interface RadioBlackoutZone {
  lapDistPctStart: number;      // 0.0–1.0
  lapDistPctEnd: number;        // 0.0–1.0, must be > lapDistPctStart
  label?: string;               // optional human-readable name (e.g. "T1 Complex"); not required by FR-010 config format
}

// Personality configuration (driver preference)
export type Chattiness = 'Low' | 'Default';

export interface PersonalityConfig {
  chattiness: Chattiness;
  familiarity: 'Default';       // placeholder — no effect in M4
  aggression: 'Default';        // placeholder — no effect in M4
}
```

---

## Extended Types

### `packages/types/src/events.ts` — add one EventType

```typescript
// Add to EventType union (per T002):
| 'hero:pit_limiter_active'      // limiter-off signal reuses this type with payload.active === false
| 'hero:blue_flag_cleared'       // dedup-clear signal for hero:blue_flag
```

### `apps/tauri-client/src-tauri/src/state.rs` — extend AppConfig

```rust
pub struct AppConfig {
  // ... existing fields (incl. ptt_hotkey: String, default "F13") ...
  pub chattiness: String,            // "Low" | "Default", default "Default"
  pub familiarity: String,           // M5 stub, default "Default" (FR-012)
  pub aggression: String,            // M5 stub, default "Default" (FR-012)
}
```

### `apps/hub-server/config/radio-blackout-zones.json` (new file)

```json
{
  "zones": []
}
```

Empty by default — driver configures zones for their tracks.

### `apps/hub-server/config/engineer-config.json` (new file)

```json
{
  "fuelCriticalLapsRemaining": 1.0,
  "gapThresholdSeconds": 2.0,
  "chatterboxUrl": "http://10.0.0.12:8004",
  "chatterboxVoiceFile": "voice2.wav",
  "audioIdleCleanupIntervalMs": 30000
}
```

Note: `paceDegradationPctThreshold` / `paceDegradationRollingLaps` are NOT included — pace degradation config is deferred to M5 (YAGNI, FR-015). `gapThresholdSeconds` is an M4 placeholder only (the gap rule returns null in M4). Clip TTL is NOT config — it is the module constant `AUDIO_CLIP_TTL_MS = 60_000` in `audio-store.ts` (T018).

---

## Deduplication State (in-process, hub-server)

```typescript
// Internal to DedupTracker — not persisted
// The Map holds a marker for every alert key that has already fired.
// Presence of the key = "already fired, suppress"; absence = "may fire".
type DedupMap = Map<string, true>;
```

Two key strategies (per FR-006 / T011), selected by a `PER_LAP_ALERTS = new Set(['hero:fuel_critical'])` constant:

- **Per-lap alerts** (`hero:fuel_critical`): key is `${eventType}:${lapNumber}`. A new lap yields a new key, so the alert re-enables automatically each lap. No explicit clear call.
- **Event-cleared alerts** (`hero:blue_flag`, `session:safety_car_deployed`, `hero:pit_limiter_active`, `hero:pit_window_open`): key is `${eventType}` (no lap number). Fires once, stays suppressed across laps until `recordCleared(eventType)` deletes the key.

Lifecycle:
- `shouldFire(eventType, lapNumber)`: compute key per strategy; return `!map.has(key)`
- `recordFired(eventType, lapNumber)`: `map.set(key, true)`
- `recordCleared(eventType)`: delete every entry whose key starts with `eventType` (clears both `eventType` and any `eventType:lap` variants)

Clearing events: blue flag → `hero:blue_flag_cleared`; safety car → `session:safety_car_cleared`; pit limiter → `hero:pit_limiter_active` with `payload.active === false`; pit window → `hero:pit_exit`.

---

## Audio Clip Store (in-process, hub-server)

```typescript
// Internal to AudioStore — not persisted to Redis
interface AudioClipEntry {
  buffer: Buffer;
  storedAt: number;             // epoch ms — same Date.now() value used for AudioClipRef.generatedAt (T018)
}

// Map key: audioId (UUID)
type AudioClipMap = Map<string, AudioClipEntry>;
```

Lifecycle:
- Created on successful TTS generation
- Retrievable via `GET /api/audio/:audioId` — the clip is NOT deleted on fetch (no GETDEL); it stays available so a client can re-fetch after a brief disconnect and so deep queues still resolve
- Evicted only by the TTL cleanup interval: an entry is removed once `Date.now() - storedAt > AUDIO_CLIP_TTL_MS` (60_000, module constant in `audio-store.ts`, T018)

---

## Redis Pub/Sub Channel

| Channel | Publisher | Subscriber | Message Schema |
|---------|-----------|------------|----------------|
| `voice:audio` | hub-server `RacingEngineerService` | Tauri `engineer::subscriber` | `AudioClipRef` (JSON) |

---

## Source File Layout

```text
apps/hub-server/src/
├── engineer/
│   ├── racing-engineer.ts       # Top-level service, event bus subscriber
│   ├── alert-rules.ts           # Tier 1 + Tier 2 rule evaluators
│   ├── dedup-tracker.ts         # DedupMap management
│   ├── message-queue.ts         # Priority queue with safe-window gate
│   ├── tts-client.ts            # Chatterbox HTTP client
│   ├── audio-store.ts           # In-memory clip map + HTTP endpoint handler
│   └── personality-config.ts    # Config loader + Chattiness filter
├── config/
│   ├── radio-blackout-zones.json
│   └── engineer-config.json

apps/tauri-client/src-tauri/src/
├── engineer/
│   ├── mod.rs
│   ├── subscriber.rs            # Redis pub/sub listener for voice:audio
│   └── playback_queue.rs        # Sequential no-interrupt playback queue

packages/types/src/
└── engineer.ts                  # New shared types (above)

packages/ui/src/components/
└── AudioDeviceTestPanel/
    └── index.tsx                # Mic meter, PTT test, playback test button

apps/tauri-client/src/pages/
└── Setup.tsx                    # Add AudioDeviceTestPanel section
```
