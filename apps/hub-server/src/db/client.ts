import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import type { Pool } from 'pg';
import { logger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// migrations/ lives at apps/hub-server/migrations, two levels up from src/db/
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

// Anchor the pool on globalThis so Vite dev SSR module duplication still shares a
// single pool (mirrors audio-store.ts). Connection comes from DATABASE_URL, else
// pg's discrete PG* env-var defaults.
const GLOBAL_KEY = Symbol.for('iracing-engineer.pg-pool');
type GlobalWithPool = typeof globalThis & { [GLOBAL_KEY]?: Pool | null };

export function getPool(): Pool {
  const g = globalThis as GlobalWithPool;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new pg.Pool(
      process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {},
    );
  }
  return g[GLOBAL_KEY]!;
}

export async function closePool(): Promise<void> {
  const g = globalThis as GlobalWithPool;
  if (g[GLOBAL_KEY]) {
    await g[GLOBAL_KEY]!.end();
    g[GLOBAL_KEY] = null;
  }
}

/**
 * Apply migrations/*.sql idempotently on startup. Each file runs at most once
 * (tracked in a `_migrations` table); the migration SQL also uses IF NOT EXISTS
 * as a belt-and-suspenders guard. Returns the filenames applied this call.
 * `pool` and `dir` are overridable for tests.
 */
export async function runMigrations(pool: Pool = getPool(), dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const { rowCount } = await pool.query('SELECT 1 FROM _migrations WHERE filename = $1', [file]);
    if (rowCount && rowCount > 0) continue;
    const sql = readFileSync(join(dir, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
      logger.info('[hub] Applied migration', { file });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('[hub] Migration failed', { file, error: String(err) });
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}
