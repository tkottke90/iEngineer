import type { RaceState, PrimarySubject } from "@iracing-engineer/types";
import type { ShotRequest } from "./shot-queue.js";
import { ShotTier } from "./shot-queue.js";

export interface CutHistoryEntry {
  scene: string;
  cameraType: "onboard" | "tv_pod" | "trackside" | "blimp" | "unknown";
  carIdx: number | null;
  timestamp: number;
}

const CAMERA_DWELL_TARGETS_S = {
  onboard: { min: 15, max: 30 },
  tv_pod: { min: 20, max: 40 },
  trackside: { min: 10, max: 20 },
  blimp: { min: 30, max: 60 },
} as const;

export class CameraSelector {
  selectHeroShot(
    subjects: PrimarySubject[],
    state: RaceState,
    recentCuts: CutHistoryEntry[],
  ): ShotRequest {
    const primarySubject = subjects.sort((a, b) => a.priority - b.priority)[0];
    const nextCameraType = this.pickCameraType(recentCuts);

    return {
      scene: `hero_${nextCameraType}`,
      cameraName: nextCameraType,
      reason: `hero coverage — ${primarySubject?.driverName ?? "primary subject"}`,
      tier: ShotTier.AMBIENT,
    };
  }

  selectGeneralShot(state: RaceState, recentCuts: CutHistoryEntry[]): ShotRequest {
    const fieldCars = Object.values(state.field);

    // Score each car: battles score highest, position changes second, etc.
    const scored = fieldCars.map((car) => {
      let score = 0;
      const isInBattle = state.signals.activeBattles.some(
        (b) => b.leadCarIdx === car.carIdx || b.trailCarIdx === car.carIdx,
      );
      if (isInBattle) score += 100;
      score += Math.max(0, 20 - car.position); // higher positions score more
      return { car, score };
    });

    const best = scored.sort((a, b) => b.score - a.score)[0];
    const nextCameraType = this.pickCameraType(recentCuts);

    return {
      scene: `car_${best?.car.carIdx ?? 0}_${nextCameraType}`,
      cameraName: nextCameraType,
      reason: `general coverage — P${best?.car.position ?? "?"} battle`,
      tier: ShotTier.AMBIENT,
    };
  }

  private pickCameraType(recentCuts: CutHistoryEntry[]): keyof typeof CAMERA_DWELL_TARGETS_S {
    const types: Array<keyof typeof CAMERA_DWELL_TARGETS_S> = ["onboard", "tv_pod", "trackside", "blimp"];
    const recentTypes = recentCuts.slice(-3).map((c) => c.cameraType);
    const underused = types.find((t) => !recentTypes.includes(t));
    return underused ?? "onboard";
  }
}
