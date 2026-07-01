import type { QueuedAlert, RadioBlackoutZone } from '@iracing-engineer/types';
import { logger } from '../logger.js';

// Tier 2 alert is dropped if it cannot be delivered within this window because
// no safe window was found (FR-017).
const NO_SAFE_WINDOW_TIMEOUT_MS = 30_000;

/**
 * A lapDistPct is a safe window when it falls OUTSIDE every blackout zone.
 * Zone boundaries are INCLUSIVE on both ends — do not switch to exclusive
 * bounds without updating T015's boundary tests.
 */
export function isSafeWindow(lapDistPct: number, zones: RadioBlackoutZone[]): boolean {
  return !zones.some(
    (z) => lapDistPct >= z.lapDistPctStart && lapDistPct <= z.lapDistPctEnd,
  );
}

/**
 * In-process priority queue. Tier 1 alerts dequeue before Tier 2 and bypass the
 * safe-window gate; Tier 2 alerts are held until a safe window and dropped after
 * 30s if none is found.
 */
export class PriorityMessageQueue {
  private tier1: QueuedAlert[] = [];
  private tier2: QueuedAlert[] = [];
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  enqueue(alert: QueuedAlert): void {
    if (alert.tier === 1) {
      this.tier1.push(alert);
    } else {
      this.tier2.push({ ...alert, enqueuedAt: this.now() });
    }
  }

  /**
   * Return the next eligible alert, or null. Tier 1 always dequeues (FIFO). Tier 2
   * dequeues only inside a safe window; while gated, any Tier 2 alert older than
   * 30s is dropped with a structured warning (FR-017).
   */
  dequeueNext(lapDistPct: number, zones: RadioBlackoutZone[]): QueuedAlert | null {
    if (this.tier1.length > 0) {
      return this.tier1.shift() ?? null;
    }

    const safe = isSafeWindow(lapDistPct, zones);
    while (this.tier2.length > 0) {
      const head = this.tier2[0];
      if (safe) {
        return this.tier2.shift() ?? null;
      }
      // Gated: drop stale Tier 2 alerts, then stop (still not safe).
      if (this.now() - (head.enqueuedAt ?? this.now()) >= NO_SAFE_WINDOW_TIMEOUT_MS) {
        this.tier2.shift();
        logger.warn('[engineer] Tier 2 alert dropped — no safe window within 30s', {
          alertType: head.eventType,
          enqueuedAt: head.enqueuedAt,
        });
        continue;
      }
      break;
    }
    return null;
  }

  get length(): number {
    return this.tier1.length + this.tier2.length;
  }
}
