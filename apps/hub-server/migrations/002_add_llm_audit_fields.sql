-- M10 T043 (FR-029, Constitution III & V): every Tier 3 synthesis row must
-- record which LLM served it. The M10 config UI makes the model runtime-
-- switchable (hub:config:llm), so the audit trail has to capture the value
-- resolved for each call — the static config is no longer authoritative.
-- Idempotent (IF NOT EXISTS) and tracked in _migrations by the startup runner.

ALTER TABLE engineer_events ADD COLUMN IF NOT EXISTS llm_model VARCHAR;
ALTER TABLE engineer_events ADD COLUMN IF NOT EXISTS llm_base_url VARCHAR;
