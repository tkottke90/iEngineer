import type {
  QueuedAlert,
  QueuedTier3,
  QueuedMessage,
  RadioBlackoutZone,
} from '@iracing-engineer/types';
import { logger } from '../logger.js';

// Tier 2 alert is dropped if it cannot be delivered within this window because
// no safe window was found (FR-017).
const NO_SAFE_WINDOW_TIMEOUT_MS = 30_000;

// Alert types coalescible at dequeue time (007 FR-014): same-kind competitor
// pit alerts pending together merge into one announcement.
const COALESCIBLE = new Set<QueuedAlert['eventType']>([
  'competitor:pit_entry',
  'competitor:pit_exit',
]);

// The single templates are canonical (contract §Canonical spoken-text
// templates), so the car number is recoverable from the rendered text —
// keeping QueuedAlert's shape unchanged (data-model.md §Coalescing).
function carNumberOf(alert: QueuedAlert): string {
  const m = /^Car (\S+) /.exec(alert.messageText);
  return m ? m[1] : '?';
}

function coalescedText(eventType: QueuedAlert['eventType'], carNumbers: string[]): string {
  if (eventType === 'competitor:pit_entry') {
    return carNumbers.length === 2
      ? `Cars ${carNumbers[0]} and ${carNumbers[1]} are pitting`
      : `${carNumbers.length} cars around you are pitting`;
  }
  return carNumbers.length === 2
    ? `Cars ${carNumbers[0]} and ${carNumbers[1]} back out of the pits`
    : `${carNumbers.length} cars back out of the pits`;
}

/**
 * A lapDistPct is a safe window when it falls OUTSIDE every blackout zone.
 * Zone boundaries are INCLUSIVE on both ends — do not switch to exclusive
 * bounds without updating the boundary tests.
 */
export function isSafeWindow(lapDistPct: number, zones: RadioBlackoutZone[]): boolean {
  return !zones.some((z) => lapDistPct >= z.lapDistPctStart && lapDistPct <= z.lapDistPctEnd);
}

/**
 * In-process priority queue. Dispatch order is Tier 1 > Tier 2 > Tier 3 (FR-015):
 * - Tier 1 alerts dequeue first (FIFO) and bypass the safe-window gate.
 * - Tier 2 alerts are held until a safe window and dropped after 30s if none.
 * - Tier 3 (LLM-synthesized) clips dequeue only when no Tier 1/2 are pending, so a
 *   Tier 1 alert arriving mid-answer preempts the still-pending Tier 3 sentences.
 *   Within Tier 3, an on-demand driver-query outranks proactive commentary; ties
 *   break FIFO.
 */
export class PriorityMessageQueue {
  private tier1: QueuedAlert[] = [];
  private tier2: QueuedAlert[] = [];
  private tier3: QueuedTier3[] = [];
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  enqueue(msg: QueuedMessage): void {
    if (msg.tier === 1) {
      this.tier1.push(msg);
    } else if (msg.tier === 2) {
      this.tier2.push({ ...msg, enqueuedAt: this.now() });
    } else {
      this.tier3.push(msg);
    }
  }

  /**
   * Return the next eligible message, or null. Tier 1 always dequeues (FIFO). Tier 2
   * dequeues only inside a safe window; while gated, any Tier 2 alert older than 30s
   * is dropped with a structured warning (FR-017). Tier 3 dequeues only when no Tier
   * 1/2 remain, driver-query first.
   */
  dequeueNext(lapDistPct: number, zones: RadioBlackoutZone[]): QueuedMessage | null {
    if (this.tier1.length > 0) {
      return this.tier1.shift() ?? null;
    }

    const safe = isSafeWindow(lapDistPct, zones);
    while (this.tier2.length > 0) {
      const head = this.tier2[0];
      if (safe) {
        this.tier2.shift();
        return this.coalesce(head);
      }
      if (this.now() - (head.enqueuedAt ?? this.now()) >= NO_SAFE_WINDOW_TIMEOUT_MS) {
        this.tier2.shift();
        logger.warn('[engineer] Tier 2 alert dropped — no safe window within 30s', {
          component: 'engineer',
          event: 'tier2_dropped_no_window',
          alertType: head.eventType,
          enqueuedAt: head.enqueuedAt,
        });
        continue;
      }
      break;
    }
    // Tier 2 still pending but gated → do not release Tier 3 ahead of it.
    if (this.tier2.length > 0) return null;

    // Tier 3 — driver-query outranks proactive commentary; otherwise FIFO.
    if (this.tier3.length > 0) {
      const dqIdx = this.tier3.findIndex((m) => m.tier3Type === 'driver-query');
      const idx = dqIdx >= 0 ? dqIdx : 0;
      return this.tier3.splice(idx, 1)[0] ?? null;
    }
    return null;
  }

  /**
   * Dequeue-time coalescing (007 FR-014, contract §Coalescing contract
   * (FR-014)): when the dequeued Tier 2 head is a competitor pit alert, every
   * other queued Tier 2 alert with the SAME eventType merges into it (entries
   * with entries, exits with exits — never across). The merged alert counts as
   * one dequeued item; head supplies lapNumber/sessionTime. Per-car dedup was
   * recorded at enqueue; alerts already dropped by the 30s gate are gone from
   * the queue and are never resurrected here. The merge happens BEFORE the
   * dispatcher's Energy=1 check, so a suppressed merged alert still leaves the
   * alerts_coalesced log for per-car accounting (SC-005).
   */
  private coalesce(head: QueuedAlert): QueuedAlert {
    if (!COALESCIBLE.has(head.eventType)) return head;
    const merged: QueuedAlert[] = [head];
    this.tier2 = this.tier2.filter((a) => {
      if (a.eventType !== head.eventType) return true;
      merged.push(a);
      return false;
    });
    if (merged.length === 1) return head;
    const carNumbers = merged.map(carNumberOf);
    logger.info('[engineer] Alerts coalesced', {
      component: 'engineer',
      event: 'alerts_coalesced',
      eventType: head.eventType,
      mergedCount: merged.length,
      carNumbers,
    });
    return { ...head, messageText: coalescedText(head.eventType, carNumbers) };
  }

  get length(): number {
    return this.tier1.length + this.tier2.length + this.tier3.length;
  }
}
