import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { DedupTracker, dedupKeyFor } from '../../../src/engineer/dedup-tracker.js';

describe('DedupTracker — two key strategies (FR-006)', () => {
  let t: DedupTracker;
  beforeEach(() => {
    t = new DedupTracker();
  });

  it('per-lap: fuel critical fires once per lap, auto-resets next lap without recordCleared', () => {
    expect(t.shouldFire('hero:fuel_critical', 5)).to.be.true;
    t.recordFired('hero:fuel_critical', 5);
    expect(t.shouldFire('hero:fuel_critical', 5)).to.be.false; // same lap suppressed
    expect(t.shouldFire('hero:fuel_critical', 6)).to.be.true; // new lap auto-reset
  });

  it('event-cleared: pit window suppressed across laps until recordCleared (per-stint)', () => {
    expect(t.shouldFire('hero:pit_window_open', 10)).to.be.true;
    t.recordFired('hero:pit_window_open', 10);
    expect(t.shouldFire('hero:pit_window_open', 11)).to.be.false; // suppressed next lap
    expect(t.shouldFire('hero:pit_window_open', 12)).to.be.false; // STILL suppressed — per-stint, not per-lap
    t.recordCleared('hero:pit_window_open');
    expect(t.shouldFire('hero:pit_window_open', 13)).to.be.true; // re-fires after pit exit reset
  });

  it('blue flag clears via recordCleared, same-lap re-fire permitted', () => {
    t.recordFired('hero:blue_flag', 5);
    expect(t.shouldFire('hero:blue_flag', 5)).to.be.false;
    t.recordCleared('hero:blue_flag');
    expect(t.shouldFire('hero:blue_flag', 5)).to.be.true; // same-lap re-fire after clear
  });

  it('safety car clears via recordCleared', () => {
    t.recordFired('session:safety_car_deployed', 3);
    expect(t.shouldFire('session:safety_car_deployed', 4)).to.be.false;
    t.recordCleared('session:safety_car_deployed');
    expect(t.shouldFire('session:safety_car_deployed', 4)).to.be.true;
  });

  it('pit limiter clears via recordCleared', () => {
    t.recordFired('hero:pit_limiter_active', 8);
    expect(t.shouldFire('hero:pit_limiter_active', 9)).to.be.false;
    t.recordCleared('hero:pit_limiter_active');
    expect(t.shouldFire('hero:pit_limiter_active', 9)).to.be.true;
  });
});

describe('DedupTracker — scoped keys (007 T2-02/03/06)', () => {
  let t: DedupTracker;
  beforeEach(() => {
    t = new DedupTracker();
  });

  it('scoped keys are independent per car: car 12 firing does not suppress car 7', () => {
    t.recordFired('competitor:pit_entry', 5, '12');
    expect(t.shouldFire('competitor:pit_entry', 5, '12')).to.be.false;
    expect(t.shouldFire('competitor:pit_entry', 5, '7')).to.be.true;
  });

  it('scoped keys are independent per level: watch firing does not suppress critical', () => {
    t.recordFired('hero:pace_degradation', 10, 'watch');
    expect(t.shouldFire('hero:pace_degradation', 11, 'watch')).to.be.false; // across laps
    expect(t.shouldFire('hero:pace_degradation', 11, 'critical')).to.be.true;
  });

  it('scoped recordCleared removes only that scope key', () => {
    t.recordFired('competitor:pit_entry', 5, '12');
    t.recordFired('competitor:pit_entry', 5, '7');
    t.recordCleared('competitor:pit_entry', '12');
    expect(t.shouldFire('competitor:pit_entry', 6, '12')).to.be.true; // cleared
    expect(t.shouldFire('competitor:pit_entry', 6, '7')).to.be.false; // untouched
  });

  it('scope-less recordCleared removes ALL keys of the type, including scoped', () => {
    t.recordFired('hero:pace_degradation', 5, 'watch');
    t.recordFired('hero:pace_degradation', 8, 'critical');
    t.recordCleared('hero:pace_degradation');
    expect(t.shouldFire('hero:pace_degradation', 9, 'watch')).to.be.true;
    expect(t.shouldFire('hero:pace_degradation', 9, 'critical')).to.be.true;
  });

  it('dedupKeyFor renders the scoped format', () => {
    expect(dedupKeyFor('competitor:pit_entry', 5, '12')).to.equal('competitor:pit_entry:12');
    expect(dedupKeyFor('hero:pace_degradation', 5, 'watch')).to.equal(
      'hero:pace_degradation:watch',
    );
  });

  it('regression: existing unscoped behavior is unchanged', () => {
    // per-lap strategy ignores scope-less calls exactly as before
    expect(dedupKeyFor('hero:fuel_critical', 5)).to.equal('hero:fuel_critical:5');
    expect(dedupKeyFor('hero:pit_window_open', 5)).to.equal('hero:pit_window_open');
    t.recordFired('hero:pit_window_open', 5);
    expect(t.shouldFire('hero:pit_window_open', 6)).to.be.false;
    t.recordCleared('hero:pit_window_open');
    expect(t.shouldFire('hero:pit_window_open', 6)).to.be.true;
  });
});
