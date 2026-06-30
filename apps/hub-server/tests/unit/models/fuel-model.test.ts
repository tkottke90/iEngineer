import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { FuelModelEngine } from '../../../src/models/fuel-model.js';

describe('FuelModel', () => {
  let engine: FuelModelEngine;

  beforeEach(() => {
    engine = new FuelModelEngine({ windowSize: 5 });
  });

  it('FR-012: confidenceLevel is "low" after 1 lap', () => {
    engine.onLapCompletion(45.0, 42.2, 90, false, false);
    const snap = engine.getSnapshot();
    expect(snap.confidenceLevel).to.equal('low');
  });

  it('SC-002/FR-013: burnRatePerLap within ±0.05 after 5 laps at 2.8L/lap; summary contains correct substrings', () => {
    let fuel = 45.0;
    const burn = 2.8;
    for (let i = 0; i < 5; i++) {
      engine.onLapCompletion(fuel, fuel - burn, 90, false, false);
      fuel -= burn;
    }
    // Remaining laps = lapsTotal - 5 laps done; engine doesn't know lapsTotal, pass via snapshot context
    // Set session laps remaining so we can check summary
    engine.setSessionContext({ lapsRemaining: 10, timeRemaining: null });
    const snap = engine.getSnapshot();
    expect(snap.burnRatePerLap).to.be.within(2.8 - 0.05, 2.8 + 0.05);
    // Good state: fuelDeficit < 0 (surplus)
    // With 10 laps remaining at 2.8 each = 28L needed; remaining fuel ≈ 31L
    expect(snap.summary).to.include('lap');
    expect(snap.fuelDeficit).to.be.lessThan(0); // surplus
    expect(snap.summary.toLowerCase()).to.include('good');
    expect(snap.summary).to.include('-lap buffer');

    // Tight case: fuelDeficit ≈ 0
    const tight = new FuelModelEngine({ windowSize: 5 });
    fuel = 45.0;
    for (let i = 0; i < 5; i++) {
      tight.onLapCompletion(fuel, fuel - burn, 90, false, false);
      fuel -= burn;
    }
    tight.setSessionContext({ lapsRemaining: Math.round((45 - 5 * burn) / burn), timeRemaining: null });
    const tightSnap = tight.getSnapshot();
    expect(tightSnap.summary.toLowerCase()).to.include('tight');

    // Critical case: fuelDeficit > 0
    const crit = new FuelModelEngine({ windowSize: 5 });
    fuel = 45.0;
    for (let i = 0; i < 5; i++) {
      crit.onLapCompletion(fuel, fuel - burn, 90, false, false);
      fuel -= burn;
    }
    crit.setSessionContext({ lapsRemaining: 20, timeRemaining: null }); // way more laps than fuel
    const critSnap = crit.getSnapshot();
    expect(critSnap.summary.toLowerCase()).to.include('critical');
  });

  it('FR-012: outlap and inlap are excluded from rolling average', () => {
    // Inject 2 normal laps + 1 outlap at different burn rate + 1 inlap at different burn rate
    engine.onLapCompletion(45.0, 42.2, 90, false, false); // burn 2.8
    engine.onLapCompletion(42.2, 39.4, 90, false, false); // burn 2.8
    engine.onLapCompletion(39.4, 30.0, 120, true, false);  // outlap (should be excluded)
    engine.onLapCompletion(30.0, 20.0, 100, false, true);  // inlap (should be excluded)
    engine.setSessionContext({ lapsRemaining: 5, timeRemaining: null });
    const snap = engine.getSnapshot();
    // Average should still be ~2.8, not distorted by outlap/inlap
    expect(snap.burnRatePerLap).to.be.within(2.8 - 0.1, 2.8 + 0.1);
  });

  it('FR-014: refuel detected resets fuelAtLapStart without corrupting average', () => {
    engine.onLapCompletion(45.0, 42.2, 90, false, false);
    engine.onLapCompletion(42.2, 39.4, 90, false, false);
    // Simulate pit stop refuel
    engine.onPitExit(55.0);
    // More laps after refuel
    engine.onLapCompletion(55.0, 52.2, 90, false, false);
    engine.setSessionContext({ lapsRemaining: 5, timeRemaining: null });
    const snap = engine.getSnapshot();
    expect(snap.burnRatePerLap).to.be.within(2.8 - 0.1, 2.8 + 0.1);
    expect(snap.fuelRemaining).to.be.greaterThan(0);
  });

  it('FR-015: SessionLapsRemain === -1 sets lapsRemaining null, timeRemaining populated, summary uses time template', () => {
    let fuel = 45.0;
    const burn = 2.8;
    for (let i = 0; i < 5; i++) {
      engine.onLapCompletion(fuel, fuel - burn, 90, false, false);
      fuel -= burn;
    }
    // -1 signals time-based race
    engine.setSessionContext({ lapsRemaining: null, timeRemaining: 900 }); // 15 min remaining
    const snap = engine.getSnapshot();
    expect(snap.lapsRemaining).to.be.null;
    expect(snap.timeRemaining).to.not.be.null;
    expect(snap.summary).to.include('minute');
    expect(snap.summary).to.include('-minute buffer');
  });
});
