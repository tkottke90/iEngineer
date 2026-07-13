import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import type {
  RaceEvent,
  RaceState,
  CarState,
  HeroState,
  DerivedSignals,
  EngineerConfig,
  EventType,
} from '@iracing-engineer/types';
import { evaluateTier1, evaluateTier2 } from '../../../src/engineer/alert-rules.js';
import { logger } from '../../../src/logger.js';

const CONFIG: EngineerConfig = {
  chatterboxUrl: 'http://x',
  chatterboxVoiceFile: 'v.wav',
  fuelCriticalLapsRemaining: 1.0,
  gapThresholdSeconds: 2.0,
  relevantPositionRange: 3,
  gapHysteresisMarginSeconds: 0.5,
  audioIdleCleanupIntervalMs: 30000,
} as EngineerConfig;

const SIGNALS: DerivedSignals = {
  safeWindowOpen: true,
  cutWindowOpen: false,
  activeBattles: [],
  pitWindowOpen: true,
};

/** Minimal CarState for relevance/identity tests — only the fields the rules read. */
function car(over: Partial<CarState>): CarState {
  return {
    carIdx: 0,
    driverName: 'D',
    carNumber: '0',
    teamName: '',
    carClassId: 100,
    lapDistPct: 0,
    trackSurface: 3,
    position: 1,
    classPosition: 1,
    lapCompleted: 5,
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

function state(over: Partial<RaceState> = {}): RaceState {
  const hero = car({ carIdx: 0, carNumber: '42', position: 8, classPosition: 8 }) as HeroState;
  return {
    session: { sessionPhase: 'Racing' } as RaceState['session'],
    field: { 0: hero },
    hero,
    signals: SIGNALS,
    ...over,
  };
}

function ev(type: EventType, payload: Record<string, unknown> = {}, lapNumber = 5): RaceEvent {
  return { type, sessionId: 's1', sessionTime: 100, lapNumber, lapDistPct: 0.5, payload };
}

describe('alert-rules Tier 1', () => {
  it('T1-01: fires fuel critical below configurable threshold', () => {
    const alert = evaluateTier1(ev('hero:fuel_critical', { lapsRemaining: 0.8 }), CONFIG);
    expect(alert).to.not.be.null;
    expect(alert!.tier).to.equal(1);
    expect(alert!.eventType).to.equal('hero:fuel_critical');
  });

  it('T1-01: uses config threshold (fires at 1.5 when threshold is 2, not hardcoded)', () => {
    const cfg = { ...CONFIG, fuelCriticalLapsRemaining: 2 };
    expect(evaluateTier1(ev('hero:fuel_critical', { lapsRemaining: 1.5 }), cfg)).to.not.be.null;
    expect(evaluateTier1(ev('hero:fuel_critical', { lapsRemaining: 2.5 }), cfg)).to.be.null;
  });

  it('T1-01: null guard when lapsRemaining is null/undefined/non-finite', () => {
    expect(evaluateTier1(ev('hero:fuel_critical', { lapsRemaining: null }), CONFIG)).to.be.null;
    expect(evaluateTier1(ev('hero:fuel_critical', {}), CONFIG)).to.be.null;
    expect(evaluateTier1(ev('hero:fuel_critical', { lapsRemaining: Infinity }), CONFIG)).to.be.null;
  });

  it('T1-01: spoken text matches canonical template', () => {
    const alert = evaluateTier1(ev('hero:fuel_critical', { lapsRemaining: 0.84 }), CONFIG);
    expect(alert!.messageText).to.equal('Fuel critical — 0.8 laps remaining');
  });

  it('T1-02: blue flag', () => {
    const a = evaluateTier1(ev('hero:blue_flag'), CONFIG);
    expect(a!.messageText).to.equal('Blue flag — let them by');
  });

  it('T1-03: safety car deployed', () => {
    const a = evaluateTier1(ev('session:safety_car_deployed'), CONFIG);
    expect(a!.messageText).to.equal('Safety car deployed — hold position');
  });

  it('T1-04: pit limiter active only when payload.active === true', () => {
    expect(
      evaluateTier1(ev('hero:pit_limiter_active', { active: true }), CONFIG)!.messageText,
    ).to.equal('Pit limiter active');
    expect(evaluateTier1(ev('hero:pit_limiter_active', { active: false }), CONFIG)).to.be.null;
  });
});

describe('alert-rules Tier 2', () => {
  it('T2-01: fires pit window open when signal is true', () => {
    const a = evaluateTier2(ev('hero:pit_window_open'), state(), CONFIG);
    expect(a).to.not.be.null;
    expect(a!.tier).to.equal(2);
    expect(a!.messageText).to.equal('Pit window is open — you can box this lap');
  });

  it('T2-01: null when pitWindowOpen signal is false', () => {
    const a = evaluateTier2(
      ev('hero:pit_window_open'),
      state({ signals: { ...SIGNALS, pitWindowOpen: false } }),
      CONFIG,
    );
    expect(a).to.be.null;
  });

  // gap:closing / gap:pulling_away alerts are owned by the GapAlertMonitor
  // (007 T2-04/05); the event-driven path must not produce them.
  const MONITOR_OWNED: EventType[] = ['gap:closing', 'gap:pulling_away'];
  for (const type of MONITOR_OWNED) {
    it(`monitor-owned event returns null on the rule path: ${type}`, () => {
      expect(evaluateTier2(ev(type), state(), CONFIG)).to.be.null;
    });
  }
});

// ── T2-02 / T2-03: competitor pit awareness (007 US1, FR-001–003) ──────────

interface CapturedLog {
  msg: string;
  meta: Record<string, unknown> | undefined;
}

describe('alert-rules T2-02/T2-03 — competitor pit awareness (US1)', () => {
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

  const skipped = (reason: string): CapturedLog | undefined =>
    logs.find((l) => l.meta?.event === 'alert_skipped' && l.meta?.reason === reason);

  // hero: carIdx 0, class 100, P8/classPos 8; rival: carIdx 3, "31", classPos 6.
  function fieldState(rival: Partial<CarState>): RaceState {
    const s = state();
    s.field[3] = car({
      carIdx: 3,
      carNumber: '31',
      carClassId: 100,
      position: 6,
      classPosition: 6,
      ...rival,
    });
    return s;
  }

  it('T2-02: in-window pit entry fires the exact contract template with scoped dedup key', () => {
    const a = evaluateTier2(ev('competitor:pit_entry', { carIdx: 3 }), fieldState({}), CONFIG);
    expect(a).to.not.be.null;
    expect(a!.tier).to.equal(2);
    expect(a!.eventType).to.equal('competitor:pit_entry');
    expect(a!.messageText).to.equal('Car 31 pitting from P6');
    expect(a!.dedupKey).to.equal('competitor:pit_entry:3');
  });

  it('T2-03: in-window pit exit fires the exact contract template with scoped dedup key', () => {
    const a = evaluateTier2(ev('competitor:pit_exit', { carIdx: 3 }), fieldState({}), CONFIG);
    expect(a).to.not.be.null;
    expect(a!.messageText).to.equal('Car 31 out of pits, P6');
    expect(a!.dedupKey).to.equal('competitor:pit_exit:3');
  });

  it('out-of-window competitor is skipped with reason relevance', () => {
    // classPos 2 vs hero 8 — outside ±3
    const a = evaluateTier2(
      ev('competitor:pit_entry', { carIdx: 3 }),
      fieldState({ classPosition: 2, position: 2 }),
      CONFIG,
    );
    expect(a).to.be.null;
    const log = skipped('relevance');
    expect(log, 'alert_skipped {reason:relevance} log').to.not.be.undefined;
    expect(log!.meta!.alertType).to.equal('competitor:pit_entry');
    expect(log!.meta!.carIdx).to.equal(3);
  });

  it('different carClassId is skipped with reason relevance (multiclass)', () => {
    // adjacent classPosition but a different class — not a strategy rival
    const a = evaluateTier2(
      ev('competitor:pit_entry', { carIdx: 3 }),
      fieldState({ carClassId: 200, classPosition: 7 }),
      CONFIG,
    );
    expect(a).to.be.null;
    expect(skipped('relevance')).to.not.be.undefined;
  });

  it('degenerate class data falls back to overall position (in-window fires with overall P)', () => {
    // competitor has no valid class data; positions 6 vs 8 are within ±3
    const a = evaluateTier2(
      ev('competitor:pit_entry', { carIdx: 3 }),
      fieldState({ carClassId: 0, classPosition: 0, position: 6 }),
      CONFIG,
    );
    expect(a).to.not.be.null;
    expect(a!.messageText).to.equal('Car 31 pitting from P6');
  });

  it('degenerate class data out of overall-position window is skipped', () => {
    const a = evaluateTier2(
      ev('competitor:pit_entry', { carIdx: 3 }),
      fieldState({ carClassId: -1, classPosition: -1, position: 20 }),
      CONFIG,
    );
    expect(a).to.be.null;
    expect(skipped('relevance')).to.not.be.undefined;
  });

  it('missing state.field entry is skipped with reason identity-unresolved', () => {
    const a = evaluateTier2(ev('competitor:pit_entry', { carIdx: 99 }), fieldState({}), CONFIG);
    expect(a).to.be.null;
    const log = skipped('identity-unresolved');
    expect(log).to.not.be.undefined;
    expect(log!.meta!.carIdx).to.equal(99);
  });

  it('empty carNumber is skipped with reason identity-unresolved (never announce a placeholder)', () => {
    const a = evaluateTier2(
      ev('competitor:pit_entry', { carIdx: 3 }),
      fieldState({ carNumber: '' }),
      CONFIG,
    );
    expect(a).to.be.null;
    expect(skipped('identity-unresolved')).to.not.be.undefined;
  });

  it('null hero (pre-session) is skipped with reason no-hero', () => {
    const s = fieldState({});
    s.hero = null;
    const a = evaluateTier2(ev('competitor:pit_entry', { carIdx: 3 }), s, CONFIG);
    expect(a).to.be.null;
    expect(skipped('no-hero')).to.not.be.undefined;
  });
});
