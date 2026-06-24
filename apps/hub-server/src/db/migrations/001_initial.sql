CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   TEXT NOT NULL UNIQUE,
  track_name   TEXT NOT NULL,
  session_type TEXT NOT NULL,
  started_at   TIMESTAMPTZ,
  ended_at     TIMESTAMPTZ,
  duration_seconds INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stint_fuel_data (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT NOT NULL REFERENCES sessions(session_id),
  car_idx         INTEGER NOT NULL,
  stint_number    INTEGER NOT NULL,
  start_lap       INTEGER NOT NULL,
  end_lap         INTEGER NOT NULL,
  start_fuel      REAL NOT NULL,
  end_fuel        REAL NOT NULL,
  burn_rate_per_lap REAL NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tire_stint_data (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         TEXT NOT NULL REFERENCES sessions(session_id),
  car_idx            INTEGER NOT NULL,
  stint_number       INTEGER NOT NULL,
  compound           TEXT NOT NULL,
  start_lap          INTEGER NOT NULL,
  end_lap            INTEGER NOT NULL,
  degradation_signal TEXT NOT NULL CHECK (degradation_signal IN ('nominal', 'watch', 'critical')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   TEXT NOT NULL REFERENCES sessions(session_id),
  event_type   TEXT NOT NULL,
  session_time REAL NOT NULL,
  lap_number   INTEGER NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS event_log_session_id ON event_log(session_id);
CREATE INDEX IF NOT EXISTS event_log_event_type ON event_log(event_type);

CREATE TABLE IF NOT EXISTS engineer_decisions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          TEXT NOT NULL REFERENCES sessions(session_id),
  decision_type       TEXT NOT NULL,
  message_text        TEXT NOT NULL,
  tier                INTEGER NOT NULL CHECK (tier IN (0, 1, 2)),
  lap_number          INTEGER NOT NULL,
  session_time        REAL NOT NULL,
  driver_responded    BOOLEAN NOT NULL DEFAULT FALSE,
  driver_response     TEXT,
  outcome             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broadcast_plans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        TEXT NOT NULL,
  broadcast_type    TEXT NOT NULL CHECK (broadcast_type IN ('hero', 'general')),
  primary_subjects  JSONB NOT NULL DEFAULT '[]',
  dnf_behavior      TEXT NOT NULL CHECK (dnf_behavior IN ('end_broadcast', 'convert_to_general', 'continue_on_secondary')),
  production_style  JSONB NOT NULL DEFAULT '{}',
  pre_race_notes    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
