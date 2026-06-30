import type { FuelModel, ConfidenceLevel } from '@iracing-engineer/types';
import { getCarClassDefaults } from './car-class-defaults.js';

interface FuelModelOptions {
  windowSize?: number;
  mode?: 'live' | 'observer';
  carClassId?: number;
}

interface SessionContext {
  lapsRemaining: number | null;
  timeRemaining: number | null;
}

export class FuelModelEngine {
  private windowSize: number;
  private mode: 'live' | 'observer';
  private carClassId?: number;

  private lapBurns: number[] = [];
  private lapCount = 0;
  private fuelAtLapStart: number | null = null;
  private currentFuel = 0;
  private sessionCtx: SessionContext = { lapsRemaining: null, timeRemaining: null };

  constructor(opts: FuelModelOptions = {}) {
    this.windowSize = opts.windowSize ?? 5;
    this.mode = opts.mode ?? 'live';
    this.carClassId = opts.carClassId;
  }

  setSessionContext(ctx: SessionContext): void {
    this.sessionCtx = ctx;
  }

  onLapCompletion(fuelAtStart: number, fuelAtEnd: number, _lapTime: number, isOutlap: boolean, isInlap: boolean): void {
    this.currentFuel = fuelAtEnd;
    if (!isOutlap && !isInlap) {
      const burn = fuelAtStart - fuelAtEnd;
      if (burn > 0) {
        this.lapBurns.push(burn);
        if (this.lapBurns.length > this.windowSize) {
          this.lapBurns.shift();
        }
        this.lapCount++;
      }
    }
    this.fuelAtLapStart = fuelAtEnd;
  }

  onPitExit(currentFuelLevel: number): void {
    this.fuelAtLapStart = currentFuelLevel;
    this.currentFuel = currentFuelLevel;
  }

  getSnapshot(): FuelModel {
    if (this.mode === 'observer') {
      return this._observerSnapshot();
    }
    return this._liveSnapshot();
  }

  private _avgBurnRate(): number {
    if (this.lapBurns.length === 0) return 0;
    return this.lapBurns.reduce((s, v) => s + v, 0) / this.lapBurns.length;
  }

  private _confidenceLevel(): ConfidenceLevel {
    if (this.lapCount >= 5) return 'high';
    if (this.lapCount >= 3) return 'medium';
    return 'low';
  }

  private _liveSnapshot(): FuelModel {
    const burnRatePerLap = this._avgBurnRate();
    const fuelRemaining = this.currentFuel;
    const { lapsRemaining, timeRemaining } = this.sessionCtx;
    const isTimeBased = lapsRemaining === null;

    let lapsRemainingCalc: number | null = null;
    let timeRemainingCalc: number | null = null;
    let fuelToFinish = 0;
    let fuelDeficit = 0;

    if (!isTimeBased && lapsRemaining !== null) {
      fuelToFinish = burnRatePerLap * lapsRemaining;
      fuelDeficit = fuelToFinish - fuelRemaining;
      lapsRemainingCalc = burnRatePerLap > 0 ? fuelRemaining / burnRatePerLap : 0;
    } else if (timeRemaining !== null) {
      // Time-based race: estimate laps from burn rate and time
      const lapTime = 90; // Default 90s estimate; could be injected later
      const estimatedLapsLeft = timeRemaining / lapTime;
      fuelToFinish = burnRatePerLap * estimatedLapsLeft;
      fuelDeficit = fuelToFinish - fuelRemaining;
      timeRemainingCalc = burnRatePerLap > 0 ? (fuelRemaining / burnRatePerLap) * lapTime : 0;
    }

    const lapBuffer = burnRatePerLap > 0 ? Math.floor((fuelRemaining - fuelToFinish) / burnRatePerLap) : 0;
    const minuteBuffer = burnRatePerLap > 0 ? Math.round(((fuelRemaining - fuelToFinish) / burnRatePerLap) * 90 / 60) : 0;

    const summary = this._buildSummary(isTimeBased, lapsRemainingCalc, fuelDeficit, lapBuffer, minuteBuffer, burnRatePerLap);

    return {
      burnRatePerLap,
      burnRateConfidence: this.lapBurns.length / this.windowSize,
      fuelRemaining,
      lapsRemaining: lapsRemainingCalc,
      fuelToFinish,
      fuelDeficit,
      confidenceLevel: this._confidenceLevel(),
      dataSource: 'live',
      lapsSinceCalibration: 0,
      summary,
      timeRemaining: timeRemainingCalc,
    };
  }

  private _buildSummary(
    isTimeBased: boolean,
    lapsRemaining: number | null,
    fuelDeficit: number,
    lapBuffer: number,
    minuteBuffer: number,
    burnRatePerLap: number,
  ): string {
    if (burnRatePerLap === 0) {
      return 'Fuel status unknown — no lap data yet';
    }

    if (isTimeBased) {
      if (fuelDeficit > 0) {
        return `Fuel critical — short by ${Math.abs(minuteBuffer)}-minute buffer`;
      } else if (fuelDeficit === 0) {
        return `Fuel tight — 0-minute buffer`;
      } else {
        return `Fuel is good — ${minuteBuffer}-minute buffer`;
      }
    }

    // Lap-based race
    const lapsStr = lapsRemaining !== null ? Math.floor(lapsRemaining) : 0;
    if (fuelDeficit > 0) {
      // Short on fuel: critical
      return `Fuel critical — ${lapsStr} laps remaining on current load. ${Math.abs(lapBuffer)}-lap buffer needed`;
    } else if (fuelDeficit === 0 || lapBuffer === 0) {
      // Exactly enough: tight
      return `Fuel tight — ${lapsStr} laps remaining on current load. 0-lap buffer`;
    } else {
      // Surplus: good
      return `Fuel is good — ${lapsStr} laps remaining on current load. ${lapBuffer}-lap buffer`;
    }
  }

  private _observerSnapshot(): FuelModel {
    const defaults = this.carClassId ? getCarClassDefaults(this.carClassId) : { tankCapacityLiters: 60, defaultBurnRatePerLap: 3.0 };
    const lapCompleted = this.lapCount;
    const estimated = defaults.tankCapacityLiters - lapCompleted * defaults.defaultBurnRatePerLap;
    return {
      burnRatePerLap: defaults.defaultBurnRatePerLap,
      burnRateConfidence: 0.3,
      fuelRemaining: Math.max(0, estimated),
      lapsRemaining: defaults.defaultBurnRatePerLap > 0 ? Math.floor(estimated / defaults.defaultBurnRatePerLap) : null,
      fuelToFinish: 0,
      fuelDeficit: 0,
      confidenceLevel: 'low',
      dataSource: 'estimated',
      lapsSinceCalibration: 0,
      summary: `Estimated fuel: ~${Math.max(0, estimated).toFixed(1)}L (observer mode)`,
      timeRemaining: null,
    };
  }
}
