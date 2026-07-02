import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  EngineerConfig,
  RadioBlackoutZone,
  QueuedAlert,
  Chattiness,
} from '@iracing-engineer/types';
import { logger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// config/ lives at apps/hub-server/config/, two levels up from src/engineer/
const CONFIG_DIR = join(__dirname, '..', '..', 'config');

/**
 * Load the engineer configuration (thresholds, Chatterbox URL, voice file).
 */
export function loadEngineerConfig(path = join(CONFIG_DIR, 'engineer-config.json')): EngineerConfig {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as EngineerConfig;
}

/**
 * Load radio blackout zones from static config. Per FR-010, if the file is
 * missing or the JSON is malformed, treat the entire lap as a safe window
 * (return []) and emit a structured warning. The path is overridable for tests.
 */
export function loadBlackoutZones(
  path = join(CONFIG_DIR, 'radio-blackout-zones.json'),
): RadioBlackoutZone[] {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as { zones?: RadioBlackoutZone[] };
    if (!Array.isArray(parsed.zones)) throw new Error('missing zones array');
    return parsed.zones;
  } catch {
    logger.warn('[engineer] radio-blackout-zones.json missing or invalid — treating entire lap as safe window');
    return [];
  }
}

/**
 * Normalize a raw Chattiness value read from Redis. Per FR-011, an absent,
 * unrecognized, or unreadable value falls back to "Default". This is the pure
 * decision function; the once-per-startup warning log lives in the dispatcher
 * (T037) which owns the `_chattinessWarnEmitted` guard.
 */
export function normalizeChattiness(raw: string | null | undefined): Chattiness {
  return raw === 'Low' ? 'Low' : 'Default';
}

/**
 * Chattiness suppression filter. Applied by the dispatcher at DEQUEUE time
 * (T037) — NOT wired into the enqueue path. Chattiness=Low suppresses Tier 2
 * alerts only; Tier 1 alerts are never suppressed. Note the signature depends
 * ONLY on chattiness — familiarity/aggression cannot affect dispatch (FR-012).
 */
export function shouldSuppressAlert(alert: QueuedAlert, chattiness: Chattiness): boolean {
  return chattiness === 'Low' && alert.tier === 2;
}
