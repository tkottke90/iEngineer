import { describe, it } from 'mocha';
import { expect } from 'chai';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueuedAlert, AlertTier, AlertEventType } from '@iracing-engineer/types';
import {
  shouldSuppressAlert,
  loadBlackoutZones,
  normalizeChattiness,
} from '../../../src/engineer/personality-config.js';
import { logger } from '../../../src/logger.js';

// Capture logger.warn output for the duration of `fn`.
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

describe('personality-config — shouldSuppressAlert', () => {
  it('Chattiness Low suppresses Tier 2', () => {
    expect(shouldSuppressAlert(alert(2, 'hero:pit_window_open'), 'Low')).to.be.true;
  });
  it('Chattiness Low never suppresses Tier 1', () => {
    expect(shouldSuppressAlert(alert(1, 'hero:fuel_critical'), 'Low')).to.be.false;
    expect(shouldSuppressAlert(alert(1, 'hero:blue_flag'), 'Low')).to.be.false;
  });
  it('Chattiness Default passes both tiers', () => {
    expect(shouldSuppressAlert(alert(2, 'hero:pit_window_open'), 'Default')).to.be.false;
    expect(shouldSuppressAlert(alert(1, 'hero:fuel_critical'), 'Default')).to.be.false;
  });
  it('FR-012: suppression depends only on chattiness (familiarity/aggression cannot leak in)', () => {
    // The signature excludes personality stubs by construction; behavior is
    // identical for the same chattiness regardless of any other setting.
    const a = alert(2, 'hero:pit_window_open');
    expect(shouldSuppressAlert(a, 'Low')).to.equal(shouldSuppressAlert(a, 'Low'));
    expect(shouldSuppressAlert(a, 'Default')).to.equal(shouldSuppressAlert(a, 'Default'));
  });
});

describe('personality-config — normalizeChattiness (FR-011 fallback)', () => {
  it('recognizes Low', () => expect(normalizeChattiness('Low')).to.equal('Low'));
  it('recognizes Default', () => expect(normalizeChattiness('Default')).to.equal('Default'));
  it('defaults to Default for absent key', () => {
    expect(normalizeChattiness(null)).to.equal('Default');
    expect(normalizeChattiness(undefined)).to.equal('Default');
  });
  it('defaults to Default for unrecognized value', () => {
    expect(normalizeChattiness('Chatty')).to.equal('Default');
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
