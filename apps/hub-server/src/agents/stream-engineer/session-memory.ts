import type { CutHistoryEntry } from "./camera-select.js";

const SITUATION_COOLDOWN_MS = 5 * 60 * 1000;

interface OverrideRecord {
  timestamp: number;
  durationMs: number;
}

export class StreamSessionMemory {
  private recentCuts: CutHistoryEntry[] = [];
  private overrideHistory: OverrideRecord[] = [];
  private situationCooldowns = new Map<string, number>();
  private coverageLog = new Map<number, number>(); // carIdx → total seconds covered

  recordCut(cut: CutHistoryEntry): void {
    this.recentCuts.push(cut);
    if (this.recentCuts.length > 10) this.recentCuts.shift();
    if (cut.carIdx !== null) {
      this.coverageLog.set(cut.carIdx, (this.coverageLog.get(cut.carIdx) ?? 0));
    }
  }

  getRecentCuts(n: number): CutHistoryEntry[] {
    return this.recentCuts.slice(-n);
  }

  recordOperatorOverride(durationMs: number): void {
    this.overrideHistory.push({ timestamp: Date.now(), durationMs });
  }

  isOnCooldown(situationKey: string): boolean {
    const expiresAt = this.situationCooldowns.get(situationKey);
    return expiresAt !== undefined && Date.now() < expiresAt;
  }

  setSituationCooldown(situationKey: string): void {
    this.situationCooldowns.set(situationKey, Date.now() + SITUATION_COOLDOWN_MS);
  }

  getUnderservedCars(allCarIdxs: number[]): number[] {
    const sorted = allCarIdxs.sort(
      (a, b) => (this.coverageLog.get(a) ?? 0) - (this.coverageLog.get(b) ?? 0),
    );
    return sorted.slice(0, 3);
  }
}
