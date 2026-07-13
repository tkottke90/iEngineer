// T2-04/T2-05 gap alert monitor (007 US2, FR-004–FR-007): hysteresis state
// machine over the hero-adjacent same-class gaps, evaluated per dispatch tick.
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import type {
  RaceState,
  CarState,
  HeroState,
  EngineerConfig,
  QueuedAlert,
} from '@iracing-engineer/types';
import { GapAlertMonitor } from '../../../src/engineer/gap-alert-monitor.js';
import { logger } from '../../../src/logger.js';

const CONFIG = {
  gapThresholdSeconds: 2.0,
  gapHysteresisMarginSeconds: 0.5,
  relevantPositionRange: 3,
} as EngineerConfig;

function car(over: Partial<CarState>): CarState {
  return {
    carIdx: 0,
    driverName: 'D',
    carNumber: '0',
    teamName: '',
    carClassId: 100,
    lapDistPct: 0.1,
    trackSurface: 3,
    position: 1,
    classPosition: 1,
    lapCompleted: 12,
    lastLapTime: 90,
    bestLapTime: 89,
    estimatedLapTime: 90,
    gapToLeader: 0,
    onPitRoad: false,
    tireCompound: '',
    fastRepairsUsed: 0,
    pitEntryTime: null,
    pitExitTime: null,
    lastPitLap: null,
    lapsSinceLastPit: null,
    estimatedPitDuration: null,
    ...over,
  };
}

interface Rig {
  state: RaceState;
  enqueued: QueuedAlert[];
  monitor: GapAlertMonitor;
  /** Position the car ahead `g` seconds up the road. */
  setGapAhead: (g: number) => void;
  /** Position the car behind `g` seconds back. */
  setGapBehind: (g: number) => void;
  tick: () => void;
}

// Hero P5 (carIdx 0, gapToLeader 50s); ahead = P4 (carIdx 1, "11");
// behind = P6 (carIdx 2, "22").
function rig(): Rig {
  const hero = car({
    carIdx: 0,
    carNumber: '42',
    position: 5,
    classPosition: 5,
    gapToLeader: 50,
    lapCompleted: 12,
  }) as HeroState;
  const ahead = car({ carIdx: 1, carNumber: '11', position: 4, classPosition: 4, gapToLeader: 40 });
  const behind = car({ carIdx: 2, carNumber: '22', position: 6, classPosition: 6, gapToLeader: 60 });
  const state: RaceState = {
    session: { sessionPhase: 'Racing' } as RaceState['session'],
    field: { 0: hero, 1: ahead, 2: behind },
    hero,
    signals: { safeWindowOpen: true, cutWindowOpen: false, activeBattles: [], pitWindowOpen: false },
  };
  const enqueued: QueuedAlert[] = [];
  const monitor = new GapAlertMonitor(CONFIG, () => state, (a) => enqueued.push(a));
  return {
    state,
    enqueued,
    monitor,
    setGapAhead: (g) => {
      state.field[1].gapToLeader = hero.gapToLeader - g;
    },
    setGapBehind: (g) => {
      state.field[2].gapToLeader = hero.gapToLeader + g;
    },
    tick: () => monitor.tick(),
  };
}

interface CapturedLog {
  msg: string;
  meta: Record<string, unknown> | undefined;
}

describe('GapAlertMonitor — hysteresis state machine (US2)', () => {
  let logs: CapturedLog[];
  let origInfo: typeof logger.info;
  beforeEach(() => {
    logs = [];
    origInfo = logger.info;
    (logger as unknown as { info: (m: string, meta?: Record<string, unknown>) => void }).info = (
      m,
      meta,
    ) => logs.push({ msg: m, meta });
  });
  afterEach(() => {
    (logger as unknown as { info: typeof logger.info }).info = origInfo;
  });

  const suppressedLogs = () => logs.filter((l) => l.meta?.event === 'gap_alert_suppressed');

  it('FR-004: crossing below T fires closing-ahead with the exact template and metadata', () => {
    const r = rig();
    r.setGapAhead(3.0); // ≥ T → arms
    r.tick();
    expect(r.enqueued).to.have.length(0);
    r.setGapAhead(1.84); // crossing
    r.tick();
    expect(r.enqueued).to.have.length(1);
    const a = r.enqueued[0];
    expect(a.messageText).to.equal('Gap closing — 1.8 seconds to the car ahead');
    expect(a.eventType).to.equal('gap:closing');
    expect(a.tier).to.equal(2);
    expect(a.lapNumber).to.equal(12); // hero.lapCompleted (gap events publish lapNumber 0 — R6)
  });

  it('FR-004: crossing below T fires closing-behind with the defending wording', () => {
    const r = rig();
    r.setGapBehind(3.0);
    r.tick();
    r.setGapBehind(1.5);
    r.tick();
    expect(r.enqueued).to.have.length(1);
    expect(r.enqueued[0].messageText).to.equal('Car behind closing — gap 1.5 seconds');
    expect(r.enqueued[0].eventType).to.equal('gap:closing');
  });

  it('FR-004: fresh slot starts disarmed — a gap already under T fires nothing until seen ≥ T', () => {
    const r = rig();
    r.setGapAhead(1.2); // green flag: already close
    r.tick();
    r.tick();
    expect(r.enqueued).to.have.length(0); // no closing alert
    r.setGapAhead(2.5); // first observation ≥ T — arms
    r.tick();
    r.setGapAhead(1.9); // real crossing
    r.tick();
    expect(r.enqueued).to.have.length(1);
  });

  it('FR-005: widening fires only above T+M and only after a prior closing fire', () => {
    const r = rig();
    // Initial wide gap arms closing but must NOT produce a breaking-away alert.
    r.setGapAhead(5.0);
    r.tick();
    expect(r.enqueued).to.have.length(0);
    // Close in → closing fires (hero chasing).
    r.setGapAhead(1.5);
    r.tick();
    expect(r.enqueued).to.have.length(1);
    // Open past T+M → losing-touch confirmation (hero behind).
    r.setGapAhead(2.6);
    r.tick();
    expect(r.enqueued).to.have.length(2);
    expect(r.enqueued[1].messageText).to.equal('Losing touch — gap 2.6 seconds to the car ahead');
    expect(r.enqueued[1].eventType).to.equal('gap:pulling_away');
  });

  it('FR-005: pulling-away wording for the behind direction (hero ahead)', () => {
    const r = rig();
    r.setGapBehind(3.0);
    r.tick();
    r.setGapBehind(1.5);
    r.tick(); // closing fired
    r.setGapBehind(2.75);
    r.tick(); // widening past T+M
    expect(r.enqueued).to.have.length(2);
    expect(r.enqueued[1].messageText).to.equal("Gap 2.8 seconds — you're pulling away");
  });

  it("FR-005: an initial gap under T that widens past T+M without a closing fire stays silent", () => {
    const r = rig();
    r.setGapAhead(1.5); // first sight under T — disarmed
    r.tick();
    r.setGapAhead(3.5); // opens past T+M with no closing fire in between
    r.tick();
    r.tick();
    expect(r.enqueued).to.have.length(0);
  });

  it('FR-006: dead-band oscillation (T…T+M) fires nothing in either direction', () => {
    const r = rig();
    r.setGapAhead(3.0);
    r.tick(); // armed
    r.setGapAhead(1.8);
    r.tick(); // closing fired
    expect(r.enqueued).to.have.length(1);
    for (const g of [2.1, 2.4, 2.05, 2.45, 2.2]) {
      r.setGapAhead(g);
      r.tick();
    }
    expect(r.enqueued).to.have.length(1); // dead band: no widening, no re-closing
  });

  it('FR-006: opposite-boundary re-arm permits a second closing alert', () => {
    const r = rig();
    r.setGapAhead(3.0);
    r.tick();
    r.setGapAhead(1.8);
    r.tick(); // closing #1
    r.setGapAhead(2.6);
    r.tick(); // widening fires, closing re-arms
    r.setGapAhead(1.9);
    r.tick(); // closing #2
    expect(r.enqueued).to.have.length(3);
    expect(r.enqueued[2].eventType).to.equal('gap:closing');
  });

  it('adjacency change (different carIdx) resets the slot to disarmed', () => {
    const r = rig();
    r.setGapAhead(3.0);
    r.tick(); // armed for carIdx 1
    // Overtake: a different car is now P4, already close.
    r.state.field[3] = car({
      carIdx: 3,
      carNumber: '33',
      position: 4,
      classPosition: 4,
      gapToLeader: r.state.hero!.gapToLeader - 1.5,
    });
    r.state.field[1].position = 3; // old ahead car moved up
    r.tick();
    r.tick();
    expect(r.enqueued).to.have.length(0); // fresh slot: under-T gap must first be seen ≥ T
  });

  it('FR-007: cross-class adjacent car is a standing non-battle — no evaluation, no per-tick log', () => {
    const r = rig();
    r.state.field[1].carClassId = 200; // different class ahead
    r.setGapAhead(3.0);
    r.tick();
    r.setGapAhead(1.5);
    r.tick();
    expect(r.enqueued).to.have.length(0);
    expect(suppressedLogs()).to.have.length(0); // reset silently, never logged per tick
  });

  it('FR-007: degenerate class data falls back to evaluating (same as pit relevance)', () => {
    const r = rig();
    r.state.field[1].carClassId = 0; // invalid class data — skip the class check
    r.state.field[1].classPosition = 0;
    r.setGapAhead(3.0);
    r.tick();
    r.setGapAhead(1.5);
    r.tick();
    expect(r.enqueued).to.have.length(1); // still a battle candidate
  });

  it('null RaceState.hero resets both slots silently (pre-session)', () => {
    const r = rig();
    r.setGapAhead(3.0);
    r.tick(); // armed
    r.state.hero = null;
    r.tick(); // reset, no crash, no log
    r.state.hero = r.state.field[0] as HeroState;
    r.setGapAhead(1.5); // was armed before the reset — must NOT fire now
    r.tick();
    expect(r.enqueued).to.have.length(0);
    expect(suppressedLogs()).to.have.length(0);
  });

  it('invalid gaps reset silently: ≤ 0, non-finite, lapped-scale (0.8 × estimatedLapTime)', () => {
    const r = rig();
    // Arm, then feed invalid gaps — each resets the slot.
    for (const g of [0, -1.2, Number.NaN, 80]) {
      r.setGapAhead(3.0);
      r.tick(); // arm
      r.setGapAhead(g); // invalid (80 > 0.8 × 90 = 72 → lapped-scale)
      r.tick();
      r.setGapAhead(1.5); // would fire if the slot survived
      r.tick();
      expect(r.enqueued, `gap ${g} must reset the slot`).to.have.length(0);
      r.setGapAhead(3.0); // restore for next round
      r.tick();
    }
  });

  it('lapped-scale falls back to 72s when estimatedLapTime is unavailable', () => {
    const r = rig();
    r.state.hero!.estimatedLapTime = 0;
    r.setGapAhead(3.0);
    r.tick(); // arm
    r.setGapAhead(71); // < 72 fallback: valid (huge but not lapped by the rule)
    r.tick();
    r.setGapAhead(73); // > 72 → lapped-scale, resets
    r.tick();
    r.setGapAhead(1.5);
    r.tick();
    expect(r.enqueued).to.have.length(0);
  });

  for (const [label, applySuppression] of [
    ['caution', (s: RaceState) => ((s.session as { sessionPhase: string }).sessionPhase = 'Caution')],
    ['hero-on-pit-road', (s: RaceState) => (s.hero!.onPitRoad = true)],
    ['adjacent-on-pit-road', (s: RaceState) => (s.field[1].onPitRoad = true)],
  ] as const) {
    it(`FR-007: ${label} — would-fire crossing logs gap_alert_suppressed instead of enqueueing`, () => {
      const r = rig();
      r.setGapAhead(3.0);
      r.tick(); // armed while racing
      applySuppression(r.state);
      r.setGapAhead(1.5); // would-fire crossing during suppression
      r.tick();
      r.tick(); // hysteresis bounds log volume — never per tick
      expect(r.enqueued).to.have.length(0);
      const sup = suppressedLogs();
      expect(sup).to.have.length(1);
      expect(sup[0].meta!.direction).to.equal('ahead');
      expect(sup[0].meta!.reason).to.equal(label);
    });
  }

  it('FR-007: slot resets to disarmed when the suppression clears — no alert burst at restart', () => {
    const r = rig();
    r.setGapAhead(3.0);
    r.tick(); // armed
    (r.state.session as { sessionPhase: string }).sessionPhase = 'Caution';
    r.setGapAhead(1.5);
    r.tick(); // suppressed would-fire (logged), transitions applied
    (r.state.session as { sessionPhase: string }).sessionPhase = 'Racing';
    r.tick(); // suppression cleared → slot resets to disarmed
    r.setGapAhead(1.2); // still under T after restart
    r.tick();
    expect(r.enqueued).to.have.length(0); // fresh ≥ T observation required first
    r.setGapAhead(3.0);
    r.tick();
    r.setGapAhead(1.5);
    r.tick();
    expect(r.enqueued).to.have.length(1); // normal operation resumes
  });
});
