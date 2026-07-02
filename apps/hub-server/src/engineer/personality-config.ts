import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  EngineerConfig,
  RadioBlackoutZone,
  QueuedAlert,
  PersonalityConfig,
  TraitLevel,
} from '@iracing-engineer/types';
import { logger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// config/ lives at apps/hub-server/config/, two levels up from src/engineer/
const CONFIG_DIR = join(__dirname, '..', '..', 'config');

/**
 * Load the engineer configuration (thresholds, Chatterbox URL, voice file, LLM
 * settings, personality defaults).
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

export interface PersonalityLoadResult {
  personality: PersonalityConfig;
  /** true if the raw value was absent/malformed or any trait was out of range and
   *  the fallback (config default) was substituted — the caller warns once. */
  usedFallback: boolean;
}

/**
 * Parse the five-trait PersonalityConfig from the raw `hub:config:personality`
 * Redis value. Per FR-017/M5, an absent, malformed, or out-of-range value falls
 * back to the config default (per trait). This is the pure decision function;
 * the once-per-startup warning log lives in the dispatcher (which owns the
 * `_personalityWarnEmitted` guard). Supersedes the M4 normalizeChattiness path.
 */
export function parsePersonality(
  raw: string | null | undefined,
  fallback: PersonalityConfig,
): PersonalityLoadResult {
  if (raw === null || raw === undefined || raw === '') {
    return { personality: fallback, usedFallback: true };
  }
  let parsed: Partial<PersonalityConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<PersonalityConfig>;
  } catch {
    return { personality: fallback, usedFallback: true };
  }
  let usedFallback = false;
  const trait = (v: unknown, d: TraitLevel): TraitLevel => {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5) return v as TraitLevel;
    usedFallback = true;
    return d;
  };
  const personality: PersonalityConfig = {
    openness: trait(parsed.openness, fallback.openness),
    warmth: trait(parsed.warmth, fallback.warmth),
    energy: trait(parsed.energy, fallback.energy),
    conscientiousness: trait(parsed.conscientiousness, fallback.conscientiousness),
    assertiveness: trait(parsed.assertiveness, fallback.assertiveness),
  };
  return { personality, usedFallback };
}

/**
 * Alert suppression filter, applied by the dispatcher at DEQUEUE time. Per FR-017,
 * Energy at level 1 (Tranquil) suppresses Tier 2 alerts (superseding the M4
 * Chattiness=Low behavior). Tier 1 alerts are never suppressed. Tier 3 commentary
 * suppression at Energy=1 is enforced separately in the synthesizer.
 */
export function shouldSuppressAlert(alert: QueuedAlert, personality: PersonalityConfig): boolean {
  return personality.energy === 1 && alert.tier === 2;
}
