// Alert tiers
export type AlertTier = 1 | 2;

// Canonical alert type keys (subset of EventType that PRODUCE an alert).
// NOTE: signal-only events (hero:pit_exit, hero:blue_flag_cleared,
// session:safety_car_cleared) are NOT alert producers — they are consumed as
// dedup-clear signals and live in EventType (events.ts), not here.
export type AlertEventType =
  | 'hero:fuel_critical'
  | 'hero:blue_flag'
  | 'session:safety_car_deployed'
  | 'hero:pit_limiter_active'
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
  messageText: string; // pre-rendered string, e.g. "Fuel critical — 2 laps remaining"
  lapNumber: number;
  sessionTime: number;
  // Two strategies (FR-006): per-lap alerts (hero:fuel_critical) →
  // `${eventType}:${lapNumber}`; event-cleared alerts (blue flag, safety car,
  // pit limiter, pit window) → `${eventType}` (no lap number; reset via recordCleared).
  dedupKey: string;
  // enqueuedAt is stamped by the queue on Tier 2 alerts for the 30s no-safe-window drop (FR-017).
  enqueuedAt?: number;
}

// Reference pushed to Tauri over the voice:audio pub/sub channel
export interface AudioClipRef {
  audioId: string; // UUID
  // RELATIVE path `/api/audio/${audioId}` — the Tauri subscriber prepends its
  // configured hub_url before fetching (the hub cannot know the host/port the
  // client reaches it by).
  clipUrl: string;
  tier: AlertTier;
  eventType: AlertEventType;
  generatedAt: number; // epoch ms — same instant as AudioStore storedAt
}

// Failure log payload (emitted to structured console log)
export interface EngineerFailureLog {
  msg: string; // always "[engineer] TTS failure"
  alertType: AlertEventType;
  tier: AlertTier;
  lapNumber: number;
  failureReason: string;
  timestamp: number; // epoch ms
}

// Radio blackout zone (from static config)
export interface RadioBlackoutZone {
  lapDistPctStart: number; // 0.0–1.0
  lapDistPctEnd: number; // 0.0–1.0, must be > lapDistPctStart
  label?: string; // optional human-readable name; not required by FR-010 config format
}

// Personality configuration (driver preference)
export type Chattiness = 'Low' | 'Default';

export interface PersonalityConfig {
  chattiness: Chattiness;
  familiarity: 'Default'; // M5 placeholder — no effect in M4 (FR-012)
  aggression: 'Default'; // M5 placeholder — no effect in M4 (FR-012)
}

// Engineer service configuration (loaded from config/engineer-config.json)
export interface EngineerConfig {
  chatterboxUrl: string;
  chatterboxVoiceFile: string;
  fuelCriticalLapsRemaining: number;
  gapThresholdSeconds: number; // FR-015 M4 placeholder — gap rule returns null in M4
  audioIdleCleanupIntervalMs: number;
}
