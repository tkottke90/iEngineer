import type { FuelModel, FuelDataSource } from "@iracing-engineer/types";

const ROLLING_WINDOW = 5;
const CAR_CLASS_DEFAULTS: Record<number, { tankCapacity: number; burnRateEstimate: number }> = {
  // populated as car class IDs are discovered
};

export class FuelModelCalculator {
  private burnHistory: number[] = [];
  private lastFuelLevel: number | null = null;
  private lastLap: number | null = null;

  constructor(private readonly historicBurnRates: number[]) {}

  update(fuelLevel: number, lapCompleted: number): FuelModel {
    if (this.lastFuelLevel !== null && this.lastLap !== null && lapCompleted > this.lastLap) {
      const consumed = this.lastFuelLevel - fuelLevel;
      if (consumed > 0) {
        this.burnHistory.push(consumed);
        if (this.burnHistory.length > ROLLING_WINDOW) {
          this.burnHistory.shift();
        }
      }
    }
    this.lastFuelLevel = fuelLevel;
    this.lastLap = lapCompleted;

    return this.compute(fuelLevel, lapCompleted);
  }

  private compute(fuelLevel: number, lapCompleted: number): FuelModel {
    const { burnRate, source } = this.resolveBurnRate();
    const lapsRemaining = burnRate > 0 ? fuelLevel / burnRate : 0;
    const fuelToFinish = 0; // TODO: derive from lapsTotal or timeRemaining
    const fuelDeficit = Math.max(0, fuelToFinish - fuelLevel);

    return {
      burnRatePerLap: burnRate,
      burnRateConfidence: this.burnHistory.length / ROLLING_WINDOW,
      fuelRemaining: fuelLevel,
      lapsRemaining,
      fuelToFinish,
      fuelDeficit,
      confidenceLevel: this.burnHistory.length >= ROLLING_WINDOW ? "high" : this.burnHistory.length >= 2 ? "medium" : "low",
      dataSource: source,
      lapsSinceCalibration: this.burnHistory.length,
    };
  }

  private resolveBurnRate(): { burnRate: number; source: FuelDataSource } {
    if (this.burnHistory.length >= 2) {
      const avg = this.burnHistory.reduce((a, b) => a + b, 0) / this.burnHistory.length;
      return { burnRate: avg, source: "live" };
    }
    if (this.historicBurnRates.length > 0) {
      const avg = this.historicBurnRates.reduce((a, b) => a + b, 0) / this.historicBurnRates.length;
      return { burnRate: avg, source: "blended" };
    }
    return { burnRate: 3.0, source: "estimated" };
  }

  calibrate(actualConsumption: number): void {
    this.burnHistory.push(actualConsumption);
    if (this.burnHistory.length > ROLLING_WINDOW) {
      this.burnHistory.shift();
    }
  }
}
