import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { RaceEvent, DerivedSignals, EngineerConfig, EventType } from '@iracing-engineer/types';
import { evaluateTier1, evaluateTier2 } from '../../../src/engineer/alert-rules.js';

const CONFIG: EngineerConfig = {
  chatterboxUrl: 'http://x',
  chatterboxVoiceFile: 'v.wav',
  fuelCriticalLapsRemaining: 1.0,
  gapThresholdSeconds: 2.0,
  audioIdleCleanupIntervalMs: 30000,
};

const SIGNALS: DerivedSignals = {
  safeWindowOpen: true,
  cutWindowOpen: false,
  activeBattles: [],
  pitWindowOpen: true,
};

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
    const a = evaluateTier2(ev('hero:pit_window_open'), SIGNALS, CONFIG);
    expect(a).to.not.be.null;
    expect(a!.tier).to.equal(2);
    expect(a!.messageText).to.equal('Pit window is open — you can box this lap');
  });

  it('T2-01: null when pitWindowOpen signal is false', () => {
    const a = evaluateTier2(
      ev('hero:pit_window_open'),
      { ...SIGNALS, pitWindowOpen: false },
      CONFIG,
    );
    expect(a).to.be.null;
  });

  const M5_STUBS: EventType[] = [
    'competitor:pit_entry',
    'competitor:pit_exit',
    'gap:closing',
    'gap:pulling_away',
    'hero:pace_degradation',
  ];
  for (const type of M5_STUBS) {
    it(`M5 stub returns null: ${type}`, () => {
      expect(evaluateTier2(ev(type), SIGNALS, CONFIG)).to.be.null;
    });
  }
});
