# Contract: `engineer_events` Postgres Audit

Satisfies Constitution III/V (LLM interactions logged to Postgres before acting) and closes the constitution's M5 follow-up TODO.

## Schema (`apps/hub-server/migrations/001_engineer_events.sql`)
```sql
CREATE TABLE IF NOT EXISTS engineer_events (
  id           UUID PRIMARY KEY,
  session_id   TEXT NOT NULL,
  tier3_type   TEXT NOT NULL,          -- driver-query | pit-entry | safety-car | post-sector
  prompt       TEXT NOT NULL,          -- full assembled prompt (system + context + task)
  response     TEXT,                   -- NULL when skipped/failed
  tools_called TEXT[] NOT NULL DEFAULT '{}',
  latency_ms   INTEGER,                -- LLM first-token→final, NULL when skipped
  outcome      TEXT NOT NULL,          -- synthesized | skipped-llm-unreachable | skipped-empty | error
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_engineer_events_session ON engineer_events (session_id, created_at);
```

## Write contract (`engineer-events.ts`)
- `recordEvent(partial): Promise<id>` — INSERT a provisional row **before** the LLM response is acted upon (before any clip is spoken). (FR-022)
- `finalizeEvent(id, { response, latencyMs, toolsCalled, outcome })` — UPDATE after synthesis/skip.
- On a DB write failure: emit a structured error log; the audit failure MUST NOT crash the engineer, but the interaction MUST NOT silently proceed unlogged — degrade to skip-with-log if the pre-write fails (fail-closed on audit). 
- Connection: `db/client.ts` pg `Pool` from env (`DATABASE_URL` or discrete vars). Migration run once on startup.

## Coverage (SC-008)
- Every LLM interaction (driver-query, pit-entry, safety-car, post-sector — synthesized or skipped) produces exactly one `engineer_events` row.
- Canned "reasoning unavailable" responses are recorded with `outcome = skipped-llm-unreachable`.
