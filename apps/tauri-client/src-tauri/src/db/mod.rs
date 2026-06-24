use anyhow::Result;
use rusqlite::Connection;

pub fn open_or_create(path: &str) -> Result<Connection> {
    let conn = Connection::open(path)?;
    run_migrations(&conn)?;
    Ok(conn)
}

pub fn run_migrations(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audio_devices (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    direction  TEXT NOT NULL CHECK(direction IN ('input', 'output')),
    is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS blackout_zones (
    id         TEXT PRIMARY KEY,
    track_name TEXT NOT NULL,
    start_pct  REAL NOT NULL,
    end_pct    REAL NOT NULL,
    label      TEXT NOT NULL DEFAULT ''
);
"#;
