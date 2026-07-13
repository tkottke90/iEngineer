import type { AlertEventType } from '@iracing-engineer/types';

// Per-lap alerts get a fresh dedup key every lap so they re-enable automatically
// (no discrete "cleared" event). All other alerts are event-cleared: keyed on
// eventType only, suppressed across laps until recordCleared() (FR-006).
const PER_LAP_ALERTS: Set<AlertEventType> = new Set(['hero:fuel_critical']);

// Scoped-event-cleared alerts (007, data-model.md): keyed on `eventType:scope`
// so one car's pit visit (scope = carIdx) or one degradation level (scope =
// watch | critical) dedups independently. Cleared per scope or all-at-once.
const SCOPED_ALERTS: Set<AlertEventType> = new Set([
  'competitor:pit_entry',
  'competitor:pit_exit',
  'hero:pace_degradation',
]);

/**
 * Compute the dedup key for an alert per the two-strategy scheme (004 FR-006)
 * extended with the scoped strategy (007). Shared by the DedupTracker and the
 * alert rules so both agree on the key.
 */
export function dedupKeyFor(eventType: AlertEventType, lapNumber: number, scope?: string): string {
  if (scope !== undefined && SCOPED_ALERTS.has(eventType)) return `${eventType}:${scope}`;
  return PER_LAP_ALERTS.has(eventType) ? `${eventType}:${lapNumber}` : `${eventType}`;
}

/**
 * In-process deduplication tracker. Presence of a key = the alert already
 * fired and should be suppressed; absence = it may fire.
 */
export class DedupTracker {
  private fired = new Set<string>();

  /** True if the alert has NOT yet fired for its current dedup key. */
  shouldFire(eventType: AlertEventType, lapNumber: number, scope?: string): boolean {
    return !this.fired.has(dedupKeyFor(eventType, lapNumber, scope));
  }

  recordFired(eventType: AlertEventType, lapNumber: number, scope?: string): void {
    this.fired.add(dedupKeyFor(eventType, lapNumber, scope));
  }

  /**
   * With a scope: remove only that `eventType:scope` key (one car / one level).
   * Without: remove ALL entries for the event type (both `eventType` and any
   * `eventType:*` variants). A same-lap re-fire is then permitted if the
   * condition re-triggers.
   */
  recordCleared(eventType: AlertEventType, scope?: string): void {
    if (scope !== undefined) {
      this.fired.delete(`${eventType}:${scope}`);
      return;
    }
    for (const key of this.fired) {
      if (key === eventType || key.startsWith(`${eventType}:`)) {
        this.fired.delete(key);
      }
    }
  }
}
