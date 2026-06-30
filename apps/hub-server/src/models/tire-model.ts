import type { TireModel, DegradationSignal } from '@iracing-engineer/types';

export class TireModelEngine {
  private stintLaps: number[] = [];  // only valid (non-outlap, non-inlap) lap times
  private lapAge = 0;
  private compound = 'Unknown';

  onLapCompletion(lapTime: number, isOutlap: boolean, isInlap: boolean): void {
    if (!isOutlap && !isInlap) {
      this.stintLaps.push(lapTime);
      this.lapAge++;
    }
  }

  onPitStop(newCompound: string): void {
    this.stintLaps = [];
    this.lapAge = 0;
    this.compound = newCompound;
  }

  getSnapshot(): TireModel {
    const median = this._median();
    const trend = this._trend();
    const signal = this._classify(trend);
    return {
      compound: this.compound,
      lapAge: this.lapAge,
      setsRemaining: -1,
      paceDegradationTrend: trend,
      degradationSignal: signal,
      degradationConfidence: this.stintLaps.length >= 5 ? 'high' : this.stintLaps.length >= 3 ? 'medium' : 'low',
    };
  }

  private _median(): number {
    if (this.stintLaps.length === 0) return 0;
    const sorted = [...this.stintLaps].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  private _trend(): number {
    if (this.stintLaps.length < 2) return 0;
    // Degradation = last lap time - first lap time of stint
    return this.stintLaps[this.stintLaps.length - 1] - this.stintLaps[0];
  }

  private _classify(trend: number): DegradationSignal {
    // FR-017: [0.3, 0.6] is watch (boundary inclusive), > 0.6 is critical
    // Use epsilon to handle floating-point boundary comparisons
    const EPS = 1e-9;
    if (trend > 0.6 + EPS) return 'critical';
    if (trend >= 0.3 - EPS) return 'watch';
    return 'nominal';
  }
}
