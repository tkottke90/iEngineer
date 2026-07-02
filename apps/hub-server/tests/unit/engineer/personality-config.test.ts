import { describe, it } from 'mocha';
import { expect } from 'chai';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  QueuedAlert,
  AlertTier,
  AlertEventType,
  PersonalityConfig,
  TraitLevel,
} from '@iracing-engineer/types';
import {
  shouldSuppressAlert,
  parsePersonality,
  loadBlackoutZones,
} from '../../../src/engineer/personality-config.js';
import { logger } from '../../../src/logger.js';

function captureWarn(fn: () => void): string[] {
  const logs: string[] = [];
  const orig = logger.warn;
  (logger as unknown as { warn: (m: string) => void }).warn = (m: string) => logs.push(String(m));
  try {
    fn();
  } finally {
    (logger as unknown as { warn: typeof logger.warn }).warn = orig;
  }
  return logs;
}

function alert(tier: AlertTier, eventType: AlertEventType): QueuedAlert {
  return { tier, eventType, messageText: 'x', lapNumber: 1, sessionTime: 0, dedupKey: eventType };
}

function personality(energy: TraitLevel, over: Partial<PersonalityConfig> = {}): PersonalityConfig {
  return { openness: 3, warmth: 3, energy, conscientiousness: 3, assertiveness: 3, ...over };
}

const DEFAULTS: PersonalityConfig = personality(3);

describe('personality-config — shouldSuppressAlert (FR-017 Energy=1)', () => {
  it('Energy=1 suppresses Tier 2', () => {
    expect(shouldSuppressAlert(alert(2, 'hero:pit_window_open'), personality(1))).to.be.true;
  });
  it('Energy>=2 passes Tier 2', () => {
    expect(shouldSuppressAlert(alert(2, 'hero:pit_window_open'), personality(2))).to.be.false;
    expect(shouldSuppressAlert(alert(2, 'hero:pit_window_open'), personality(3))).to.be.false;
  });
  it('Tier 1 is never suppressed regardless of Energy', () => {
    expect(shouldSuppressAlert(alert(1, 'hero:fuel_critical'), personality(1))).to.be.false;
    expect(shouldSuppressAlert(alert(1, 'hero:blue_flag'), personality(1))).to.be.false;
  });
  it('suppression depends only on Energy (other traits cannot leak in)', () => {
    const a = alert(2, 'hero:pit_window_open');
    const withWarm = personality(3, { warmth: 5, assertiveness: 5 });
    expect(shouldSuppressAlert(a, withWarm)).to.be.false; // still passes — energy!=1
    const tranquil = personality(1, { warmth: 5, assertiveness: 5 });
    expect(shouldSuppressAlert(a, tranquil)).to.be.true; // suppressed — energy===1
  });
});

describe('personality-config — parsePersonality (M5 fallback)', () => {
  it('parses a valid five-trait JSON with no fallback', () => {
    const raw = JSON.stringify(personality(5, { warmth: 4 }));
    const { personality: p, usedFallback } = parsePersonality(raw, DEFAULTS);
    expect(usedFallback).to.be.false;
    expect(p.energy).to.equal(5);
    expect(p.warmth).to.equal(4);
  });
  it('falls back (with flag) when the key is absent', () => {
    const r1 = parsePersonality(null, DEFAULTS);
    const r2 = parsePersonality(undefined, DEFAULTS);
    expect(r1.usedFallback).to.be.true;
    expect(r1.personality).to.deep.equal(DEFAULTS);
    expect(r2.usedFallback).to.be.true;
  });
  it('falls back when JSON is malformed', () => {
    const { personality: p, usedFallback } = parsePersonality('{ not json', DEFAULTS);
    expect(usedFallback).to.be.true;
    expect(p).to.deep.equal(DEFAULTS);
  });
  it('falls back per-trait when a value is out of range or non-integer', () => {
    const raw = JSON.stringify({ openness: 9, warmth: 2, energy: 0, conscientiousness: 2.5, assertiveness: 4 });
    const { personality: p, usedFallback } = parsePersonality(raw, DEFAULTS);
    expect(usedFallback).to.be.true;
    expect(p.openness).to.equal(3); // 9 out of range → default
    expect(p.warmth).to.equal(2); // valid
    expect(p.energy).to.equal(3); // 0 out of range → default
    expect(p.conscientiousness).to.equal(3); // 2.5 non-integer → default
    expect(p.assertiveness).to.equal(4); // valid
  });
});

describe('personality-config — loadBlackoutZones (FR-010 fallback)', () => {
  it('returns [] and logs when file is missing', () => {
    let zones: unknown;
    const logs = captureWarn(() => {
      zones = loadBlackoutZones('/nonexistent/does-not-exist.json');
    });
    expect(zones).to.deep.equal([]);
    expect(logs.some((l) => l.includes('missing or invalid'))).to.be.true;
  });

  it('returns [] and logs when JSON is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zones-'));
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{ not valid json');
    try {
      let zones: unknown;
      const logs = captureWarn(() => {
        zones = loadBlackoutZones(path);
      });
      expect(zones).to.deep.equal([]);
      expect(logs.some((l) => l.includes('missing or invalid'))).to.be.true;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses valid zones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zones-'));
    const path = join(dir, 'good.json');
    writeFileSync(path, JSON.stringify({ zones: [{ lapDistPctStart: 0.4, lapDistPctEnd: 0.6 }] }));
    try {
      const zones = loadBlackoutZones(path);
      expect(zones).to.have.length(1);
      expect(zones[0].lapDistPctStart).to.equal(0.4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
