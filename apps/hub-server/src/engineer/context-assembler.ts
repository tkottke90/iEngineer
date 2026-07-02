import type { RaceState, SessionMemory, ReasoningContext } from '@iracing-engineer/types';
import { logger } from '../logger.js';

// Cheap token estimate (~4 chars/token) — no tokenizer dependency (research R5).
function estimateTokens(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

/**
 * Assemble a structured reasoning context from the race-state snapshot and
 * session memory, within `tokenBudget` (FR-011/012). When over budget, apply the
 * fixed field-priority truncation order from data-model.md (drop lowest-priority,
 * oldest first) and never drop the core (current fuel/tire summary, position,
 * session/flag state). Emits a `context-truncated` log when truncation occurs.
 */
export function assembleContext(
  raceState: RaceState,
  memory: SessionMemory,
  tokenBudget: number,
): ReasoningContext {
  const hero = raceState.hero;

  // Core — never dropped.
  const core = {
    session: {
      phase: raceState.session.sessionPhase,
      lapsRemaining: raceState.session.lapsRemaining,
      flags: raceState.session.flags,
    },
    hero: hero
      ? {
          position: hero.position,
          lapDistPct: Number(hero.lapDistPct.toFixed(3)),
          fuelLevel: Number(hero.fuelLevel.toFixed(1)),
          tireCompound: hero.tireCompound,
          lastLapTime: hero.lastLapTime,
          onPitRoad: hero.onPitRoad,
        }
      : null,
    signals: {
      pitWindowOpen: raceState.signals.pitWindowOpen,
      safeWindowOpen: raceState.signals.safeWindowOpen,
    },
  };

  // Optional layers, dropped in this order when over budget.
  let recommendations = memory.recommendations;
  let fuelCalibration = memory.fuelCalibration;
  let heroExtra: Record<string, unknown> | null = hero
    ? {
        fuelUsePerHour: Number(hero.fuelUsePerHour.toFixed(2)),
        lapDeltaToBest: hero.lapDeltaToBest,
        gapToLeader: hero.gapToLeader,
        waterTemp: hero.waterTemp,
        oilTemp: hero.oilTemp,
      }
    : null;

  const build = (): ReasoningContext => {
    const raceStateSummary = { ...core, heroExtra };
    const memoryExcerpt = { recommendations, deference: memory.deference, fuelCalibration };
    return {
      raceState: raceStateSummary as unknown as Record<string, unknown>,
      memoryExcerpt: memoryExcerpt as unknown as Record<string, unknown>,
      estimatedTokens: estimateTokens({ raceStateSummary, memoryExcerpt }),
      truncated: false,
    };
  };

  // Priority-ordered drops (index 0 = dropped first): older recs → calibration
  // detail → verbose telemetry → keep only the latest rec.
  const drops: Array<() => void> = [
    () => {
      recommendations = recommendations.slice(-5);
    },
    () => {
      fuelCalibration = fuelCalibration ? { note: 'calibration present (detail truncated)' } : null;
    },
    () => {
      heroExtra = null;
    },
    () => {
      recommendations = recommendations.slice(-1);
    },
  ];

  let ctx = build();
  let truncated = false;
  for (const drop of drops) {
    if (ctx.estimatedTokens <= tokenBudget) break;
    drop();
    truncated = true;
    ctx = build();
  }

  if (truncated) {
    logger.info('[engineer] context truncated to fit token budget', {
      reason: 'context-truncated',
      estimatedTokens: ctx.estimatedTokens,
      tokenBudget,
    });
  }

  return { ...ctx, truncated };
}
