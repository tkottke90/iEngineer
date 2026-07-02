import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { RaceState, SessionMemory, RecommendationLogEntry } from '@iracing-engineer/types';
import { assembleContext } from '../../../src/engineer/context-assembler.js';
import { logger } from '../../../src/logger.js';

function captureInfo(fn: () => void): string[] {
  const logs: string[] = [];
  const orig = logger.info;
  (logger as unknown as { info: (m: string) => void }).info = (m: string) => logs.push(String(m));
  try {
    fn();
  } finally {
    (logger as unknown as { info: typeof logger.info }).info = orig;
  }
  return logs;
}

function raceState(): RaceState {
  return {
    session: { sessionPhase: 'Race', lapsRemaining: 20, flags: 0 },
    field: {},
    hero: {
      position: 4,
      lapDistPct: 0.512,
      fuelLevel: 18.4,
      tireCompound: 'soft',
      lastLapTime: 92.1,
      onPitRoad: false,
      fuelUsePerHour: 40,
      lapDeltaToBest: 0.3,
      gapToLeader: 12.4,
      waterTemp: 88,
      oilTemp: 95,
    },
    signals: { pitWindowOpen: true, safeWindowOpen: true },
  } as unknown as RaceState;
}

function memory(recCount: number): SessionMemory {
  const recommendations: RecommendationLogEntry[] = Array.from({ length: recCount }, (_, i) => ({
    recId: `r${i}`,
    type: 'pit',
    issuedAtMs: i,
    actionWindow: { recommendedLap: 10 + i },
    outcome: 'overridden',
  }));
  return {
    sessionId: 's1',
    recommendations,
    fuelCalibration: { burnRatePerLap: 2.6, samples: Array.from({ length: 50 }, (_, i) => i) },
    deference: { overrideCountByType: { pit: recCount }, deferredTypes: [] },
  };
}

describe('context-assembler — token budget + truncation (FR-012)', () => {
  it('does not truncate when under budget', () => {
    const ctx = assembleContext(raceState(), memory(2), 100_000);
    expect(ctx.truncated).to.be.false;
    expect((ctx.raceState as { hero: { position: number } }).hero.position).to.equal(4);
  });

  it('truncates over budget, preserves core, and logs', () => {
    let ctx!: ReturnType<typeof assembleContext>;
    const logs = captureInfo(() => {
      ctx = assembleContext(raceState(), memory(200), 200); // tiny budget forces drops
    });
    expect(ctx.truncated).to.be.true;
    // core survives
    const rs = ctx.raceState as { hero: { position: number }; session: { lapsRemaining: number } };
    expect(rs.hero.position).to.equal(4);
    expect(rs.session.lapsRemaining).to.equal(20);
    // recommendations were trimmed from 200
    const mem = ctx.memoryExcerpt as { recommendations: unknown[] };
    expect(mem.recommendations.length).to.be.lessThan(200);
    expect(logs.some((l) => l.includes('context truncated'))).to.be.true;
  });
});
