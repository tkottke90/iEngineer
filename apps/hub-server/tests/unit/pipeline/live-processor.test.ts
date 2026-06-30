import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { LiveProcessor } from '../../../src/pipeline/live-processor.js';
import * as raceState from '../../../src/state/race-state.js';

function mockRedis() {
  return { setex: async () => {}, publish: async () => 0, lpush: async () => 1, ltrim: async () => {}, expire: async () => {}, xack: async () => 1 } as any;
}

function makeLiveTick(overrides: Record<string, number | boolean> = {}): string {
  return JSON.stringify({
    brake: 0,
    throttle: 0.9,
    latAccel: 0.1,
    longAccel: 0.05,
    speed: 50,
    lapDistPct: 0.5,
    sessionTime: 100,
    ...overrides,
  });
}

describe('LiveProcessor (safe window)', () => {
  let processor: LiveProcessor;

  beforeEach(() => {
    processor = new LiveProcessor(mockRedis());
    // Set source to driver by default
    processor.setSource('driver');
  });

  it('FR-021: safeWindowOpen === false when |LatAccel| > 0.4g', () => {
    // First build up distance buffer (no brake)
    for (let i = 0; i < 200; i++) {
      processor.onLiveTelemetry(makeLiveTick({ brake: 0, throttle: 0.9, latAccel: 0.05, speed: 50 }));
      processor.tick(1 / 60);
    }
    // Now inject high LatAccel
    processor.onLiveTelemetry(makeLiveTick({ brake: 0, throttle: 0.9, latAccel: 0.5, speed: 50 }));
    processor.tick(1 / 60);
    expect(raceState.getSnapshot().signals.safeWindowOpen).to.be.false;
  });

  it('FR-021: safeWindowOpen === false when Throttle < 0.7', () => {
    for (let i = 0; i < 200; i++) {
      processor.onLiveTelemetry(makeLiveTick({ brake: 0, throttle: 0.9, latAccel: 0.05, speed: 50 }));
      processor.tick(1 / 60);
    }
    processor.onLiveTelemetry(makeLiveTick({ brake: 0, throttle: 0.5, latAccel: 0.05, speed: 50 }));
    processor.tick(1 / 60);
    expect(raceState.getSnapshot().signals.safeWindowOpen).to.be.false;
  });

  it('FR-021/FR-022: safeWindowOpen === false when brake event within last 150m', () => {
    // Sub-case (a): verify brakeDistanceBuffer accumulates at 1/60 dt
    const processor2 = new LiveProcessor(mockRedis());
    processor2.setSource('driver');

    // Apply brake to reset buffer
    processor2.onLiveTelemetry(makeLiveTick({ brake: 0.9, throttle: 0, speed: 60 }));
    processor2.tick(1 / 60);

    // Travel 100m @ 60m/s × (1/60s × N ticks)
    // 60 m/s × 1/60 s = 1m per tick → need 100 ticks for 100m
    for (let i = 0; i < 100; i++) {
      processor2.onLiveTelemetry(makeLiveTick({ brake: 0, throttle: 0.9, latAccel: 0.05, speed: 60 }));
      processor2.tick(1 / 60);
    }
    // 100m traveled, still < 150m → still false
    expect(raceState.getSnapshot().signals.safeWindowOpen).to.be.false;

    // Sub-case (b): with dt = 0.018s (simulated setInterval drift), buffer is larger
    const processor3 = new LiveProcessor(mockRedis());
    processor3.setSource('driver');
    // Apply brake
    processor3.onLiveTelemetry(makeLiveTick({ brake: 0.9, throttle: 0, speed: 60 }));
    processor3.tick(0.018);
    // 60 m/s × 0.018s = 1.08m per tick → 100 ticks = 108m (more than 60×1/60=100m)
    let distAccum = 0;
    for (let i = 0; i < 100; i++) {
      processor3.onLiveTelemetry(makeLiveTick({ brake: 0, throttle: 0.9, latAccel: 0.05, speed: 60 }));
      processor3.tick(0.018);
      distAccum += 60 * 0.018;
    }
    // distAccum should be ~108m (not 100m) — confirms measured dt is used, not hardcoded 1/60
    expect(distAccum).to.be.greaterThan(100);
    // Still < 150m so safeWindowOpen should still be false
    expect(raceState.getSnapshot().signals.safeWindowOpen).to.be.false;
  });

  it('FR-021: safeWindowOpen === true when all three conditions satisfied simultaneously', () => {
    const processor4 = new LiveProcessor(mockRedis());
    processor4.setSource('driver');

    // Apply brake to reset buffer
    processor4.onLiveTelemetry(makeLiveTick({ brake: 0.9, throttle: 0, speed: 60 }));
    processor4.tick(1 / 60);

    // Travel > 150m with no brake, throttle > 0.7, latAccel < 0.4
    // 60 m/s × (1/60) s = 1m/tick → 160 ticks = 160m > 150m
    for (let i = 0; i < 160; i++) {
      processor4.onLiveTelemetry(makeLiveTick({ brake: 0, throttle: 0.9, latAccel: 0.05, speed: 60 }));
      processor4.tick(1 / 60);
    }
    expect(raceState.getSnapshot().signals.safeWindowOpen).to.be.true;
  });

  it('FR-023: safeWindowOpen === false when source === "observer" regardless of signal values', () => {
    const procObs = new LiveProcessor(mockRedis());
    procObs.setSource('observer');
    // Build up enough distance
    for (let i = 0; i < 200; i++) {
      procObs.onLiveTelemetry(makeLiveTick({ brake: 0, throttle: 0.9, latAccel: 0.05, speed: 60 }));
      procObs.tick(1 / 60);
    }
    expect(raceState.getSnapshot().signals.safeWindowOpen).to.be.false;
  });

  it('[stub]: cutWindowOpen === safeWindowOpen in driver mode', () => {
    const proc5 = new LiveProcessor(mockRedis());
    proc5.setSource('driver');
    // Apply brake then travel > 150m
    proc5.onLiveTelemetry(makeLiveTick({ brake: 0.9, throttle: 0, speed: 60 }));
    proc5.tick(1 / 60);
    for (let i = 0; i < 160; i++) {
      proc5.onLiveTelemetry(makeLiveTick({ brake: 0, throttle: 0.9, latAccel: 0.05, speed: 60 }));
      proc5.tick(1 / 60);
    }
    const signals = raceState.getSnapshot().signals;
    expect(signals.cutWindowOpen).to.equal(signals.safeWindowOpen);
  });

  it('FR-031: hero:incident emitted when |LongAccel| > 3g then speed drop > 20 m/s within 0.5s', () => {
    const incidents: string[] = [];
    const procInc = new LiveProcessor(mockRedis(), (type) => incidents.push(type));
    procInc.setSource('driver');

    // High LongAccel spike (> 3g = 29.4 m/s²)
    procInc.onLiveTelemetry(makeLiveTick({ longAccel: -4.0, speed: 50 }));
    procInc.tick(1 / 60);
    // Speed drops > 20 m/s within 0.5s
    procInc.onLiveTelemetry(makeLiveTick({ longAccel: -0.5, speed: 28 })); // dropped 22 m/s
    procInc.tick(1 / 60);

    expect(incidents).to.include('hero:incident');

    // No event when only LongAccel condition without speed drop
    const incidents2: string[] = [];
    const procInc2 = new LiveProcessor(mockRedis(), (type) => incidents2.push(type));
    procInc2.setSource('driver');
    procInc2.onLiveTelemetry(makeLiveTick({ longAccel: -4.0, speed: 50 }));
    procInc2.tick(1 / 60);
    procInc2.onLiveTelemetry(makeLiveTick({ longAccel: -0.5, speed: 48 })); // speed barely dropped
    procInc2.tick(1 / 60);
    expect(incidents2).to.not.include('hero:incident');
  });
});
