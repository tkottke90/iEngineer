# Phase 1 Data Model: Racing Engineer — LLM + Push-to-Talk

New/extended types live in `packages/types/src/engineer.ts` (Principle II). Shapes are illustrative; field names are the contract.

## Extended existing types

### AlertTier (extend)
```ts
export type AlertTier = 1 | 2 | 3;   // 3 = LLM-synthesized
```

### PersonalityConfig (replace M4 Chattiness model)
Five OCEAN-based traits, each integer `1–5` (default `3`). Supersedes the M4 `chattiness: 'Low'|'Default'` field.
```ts
export interface PersonalityConfig {
  openness: 1|2|3|4|5;          // Conventional → Visionary
  warmth: 1|2|3|4|5;            // Detached → Nurturing        (brief "Familiarity")
  energy: 1|2|3|4|5;            // Tranquil → Exuberant        (brief "Chattiness"; 1 = suppress T2/T3 commentary)
  conscientiousness: 1|2|3|4|5; // Spontaneous → Meticulous
  assertiveness: 1|2|3|4|5;     // Deferential → Commanding    (brief "Aggression")
}
```
- **Suppression rule**: `energy === 1` suppresses Tier 2 alerts (replacing `chattiness==='Low'`) and Tier 3 commentary.
- **Storage**: Redis KV `hub:config:personality` (JSON), written by Tauri on config save; defaults in `engineer-config.json`. Malformed/absent ⇒ all-3 default + warning log.

### EngineerConfig (extend)
```ts
export interface EngineerConfig {
  /* …existing M4 fields… */
  llm: {
    baseUrl: string;           // OpenAI-compatible endpoint (runtime-switchable)
    model: string;
    provider: 'openai-compatible' | 'anthropic';
    timeoutMs: number;         // reachability/response ceiling → degradation
    maxResponseTokens: number; // response ceiling (FR-009)
    tokenBudget: number;       // context ceiling (FR-012)
  };
  personality: PersonalityConfig;
  deferenceThreshold: number;  // default 2, per recommendation type
  queueDepthCap: number;       // max pending PTT queries
  postSectorMinLapGap: number; // commentary cadence bound (Energy-gated)
}
```

## New entities

### EngineerQuery  (Redis `engineer:query`, Tauri → hub)
```ts
export interface EngineerQuery {
  queryId: string;       // uuid
  transcript: string;    // non-empty (empty/non-speech never published)
  sessionId: string;
  capturedAtMs: number;  // Unix ms at PTT release
}
```

### Tier3Type / Tier3Message
```ts
export type Tier3Type = 'driver-query' | 'pit-entry' | 'safety-car' | 'post-sector';

export interface Tier3Message {
  tier: 3;
  type: Tier3Type;
  triggerSource: string;      // queryId | event type
  text: string;               // full synthesized text (also split for TTS)
  personality: PersonalityConfig; // snapshot at synthesis time
  createdAtMs: number;
}
```
Emitted to the driver as a **sequence** of per-sentence `AudioClipRef` (M4 type) on `voice:audio`.

### LlmToolResult
```ts
export interface LlmToolResult {
  available: boolean;
  reason?: string;            // when !available, e.g. "no flying lap yet"
  data?: Record<string, unknown>; // fuel: {lapsRemaining, level, burnRate}; tire: {wear, temps, ...}
}
```

### ReasoningContext
```ts
export interface ReasoningContext {
  raceState: Record<string, unknown>;   // truncated telemetry-derived summary
  memoryExcerpt: Record<string, unknown>;
  estimatedTokens: number;
  truncated: boolean;                    // true ⇒ context-truncated log emitted
}
```

**Truncation priority order** (FR-012) — when over `tokenBudget`, `context-assembler.ts` drops/summarizes in this fixed order (first = dropped first):
1. Post-sector commentary history
2. Older recommendation-log entries (keep the most recent N)
3. Fuel-calibration detail (keep a one-line summary)
4. Verbose per-corner / per-tire telemetry detail (keep aggregate summary)
5. **Never dropped**: current fuel summary, current tire summary, position, session/flag state, and (for a driver-query) the driver's question.
Each truncation pass emits a `context-truncated` structured log noting which categories were reduced.

### RecommendationLogEntry
```ts
export type RecommendationOutcome = 'pending' | 'followed' | 'overridden';

export interface RecommendationLogEntry {
  recId: string;
  type: string;               // e.g. 'pit'
  issuedAtMs: number;
  actionWindow: { recommendedLap: number }; // pit: the recommended lap
  outcome: RecommendationOutcome;
}
```
**State transitions (pit)**:
```
pending ──(car completes recommendedLap S/F without pit entry)──▶ overridden
pending ──(pit entry within window)───────────────────────────▶ followed
```
- On `overridden`: stop re-issuing this type within the same window context; frame around driver's decision (FR-019).
- Nth `overridden` for a type (N = `deferenceThreshold`, default 2) ⇒ deference mode for that type.

### SessionMemory
```ts
export interface SessionMemory {
  sessionId: string;
  recommendations: RecommendationLogEntry[];
  fuelCalibration: Record<string, unknown> | null; // latest M3 calibration snapshot
  deference: DeferenceState;
}
export interface DeferenceState {
  overrideCountByType: Record<string, number>;
  deferredTypes: string[];    // types now in information mode
}
```
- Per-session only (in-memory). Resets on new session (`deference` cleared).
- Consumed by `context-assembler.ts`; subject to token-budget truncation (oldest recommendations dropped first).

### EngineerEvent  (Postgres `engineer_events`, audit)
```ts
export interface EngineerEvent {
  id: string;                 // uuid
  sessionId: string;
  tier3Type: Tier3Type;
  prompt: string;             // full assembled prompt
  response: string | null;    // null if skipped/failed
  toolsCalled: string[];
  latencyMs: number | null;
  outcome: 'synthesized' | 'skipped-llm-unreachable' | 'skipped-empty' | 'error';
  createdAt: string;          // ISO timestamp
}
```
Written **before** acting on the response (FR-022, SC-008).

## Postgres schema (`migrations/001_engineer_events.sql`)
```sql
CREATE TABLE IF NOT EXISTS engineer_events (
  id           UUID PRIMARY KEY,
  session_id   TEXT NOT NULL,
  tier3_type   TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  response     TEXT,
  tools_called TEXT[] NOT NULL DEFAULT '{}',
  latency_ms   INTEGER,
  outcome      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_engineer_events_session ON engineer_events (session_id, created_at);
```

## Relationships
- `EngineerQuery` (driver-query) → one `Tier3Message` → many `AudioClipRef` (per sentence) → one `EngineerEvent`.
- Proactive triggers (`hub:events`) → `Tier3Message` (same downstream).
- `RecommendationLogEntry` outcomes update `DeferenceState`; both live in `SessionMemory`, surfaced via `ReasoningContext`.
- `PersonalityConfig` snapshot embedded in each `Tier3Message` and influences the prompt in each `EngineerEvent`.
