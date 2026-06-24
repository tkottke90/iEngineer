import type { RaceState } from "@iracing-engineer/types";
import type { ShotRequest } from "./shot-queue.js";

const DEFAULT_MIN_DWELL_S = 8;
const POST_INCIDENT_DWELL_S = 4;

interface BlackoutZone {
  id: string;
  trackName: string;
  startPct: number;
  endPct: number;
}

export class CutWindowMonitor {
  private postIncidentMode = false;
  private blackoutZones: BlackoutZone[] = [];

  update(state: RaceState, currentShot: ShotRequest | null, timeSinceLastCutSeconds: number): boolean {
    const minDwell = this.postIncidentMode ? POST_INCIDENT_DWELL_S : DEFAULT_MIN_DWELL_S;

    // Condition 1: minimum dwell elapsed
    if (timeSinceLastCutSeconds < minDwell) return false;

    // Condition 2: no active overtake in current shot (TODO: detect via battle signals)
    // Condition 3: no unresolved incident in frame (TODO: track incident cooldown)
    // Condition 4: subject car not at critical track section
    if (state.hero) {
      const inBlackout = this.blackoutZones.some(
        (z) =>
          z.trackName === state.session.trackName &&
          state.hero!.lapDistPct >= z.startPct &&
          state.hero!.lapDistPct <= z.endPct,
      );
      if (inBlackout) return false;
    }

    return true;
  }

  setPostIncidentMode(): void {
    this.postIncidentMode = true;
    setTimeout(() => { this.postIncidentMode = false; }, POST_INCIDENT_DWELL_S * 1000);
  }

  addBlackoutZone(trackName: string, startPct: number, endPct: number): string {
    const id = crypto.randomUUID();
    this.blackoutZones.push({ id, trackName, startPct, endPct });
    return id;
  }

  removeBlackoutZone(id: string): void {
    this.blackoutZones = this.blackoutZones.filter((z) => z.id !== id);
  }
}
