import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { GapModelEngine } from '../../../src/models/gap-model.js';
import type { CarState, SessionState } from '@iracing-engineer/types';

function makeField(positions: Array<{ carIdx: number; f2Time: number; lapDistPct?: number }>): Record<number, CarState> {
  const field: Record<number, CarState> = {};
  positions.forEach(({ carIdx, f2Time, lapDistPct = 0 }, i) => {
    field[carIdx] = {
      carIdx,
      driverName: `Driver ${carIdx}`,
      carNumber: String(carIdx),
      teamName: '',
      carClassId: 0,
      lapDistPct,
      trackSurface: 1,
      position: i + 1,
      classPosition: i + 1,
      lapCompleted: 5,
      lastLapTime: 90,
      bestLapTime: 89.5,
      estimatedLapTime: 90,
      gapToLeader: f2Time,
      onPitRoad: false,
      tireCompound: 'Soft',
      fastRepairsUsed: 0,
      pitEntryTime: null,
      pitExitTime: null,
      lastPitLap: null,
      lapsSinceLastPit: null,
      estimatedPitDuration: null,
    };
  });
  return field;
}

function makeSession(estimatedLapTime = 90): SessionState {
  return {
    sessionId: '1',
    trackName: 'Test',
    trackLengthMeters: 3700,
    sessionType: 'Race',
    sessionPhase: 'Racing',
    lapsTotal: 30,
    lapsRemaining: 20,
    timeRemaining: null,
    flags: 0,
    weather: { tempCelsius: 20, humidity: 0.5, windSpeedMs: 2, skies: 'Clear' },
    sessionStartWallClock: 0,
    estimatedLapTime,
  } as unknown as SessionState;
}

describe('GapModel', () => {
  let engine: GapModelEngine;

  beforeEach(() => {
    engine = new GapModelEngine();
  });

  it('FR-019: battleStatus is "battle" when gap ≤ 1.0s', () => {
    const field = makeField([
      { carIdx: 0, f2Time: 0 },
      { carIdx: 1, f2Time: 0.8 }, // 0.8s gap to leader
    ]);
    engine.update(field, makeSession());
    const snap = engine.getEntries();
    const entry = snap.find(e => e.leadCarIdx === 0 && e.trailCarIdx === 1);
    expect(entry?.battleStatus).to.equal('battle');
  });

  it('FR-019: battleStatus is "resolved" after 2+ consecutive checks with gap > 1.5s', () => {
    // First get into battle state
    let field = makeField([{ carIdx: 0, f2Time: 0 }, { carIdx: 1, f2Time: 0.8 }]);
    engine.update(field, makeSession());

    // Now widen gap beyond 1.5s for 2 ticks
    field = makeField([{ carIdx: 0, f2Time: 0 }, { carIdx: 1, f2Time: 1.6 }]);
    engine.update(field, makeSession());
    const after1 = engine.getEntries().find(e => e.leadCarIdx === 0 && e.trailCarIdx === 1);
    expect(after1?.battleStatus).to.not.equal('resolved'); // 1 tick not enough

    engine.update(field, makeSession());
    const after2 = engine.getEntries().find(e => e.leadCarIdx === 0 && e.trailCarIdx === 1);
    expect(after2?.battleStatus).to.equal('resolved');
  });

  it('FR-020: lapped-car gap (carIdxF2Time > 0.8 × estimatedLapTime) classified as "open" NOT "battle"; also when f2Time is negative', () => {
    const session = makeSession(90); // 0.8 * 90 = 72s
    // Positive lapped case
    let field = makeField([{ carIdx: 0, f2Time: 0 }, { carIdx: 1, f2Time: 75 }]);
    engine.update(field, session);
    const entry = engine.getEntries().find(e => e.leadCarIdx === 0 && e.trailCarIdx === 1);
    expect(entry?.battleStatus).to.equal('open');

    // Negative f2Time (car has lapped)
    const engine2 = new GapModelEngine();
    field = makeField([{ carIdx: 0, f2Time: 0 }, { carIdx: 1, f2Time: -5 }]);
    engine2.update(field, session);
    const entry2 = engine2.getEntries().find(e => e.leadCarIdx === 0 && e.trailCarIdx === 1);
    expect(entry2?.battleStatus).to.equal('open');
  });

  it('FR-019: gap:pulling_away event emitted when closingRate > +0.3 s/lap for 2+ ticks in battle/closing; battleStatus unchanged', () => {
    // Get into battle
    let field = makeField([{ carIdx: 0, f2Time: 0 }, { carIdx: 1, f2Time: 0.8 }]);
    engine.update(field, makeSession());

    // Gap increasing (lead pulling away) — 0.8 → 1.1 → 1.35 (closingRate ~-0.27 per check, meaning trail is falling back)
    // Actually closingRate > +0.3 means the gap is closing fast. But "pulling away" means leader pulling away = gap increasing.
    // Per contracts: gap:pulling_away when closingRate > +0.3 s/lap for 2+ ticks in battle/closing
    // Closing rate = (prevGap - currGap) / ticks; if positive = gap closing. Pulling away = gap increasing = closingRate negative
    // Wait — let me re-read: "closingRate > +0.3 s/lap" — gap:pulling_away fires when CLOSING rate is POSITIVE (trail closing)
    // Actually re-reading contracts: "gap:pulling_away: fires when closingRate > +0.3 s/lap for 2+ ticks in battle/closing"
    // This seems counter-intuitive but let's follow the spec exactly.
    // So: gap DECREASING at > 0.3s/lap for 2+ ticks while in battle → emit gap:pulling_away

    // Simulate: gap goes from 0.8 → 0.4 (closing fast)
    field = makeField([{ carIdx: 0, f2Time: 0 }, { carIdx: 1, f2Time: 0.4 }]);
    const result1 = engine.update(field, makeSession());
    // Still in battle, 1 tick of fast closing
    const entry1 = engine.getEntries().find(e => e.leadCarIdx === 0);
    expect(entry1?.battleStatus).to.equal('battle'); // unchanged

    field = makeField([{ carIdx: 0, f2Time: 0 }, { carIdx: 1, f2Time: 0.05 }]);
    const result2 = engine.update(field, makeSession());
    // 2nd tick of fast closing → pulling_away event
    const pullingAway = result2.events.some(e => e.type === 'gap:pulling_away');
    expect(pullingAway).to.be.true;
    // battleStatus still battle (not changed by pulling_away)
    const entry2 = engine.getEntries().find(e => e.leadCarIdx === 0);
    expect(entry2?.battleStatus).to.equal('battle');
  });
});
