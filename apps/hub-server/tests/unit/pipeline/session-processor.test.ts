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

  describe('weather passthrough (007 US4, FR-015/FR-016)', () => {
    const PLACEHOLDER = {
      tempCelsius: 0,
      trackTempCelsius: 0,
      humidity: 0,
      windSpeedMs: 0,
      windDirRad: 0,
      skies: 'Clear',
      precipitation: 0,
      fogLevel: 0,
    };

    function freshProcessor(): SessionProcessor {
      const fuel = new FuelModelEngine({ windowSize: 5 });
      const tire = new TireModelEngine();
      const gap = new GapModelEngine();
      return new SessionProcessor(mockRedis(), fuel, tire, gap);
    }

    function seedSession(): void {
      raceState.setSession({
        sessionId: 's-weather',
        trackName: 'Spa',
        trackLengthMeters: 7004,
        sessionType: 'Race',
        sessionPhase: 'Racing',
        lapsTotal: null,
        lapsRemaining: null,
        timeRemaining: null,
        flags: 0,
        weather: { ...PLACEHOLDER },
        sessionStartWallClock: 0,
      } as Parameters<typeof raceState.setSession>[0]);
    }

    // Wire format: the collector publishes the raw SDK field names
    // (AirTemp, TrackTempCrew, …) — the mapping must accept them.
    const FULL_FRAME = {
      sessionTime: 100,
      AirTemp: 24.5,
      TrackTempCrew: 31.2,
      RelativeHumidity: 0.55,
      WindVel: 3.4,
      WindDir: 1.57,
      Skies: 3,
      Precipitation: 0.25,
      FogLevel: 0.1,
    };

    it('FR-015: 1:1 unit passthroughs — a weather-bearing frame populates session.weather', async () => {
      seedSession();
      const proc = freshProcessor();
      await proc.onSessionTelemetry(JSON.stringify(FULL_FRAME));
      const w = raceState.getSnapshot().session!.weather;
      expect(w.tempCelsius).to.equal(24.5); // AirTemp → tempCelsius (AIR temp)
      expect(w.trackTempCelsius).to.equal(31.2); // TrackTempCrew
      expect(w.humidity).to.equal(0.55); // RelativeHumidity (0–1)
      expect(w.windSpeedMs).to.equal(3.4); // WindVel (m/s)
      expect(w.windDirRad).to.equal(1.57); // WindDir (radians)
      expect(w.precipitation).to.equal(0.25); // Precipitation (0–1)
      expect(w.fogLevel).to.equal(0.1); // FogLevel (0–1)
      expect(w.skies).to.equal('Overcast'); // Skies 3
    });

    it('FR-015: Skies 0–3 maps to the typed union; out-of-range falls back to Clear', async () => {
      const cases: Array<[number, string]> = [
        [0, 'Clear'],
        [1, 'PartlyCloudy'],
        [2, 'MostlyCloudy'],
        [3, 'Overcast'],
        [7, 'Clear'], // out-of-range
        [-1, 'Clear'],
      ];
      for (const [raw, expected] of cases) {
        seedSession();
        const proc = freshProcessor();
        await proc.onSessionTelemetry(JSON.stringify({ ...FULL_FRAME, Skies: raw }));
        expect(raceState.getSnapshot().session!.weather.skies, `Skies=${raw}`).to.equal(expected);
      }
    });

    it('FR-016: a frame with NO weather fields leaves the previous weather untouched', async () => {
      seedSession();
      const proc = freshProcessor();
      await proc.onSessionTelemetry(JSON.stringify(FULL_FRAME));
      // Older-collector frame: no weather fields at all — never regress.
      await proc.onSessionTelemetry(JSON.stringify({ sessionTime: 101 }));
      const w = raceState.getSnapshot().session!.weather;
      expect(w.tempCelsius).to.equal(24.5);
      expect(w.skies).to.equal('Overcast');
    });

    it('FR-016: the no-regress guard is PER FIELD — a partial frame updates only what it carries', async () => {
      seedSession();
      const proc = freshProcessor();
      await proc.onSessionTelemetry(JSON.stringify(FULL_FRAME));
      // Partial frame: airTemp present, everything else absent.
      await proc.onSessionTelemetry(JSON.stringify({ sessionTime: 102, AirTemp: 19.0 }));
      const w = raceState.getSnapshot().session!.weather;
      expect(w.tempCelsius).to.equal(19.0); // updated
      expect(w.trackTempCelsius).to.equal(31.2); // preserved
      expect(w.fogLevel).to.equal(0.1); // preserved
      expect(w.skies).to.equal('Overcast'); // preserved
    });

    it('camelCase frames (hub test convention) map identically', async () => {
      seedSession();
      const proc = freshProcessor();
      await proc.onSessionTelemetry(
        JSON.stringify({ sessionTime: 100, airTemp: 22.0, skies: 1, windVel: 5.5 }),
      );
      const w = raceState.getSnapshot().session!.weather;
      expect(w.tempCelsius).to.equal(22.0);
      expect(w.skies).to.equal('PartlyCloudy');
      expect(w.windSpeedMs).to.equal(5.5);
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
