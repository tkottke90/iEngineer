-- M5 engineer_events audit table (FR-022, SC-008).
-- One row per LLM interaction, written BEFORE the engineer acts on the response.
-- Satisfies the constitution's Principle V LLM audit gate (v1.2.0).

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
