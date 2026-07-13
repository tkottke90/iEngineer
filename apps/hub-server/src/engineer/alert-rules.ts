import type {
  RaceEvent,
  RaceState,
  CarState,
  HeroState,
  QueuedAlert,
  EngineerConfig,
  AlertEventType,
} from '@iracing-engineer/types';
import { dedupKeyFor } from './dedup-tracker.js';
import { logger } from '../logger.js';

function makeAlert(
  tier: 1 | 2, // rule-based alerts only — Tier 3 is LLM-synthesized (QueuedTier3)
  eventType: AlertEventType,
  messageText: string,
  event: RaceEvent,
  scope?: string,
): QueuedAlert {
  return {
    tier,
    eventType,
    messageText,
    lapNumber: event.lapNumber,
    sessionTime: event.sessionTime,
    dedupKey: dedupKeyFor(eventType, event.lapNumber, scope),
  };
}

type SkipReason = 'relevance' | 'identity-unresolved' | 'no-hero' | 'invalid-signal';

// FR-012: a rule returning null is a decision — it must say why (no silent failures).
function skip(alertType: AlertEventType, reason: SkipReason, carIdx?: number): null {
  logger.info('[engineer] Alert skipped', {
    component: 'engineer',
    event: 'alert_skipped',
    alertType,
    ...(carIdx !== undefined ? { carIdx } : {}),
    reason,
  });
  return null;
}

// Relevance window (contract §Relevance window (T2-02/03), research.md R4): same
// class and within ±range class positions. Degenerate class data on either car
// (carClassId ≤ 0 or classPosition ≤ 0 — single-class sessions, incomplete
// session YAML) falls back to overall position for both the test and the
// announced position.
function competitorRelevance(
  hero: HeroState,
  competitor: CarState,
  range: number,
): { relevant: boolean; pos: number } {
  const classValid =
    hero.carClassId > 0 &&
    competitor.carClassId > 0 &&
    hero.classPosition > 0 &&
    competitor.classPosition > 0;
  if (classValid) {
    return {
      relevant:
        competitor.carClassId === hero.carClassId &&
        Math.abs(competitor.classPosition - hero.classPosition) <= range,
      pos: competitor.classPosition,
    };
  }
  return {
    relevant: Math.abs(competitor.position - hero.position) <= range,
    pos: competitor.position,
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
  state: RaceState,
  config: EngineerConfig,
): QueuedAlert | null {
  switch (event.type) {
    case 'hero:pit_window_open':
      // T2-01
      if (state.signals.pitWindowOpen !== true) return null;
      return makeAlert(
        2,
        'hero:pit_window_open',
        'Pit window is open — you can box this lap',
        event,
      );

    // T2-02 / T2-03 — competitor pit awareness (007 FR-001/FR-002). Identity
    // and position resolve from live RaceState at trigger time (research.md R6).
    case 'competitor:pit_entry':
    case 'competitor:pit_exit': {
      const alertType = event.type;
      if (!state.hero) return skip(alertType, 'no-hero');
      const carIdx = event.payload.carIdx;
      const competitor = typeof carIdx === 'number' ? state.field[carIdx] : undefined;
      if (!competitor || !competitor.carNumber) {
        return skip(
          alertType,
          'identity-unresolved',
          typeof carIdx === 'number' ? carIdx : undefined,
        );
      }
      const { relevant, pos } = competitorRelevance(
        state.hero,
        competitor,
        config.relevantPositionRange,
      );
      if (!relevant) return skip(alertType, 'relevance', competitor.carIdx);
      const messageText =
        alertType === 'competitor:pit_entry'
          ? `Car ${competitor.carNumber} pitting from P${pos}`
          : `Car ${competitor.carNumber} out of pits, P${pos}`;
      return makeAlert(2, alertType, messageText, event, String(competitor.carIdx));
    }

    // T2-04 / T2-05 (gap:closing / gap:pulling_away) are OWNED by the
    // GapAlertMonitor (state-driven, contract §Compatibility notes) — the
    // events remain on the bus for other consumers but are not alert
    // candidates here.

    // T2-06 — pace degradation (007 FR-008). The event is already
    // transition-gated upstream (research.md R5); dedup is per level per
    // stint, cleared by hero:pit_exit in racing-engineer.ts.
    case 'hero:pace_degradation': {
      const signal = event.payload.signal;
      if (signal === 'watch') {
        return makeAlert(
          2,
          'hero:pace_degradation',
          'Pace dropping — tires starting to go off',
          event,
          'watch',
        );
      }
      if (signal === 'critical') {
        // trend = rolling-window pace loss in seconds (last lap vs. first lap
        // of the window) — NOT delta-to-best, hence the "early pace" wording.
        const trend = typeof event.payload.trend === 'number' ? event.payload.trend : 0;
        return makeAlert(
          2,
          'hero:pace_degradation',
          `Pace critical — tires are done, ${trend.toFixed(1)} seconds off your early pace`,
          event,
          'critical',
        );
      }
      // Defensive — unreachable via the current pipeline, but FR-012 forbids
      // a silent null.
      return skip('hero:pace_degradation', 'invalid-signal');
    }

    default:
      return null;
  }
}
