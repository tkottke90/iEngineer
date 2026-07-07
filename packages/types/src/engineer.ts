// Alert tiers (3 = LLM-synthesized Tier 3, M5)
export type AlertTier = 1 | 2 | 3;

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

// A queued rule-based alert, ready for TTS. Rule-based alerts are Tier 1 or 2
// only; Tier 3 (LLM-synthesized) uses QueuedTier3 below.
export interface QueuedAlert {
  tier: 1 | 2;
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

// Reference pushed to Tauri over the voice:audio pub/sub channel.
// Tier 1/2 clips carry `eventType`; Tier 3 (LLM-synthesized) clips carry
// `tier3Type` instead. COUPLING: the Rust `subscriber.rs` AudioClipRef struct
// must make `eventType` optional and add `tier3Type` to match (Phase E / Tauri).
export interface AudioClipRef {
  audioId: string; // UUID
  // RELATIVE path `/api/audio/${audioId}` — the Tauri subscriber prepends its
  // configured hub_url before fetching (the hub cannot know the host/port the
  // client reaches it by).
  clipUrl: string;
  tier: AlertTier;
  eventType?: AlertEventType; // Tier 1/2 only
  tier3Type?: Tier3Type; // Tier 3 only
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
// Five OCEAN-based traits, each an integer 1–5 with word-anchored levels
// (see specs/005-llm-push-to-talk/data-model.md). Supersedes the M4 chattiness field.
export type TraitLevel = 1 | 2 | 3 | 4 | 5;

export interface PersonalityConfig {
  openness: TraitLevel; // 1 Conventional → 5 Visionary
  warmth: TraitLevel; // 1 Detached → 5 Nurturing (brief "Familiarity")
  energy: TraitLevel; // 1 Tranquil → 5 Exuberant (brief "Chattiness"; 1 suppresses Tier 2/Tier 3 commentary)
  conscientiousness: TraitLevel; // 1 Spontaneous → 5 Meticulous
  assertiveness: TraitLevel; // 1 Deferential → 5 Commanding (brief "Aggression")
}

// OpenAI-compatible LLM endpoint config (runtime-switchable; no hard-coded provider — FR-006)
export interface LlmConfig {
  baseUrl: string;
  model: string;
  provider: 'openai-compatible' | 'anthropic';
  timeoutMs: number; // reachability/response ceiling → degradation (FR-023)
  maxResponseTokens: number; // response ceiling (FR-009)
  tokenBudget: number; // context ceiling (FR-012)
}

// Engineer service configuration (loaded from config/engineer-config.json)
export interface EngineerConfig {
  chatterboxUrl: string;
  chatterboxVoiceFile: string;
  fuelCriticalLapsRemaining: number;
  gapThresholdSeconds: number; // FR-015 M4 placeholder — gap rule returns null in M4
  audioIdleCleanupIntervalMs: number;
  // M5 additions
  llm: LlmConfig;
  personality: PersonalityConfig;
  deferenceThreshold: number; // default 2, per recommendation type (FR-021)
  queueDepthCap: number; // max pending PTT queries (Q4)
  postSectorMinLapGap: number; // post-sector commentary cadence, in laps
}

// ─── M5: Tier 3 LLM synthesis ────────────────────────────────────────────

export type Tier3Type = 'driver-query' | 'pit-entry' | 'safety-car' | 'post-sector';

export interface Tier3Message {
  tier: 3;
  type: Tier3Type;
  triggerSource: string; // queryId | event type
  text: string; // full synthesized text (also split per-sentence for TTS)
  personality: PersonalityConfig; // snapshot at synthesis time
  createdAtMs: number;
}

// Per-generation timing handle, shared (by reference) across every sentence clip
// produced by one LLM synthesis, so the dispatcher can report inference + audio
// timings when it publishes each clip. Mutable: `inferenceMs` stays null until the
// LLM call finishes — clips streamed mid-inference are published before it's known,
// which is itself a useful signal (time-to-first-audio < full inference time).
export interface GenerationTiming {
  genId: string;
  startedAt: number; // performance.now() when inference was triggered
  inferenceMs: number | null; // full LLM-call duration; null if published mid-stream
}

// A single per-sentence Tier 3 clip enqueued into the PriorityMessageQueue. The
// dispatcher turns it into TTS + an AudioClipRef, dispatched after all pending
// Tier 1/2 items (FR-015). Within Tier 3, driver-query outranks proactive commentary.
export interface QueuedTier3 {
  tier: 3;
  tier3Type: Tier3Type;
  messageText: string;
  sentenceIndex: number; // order within one synthesized message
  timing?: GenerationTiming; // perf timing for the generation this sentence belongs to
}

// Anything the PriorityMessageQueue can hold. Discriminated by `tier`.
export type QueuedMessage = QueuedAlert | QueuedTier3;

// Driver push-to-talk query (Tauri → hub over the engineer:query pub/sub channel)
export interface EngineerQuery {
  queryId: string; // uuid
  transcript: string; // non-empty (empty/non-speech never published — FR-004)
  sessionId: string;
  capturedAtMs: number; // epoch ms at PTT release
}

// Result returned by an LLM tool (get_fuel_status / get_tire_status)
export interface LlmToolResult {
  available: boolean;
  reason?: string; // when !available, e.g. "no flying lap yet" (FR-008)
  data?: Record<string, unknown>;
}

// Assembled reasoning context sent to the LLM (FR-011/012)
export interface ReasoningContext {
  raceState: Record<string, unknown>;
  memoryExcerpt: Record<string, unknown>;
  estimatedTokens: number;
  truncated: boolean; // true ⇒ context-truncated log emitted
}

// ─── M5: recommendation tracking, deference, session memory ──────────────

export type RecommendationOutcome = 'pending' | 'followed' | 'overridden';

export interface RecommendationLogEntry {
  recId: string;
  type: string; // M5: only 'pit'
  issuedAtMs: number;
  actionWindow: { recommendedLap: number }; // pit: the recommended lap (FR-019)
  outcome: RecommendationOutcome;
}

export interface DeferenceState {
  overrideCountByType: Record<string, number>;
  deferredTypes: string[]; // types now in information mode (FR-021)
}

export interface SessionMemory {
  sessionId: string;
  recommendations: RecommendationLogEntry[];
  fuelCalibration: Record<string, unknown> | null;
  deference: DeferenceState;
}

// ─── M5: Postgres audit (engineer_events) ────────────────────────────────

export type EngineerEventOutcome =
  | 'synthesized'
  | 'skipped-llm-unreachable'
  | 'skipped-empty'
  | 'error';

export interface EngineerEvent {
  id: string; // uuid
  sessionId: string;
  tier3Type: Tier3Type;
  prompt: string;
  response: string | null; // null if skipped/failed
  toolsCalled: string[];
  latencyMs: number | null;
  outcome: EngineerEventOutcome;
  createdAt: string; // ISO timestamp
}
