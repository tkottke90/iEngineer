import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from './logger.js';

// Load the nearest `.env` by walking up from the current working directory. The
// hub may be started from apps/hub-server (`npm start`) or the repo root, and the
// canonical `.env` lives at the repo root — this finds it either way. Existing
// process.env values are NOT overwritten (an explicit export wins). Best-effort:
// a missing/unreadable file just means we rely on the ambient environment.
function loadNearestEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      try {
        (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(candidate);
        logger.info('[hub] Loaded environment', { file: candidate });
      } catch (err) {
        logger.warn('[hub] Failed to load .env — relying on ambient environment', {
          file: candidate,
          error: String(err),
        });
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  logger.warn('[hub] No .env found — relying on ambient environment (DATABASE_URL, REDIS_URL, …)');
}

loadNearestEnv();
