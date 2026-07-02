import type { AlertEventType } from '@iracing-engineer/types';

// Per-lap alerts get a fresh dedup key every lap so they re-enable automatically
// (no discrete "cleared" event). All other alerts are event-cleared: keyed on
// eventType only, suppressed across laps until recordCleared() (FR-006).
const PER_LAP_ALERTS: Set<AlertEventType> = new Set(['hero:fuel_critical']);

/**
 * Compute the dedup key for an alert per the FR-006 two-strategy scheme.
 * Shared by the DedupTracker and the alert rules so both agree on the key.
 */
export function dedupKeyFor(eventType: AlertEventType, lapNumber: number): string {
  return PER_LAP_ALERTS.has(eventType) ? `${eventType}:${lapNumber}` : `${eventType}`;
}

/**
 * In-process deduplication tracker (hero-only in M4). Presence of a key = the
 * alert already fired and should be suppressed; absence = it may fire.
 */
export class DedupTracker {
  private fired = new Set<string>();

  /** True if the alert has NOT yet fired for its current dedup key. */
  shouldFire(eventType: AlertEventType, lapNumber: number): boolean {
    return !this.fired.has(dedupKeyFor(eventType, lapNumber));
  }

  recordFired(eventType: AlertEventType, lapNumber: number): void {
    this.fired.add(dedupKeyFor(eventType, lapNumber));
  }

  /**
   * Remove ALL entries for an event type (both `eventType` and any
   * `eventType:lap` variants). A same-lap re-fire is then permitted if the
   * condition re-triggers.
   */
  recordCleared(eventType: AlertEventType): void {
    for (const key of this.fired) {
      if (key === eventType || key.startsWith(`${eventType}:`)) {
        this.fired.delete(key);
      }
    }
  }
}
