export enum ShotTier {
  IMMEDIATE = 0,
  EVENT_DRIVEN = 1,
  AMBIENT = 2,
}

export interface ShotRequest {
  scene: string;
  cameraName: string;
  reason: string;
  tier: ShotTier;
}

interface QueuedShot extends ShotRequest {
  enqueuedAt: number;
}

const TIER2_FORCE_AFTER_MS = 30_000;

export class ShotQueue {
  private queues: QueuedShot[][] = [[], [], []];

  enqueue(shot: ShotRequest): void {
    this.queues[shot.tier].push({ ...shot, enqueuedAt: Date.now() });
  }

  processNext(cutWindowOpen: boolean, timeSinceLastCutSeconds: number): ShotRequest | null {
    // Tier 1: always execute immediately
    if (this.queues[ShotTier.IMMEDIATE].length > 0) {
      return this.dequeue(ShotTier.IMMEDIATE);
    }
    // Tier 2: execute on cut window, or force after 30s staleness
    if (this.queues[ShotTier.EVENT_DRIVEN].length > 0) {
      const oldest = this.queues[ShotTier.EVENT_DRIVEN][0];
      const stale = Date.now() - oldest.enqueuedAt > TIER2_FORCE_AFTER_MS;
      if (cutWindowOpen || stale) {
        return this.dequeue(ShotTier.EVENT_DRIVEN);
      }
    }
    // Tier 3: ambient continuity work
    if (cutWindowOpen && this.queues[ShotTier.AMBIENT].length > 0) {
      return this.dequeue(ShotTier.AMBIENT);
    }
    return null;
  }

  private dequeue(tier: ShotTier): QueuedShot {
    return this.queues[tier].shift()!;
  }
}
