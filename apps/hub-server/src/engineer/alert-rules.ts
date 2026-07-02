import type {
  RaceEvent,
  DerivedSignals,
  QueuedAlert,
  EngineerConfig,
  AlertEventType,
  AlertTier,
} from '@iracing-engineer/types';
import { dedupKeyFor } from './dedup-tracker.js';

function makeAlert(
  tier: AlertTier,
  eventType: AlertEventType,
  messageText: string,
  event: RaceEvent,
): QueuedAlert {
  return {
    tier,
    eventType,
    messageText,
    lapNumber: event.lapNumber,
    sessionTime: event.sessionTime,
    dedupKey: dedupKeyFor(eventType, event.lapNumber),
  };
}

/**
 * Tier 1 rules — gate-override, immediate delivery.
 * T1-01 fuel critical, T1-02 blue flag, T1-03 safety car, T1-04 pit limiter.
 */
export function evaluateTier1(event: RaceEvent, config: EngineerConfig): QueuedAlert | null {
  switch (event.type) {
    case 'hero:fuel_critical': {
      // T1-01: the M3 fuel model already computed lapsRemaining (a rolling
      // per-lap burn average). The engineer does NO fuel math here — it reads
      // the value and applies a configurable threshold (FR-014).
      const lapsRemaining = event.payload.lapsRemaining;
      if (typeof lapsRemaining !== 'number' || !Number.isFinite(lapsRemaining)) return null;
      if (lapsRemaining > config.fuelCriticalLapsRemaining) return null;
      const rounded = Math.round(lapsRemaining * 10) / 10;
      return makeAlert(1, 'hero:fuel_critical', `Fuel critical — ${rounded} laps remaining`, event);
    }
    case 'hero:blue_flag':
      // T1-02
      return makeAlert(1, 'hero:blue_flag', 'Blue flag — let them by', event);
    case 'session:safety_car_deployed':
      // T1-03
      return makeAlert(
        1,
        'session:safety_car_deployed',
        'Safety car deployed — hold position',
        event,
      );
    case 'hero:pit_limiter_active':
      // T1-04: only the active=true transition produces an alert; active=false
      // is a dedup-clear signal handled in racing-engineer.ts (T033).
      if (event.payload.active !== true) return null;
      return makeAlert(1, 'hero:pit_limiter_active', 'Pit limiter active', event);
    default:
      return null;
  }
}

/**
 * Tier 2 rules — safe-window gated.
 * T2-01 pit window open (active in M4). T2-02–T2-06 are M5 stubs.
 */
export function evaluateTier2(
  event: RaceEvent,
  signals: DerivedSignals,
  _config: EngineerConfig,
): QueuedAlert | null {
  switch (event.type) {
    case 'hero:pit_window_open':
      // T2-01
      if (signals.pitWindowOpen !== true) return null;
      return makeAlert(
        2,
        'hero:pit_window_open',
        'Pit window is open — you can box this lap',
        event,
      );

    // ── M5 stubs — return null, no logic in M4 (FR-003 / YAGNI) ──
    case 'competitor:pit_entry': // T2-02 TODO M5
      return null;
    case 'competitor:pit_exit': // T2-03 TODO M5
      return null;
    case 'gap:closing': // T2-04 TODO M5
      return null;
    case 'gap:pulling_away': // T2-05 TODO M5
      return null;
    case 'hero:pace_degradation': // T2-06 TODO M5
      return null;

    default:
      return null;
  }
}
