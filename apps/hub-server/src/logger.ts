import { mkdirSync } from 'node:fs';
import { configureFromSchema } from '@tkottke90/logger';

// Log directory (relative to the process cwd — apps/hub-server in dev). Ensure
// it exists so the winston file transports can open their streams.
const LOG_DIR = 'logs';
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // best-effort; winston will surface a clearer error if the dir is unwritable
}

/**
 * Shared hub-server logger (@tkottke90/logger over winston).
 *
 * - Console transport: human-readable (`<time> [LEVEL] <label> <message> {meta}`).
 * - File transports: JSON Lines — `logs/hub.jsonl` (all levels) and
 *   `logs/hub.error.jsonl` (errors only).
 *
 * Convention: keep the `[hub]` / `[engineer]` prefix in the message string and
 * pass structured fields as the second argument, e.g.
 *   logger.info('[engineer] Alert enqueued', { alertType, tier, lapNumber })
 *
 * NOTE: do not use createChildLogger — it recurses infinitely in the current
 * package version (2.3.1).
 */
export const logger = configureFromSchema('hub-server', {
  level: process.env.LOG_LEVEL ?? 'info',
  console: { enabled: true },
  file: {
    log: { filename: `${LOG_DIR}/hub.jsonl` },
    error: { filename: `${LOG_DIR}/hub.error.jsonl` },
  },
});
