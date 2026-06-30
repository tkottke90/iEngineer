import { describe, it } from 'mocha';
import { expect } from 'chai';
import { SessionProcessor } from '../../../src/pipeline/session-processor.js';
import { FuelModelEngine } from '../../../src/models/fuel-model.js';
import { TireModelEngine } from '../../../src/models/tire-model.js';
import { GapModelEngine } from '../../../src/models/gap-model.js';
import * as raceState from '../../../src/state/race-state.js';

// Minimal mock Redis command connection
function mockRedis() {
  return {
    setex: async () => {},
    publish: async () => 0,
    lpush: async () => 1,
    ltrim: async () => {},
    expire: async () => {},
    xack: async () => 1,
  } as any;
}

describe('SessionProcessor', () => {
  describe('pitWindowOpen (T045, FR-029)', () => {
    it('pitWindowOpen === false when fuelDeficit > 0 (fuel short)', async () => {
      const fuel = new FuelModelEngine({ windowSize: 5 });
      const tire = new TireModelEngine();
      const gap = new GapModelEngine();
      const proc = new SessionProcessor(mockRedis(), fuel, tire, gap);

      // 5 laps of fuel data
      let f = 10.0;
      const burn = 2.8;
      for (let i = 0; i < 5; i++) {
        fuel.onLapCompletion(f, f - burn, 90, false, false);
        f -= burn;
      }
      tire.onLapCompletion(90, false, false);
      tire.onLapCompletion(90.1, false, false);

      // 20 laps remaining but only ~0.7L fuel left → fuelDeficit > 0
      fuel.setSessionContext({ lapsRemaining: 20, timeRemaining: null });

      const signals = proc.evaluatePitWindow();
      expect(signals.pitWindowOpen).to.be.false;
    });

    it('pitWindowOpen === true when fuelDeficit === 0 AND lapAge > 5', async () => {
      const fuel = new FuelModelEngine({ windowSize: 5 });
      const tire = new TireModelEngine();
      const gap = new GapModelEngine();
      const proc = new SessionProcessor(mockRedis(), fuel, tire, gap);

      // 5 laps of fuel data at 2.8L/lap
      let f = 45.0;
      const burn = 2.8;
      for (let i = 0; i < 5; i++) {
        fuel.onLapCompletion(f, f - burn, 90, false, false);
        f -= burn;
      }
      // Remaining fuel exactly matches remaining laps (fuelDeficit ≈ 0)
      const fuelLeft = f;
      const lapsLeft = Math.floor(fuelLeft / burn);
      fuel.setSessionContext({ lapsRemaining: lapsLeft, timeRemaining: null });

      // Tires are old (lapAge > 5)
      for (let i = 0; i < 7; i++) {
        tire.onLapCompletion(90 + i * 0.05, false, false);
      }

      const signals = proc.evaluatePitWindow();
      expect(signals.pitWindowOpen).to.be.true;
    });

    it('pitWindowOpen === false when fuelDeficit < 0 AND degradationSignal === "nominal" AND lapAge ≤ 5', async () => {
      const fuel = new FuelModelEngine({ windowSize: 5 });
      const tire = new TireModelEngine();
      const gap = new GapModelEngine();
      const proc = new SessionProcessor(mockRedis(), fuel, tire, gap);

      let f = 45.0;
      const burn = 2.8;
      for (let i = 0; i < 5; i++) {
        fuel.onLapCompletion(f, f - burn, 90, false, false);
        f -= burn;
      }
      // Very few laps remaining → fuel surplus (fuelDeficit < 0)
      fuel.setSessionContext({ lapsRemaining: 3, timeRemaining: null });

      // Tires are fresh (lapAge ≤ 5) and nominal
      for (let i = 0; i < 3; i++) {
        tire.onLapCompletion(90 + i * 0.05, false, false);
      }

      const signals = proc.evaluatePitWindow();
      expect(signals.pitWindowOpen).to.be.false;
    });
  });

  describe('FR-006 FieldState seed (T046)', () => {
    it('all carIdx keys appear in FieldState even if only 1 car sends telemetry', async () => {
      const fuel = new FuelModelEngine({ windowSize: 5 });
      const tire = new TireModelEngine();
      const gap = new GapModelEngine();
      const proc = new SessionProcessor(mockRedis(), fuel, tire, gap);

      // Simulate session event with 3 cars
      proc.seedFieldState([
        { carIdx: 0, userName: 'Driver 0', carNumber: '0', teamName: '', carClassID: 4074 },
        { carIdx: 1, userName: 'Driver 1', carNumber: '1', teamName: '', carClassID: 4074 },
        { carIdx: 2, userName: 'Driver 2', carNumber: '2', teamName: '', carClassID: 4074 },
      ]);

      const snapshot = raceState.getSnapshot();
      expect(snapshot.field).to.have.property('0');
      expect(snapshot.field).to.have.property('1');
      expect(snapshot.field).to.have.property('2');
    });
  });
});
