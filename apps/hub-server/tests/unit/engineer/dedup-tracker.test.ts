import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { DedupTracker } from '../../../src/engineer/dedup-tracker.js';

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
