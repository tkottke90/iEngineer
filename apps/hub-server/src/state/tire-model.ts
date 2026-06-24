import type { TireModel, DegradationSignal, ConfidenceLevel } from "@iracing-engineer/types";

const ROLLING_WINDOW = 3;
const WATCH_THRESHOLD = 0.3;
const CRITICAL_THRESHOLD = 0.6;

export class TireModelCalculator {
  private stintMedianLapTime: number | null = null;
  private recentDeltas: number[] = [];

  update(compound: string, lapAge: number, recentLapTimes: number[]): TireModel {
    if (recentLapTimes.length >= 3 && this.stintMedianLapTime === null) {
      const sorted = [...recentLapTimes].sort((a, b) => a - b);
      this.stintMedianLapTime = sorted[Math.floor(sorted.length / 2)];
    }

    const rollingWindow = recentLapTimes.slice(-ROLLING_WINDOW);
    let trend = 0;
    if (this.stintMedianLapTime !== null && rollingWindow.length >= 2) {
      const avg = rollingWindow.reduce((a, b) => a + b, 0) / rollingWindow.length;
      trend = avg - this.stintMedianLapTime;
    }

    return {
      compound,
      lapAge,
      setsRemaining: 0, // TODO: read from iRacing SDK
      paceDegradationTrend: trend,
      degradationSignal: this.classifyDegradation(trend),
      degradationConfidence: lapAge >= ROLLING_WINDOW ? "high" : lapAge >= 2 ? "medium" : "low",
    };
  }

  private classifyDegradation(trend: number): DegradationSignal {
    if (trend > CRITICAL_THRESHOLD) return "critical";
    if (trend > WATCH_THRESHOLD) return "watch";
    return "nominal";
  }
}
