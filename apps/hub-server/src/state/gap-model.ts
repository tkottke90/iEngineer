import type { GapModel, BattleStatus } from "@iracing-engineer/types";

const OPEN_THRESHOLD = 2.0;
const CLOSING_RATE_THRESHOLD = -0.2;
const BATTLE_THRESHOLD = 1.0;
const RESOLVED_THRESHOLD = 1.5;
const RESOLVED_CONSECUTIVE = 2;

export class GapModelCalculator {
  private previousStatuses = new Map<string, { status: BattleStatus; resolvedCount: number }>();

  update(leadCarIdx: number, trailCarIdx: number, gapHistory: number[]): GapModel {
    const key = `${leadCarIdx}-${trailCarIdx}`;
    const gap = gapHistory[gapHistory.length - 1] ?? 0;
    const gapTrend = gapHistory.length >= 2
      ? gapHistory[gapHistory.length - 1] - gapHistory[gapHistory.length - 2]
      : 0;
    const closingRate = gapHistory.length >= 3
      ? (gapHistory[gapHistory.length - 1] - gapHistory[0]) / (gapHistory.length - 1)
      : gapTrend;

    const lapsToContact = closingRate < 0 && gap > 0 ? gap / Math.abs(closingRate) : null;

    const prev = this.previousStatuses.get(key) ?? { status: "open" as BattleStatus, resolvedCount: 0 };
    const battleStatus = this.computeStatus(gap, closingRate, prev);
    this.previousStatuses.set(key, battleStatus);

    return {
      leadCarIdx,
      trailCarIdx,
      gapSeconds: gap,
      gapTrend,
      closingRate,
      lapsToContact,
      battleStatus: battleStatus.status,
    };
  }

  private computeStatus(
    gap: number,
    closingRate: number,
    prev: { status: BattleStatus; resolvedCount: number },
  ): { status: BattleStatus; resolvedCount: number } {
    if (gap <= BATTLE_THRESHOLD) return { status: "battle", resolvedCount: 0 };
    if (gap <= OPEN_THRESHOLD && closingRate < CLOSING_RATE_THRESHOLD) return { status: "closing", resolvedCount: 0 };
    if (prev.status === "battle" && gap > RESOLVED_THRESHOLD) {
      const resolvedCount = prev.resolvedCount + 1;
      return { status: resolvedCount >= RESOLVED_CONSECUTIVE ? "resolved" : "battle", resolvedCount };
    }
    return { status: "open", resolvedCount: 0 };
  }
}
