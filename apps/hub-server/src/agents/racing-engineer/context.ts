import type { RaceState, CarState } from "@iracing-engineer/types";

export interface SessionHistory {
  overridesThisSession: number;
  lastOverrideDescription: string | null;
  significantMoments: string[];
}

export interface FieldEntry {
  carIdx: number;
  driverName: string;
  position: number;
  gapToLeader: number;
  onPitRoad: boolean;
  lastLapTime: number;
}

export interface LLMContext {
  session: {
    track: string;
    sessionType: string;
    lapsRemaining: number | null;
    timeRemaining: number | null;
    sessionPhase: string;
    activeFlags: number;
  };
  hero: {
    position: number;
    classPosition: number;
    lapCompleted: number;
    lastLapTime: number;
    lapDeltaToBest: number;
    incidentCount: number;
    fuelSummary: string;
    tireSummary: string;
    lapsSinceLastPit: number | null;
    pitWindowOpen: boolean;
  };
  field: FieldEntry[];
  recentEvents: Array<{ type: string; sessionTime: number; summary: string }>;
  sessionHistory: SessionHistory;
}

export function assembleContext(state: RaceState, history: SessionHistory): LLMContext {
  const { session, hero, field } = state;
  const fieldEntries = Object.values(field);
  const heroPos = hero?.position ?? 0;

  const neighbors = fieldEntries
    .filter((c) => Math.abs(c.position - heroPos) <= 3 || c.position === 1)
    .slice(0, 12)
    .map((c) => ({
      carIdx: c.carIdx,
      driverName: c.driverName,
      position: c.position,
      gapToLeader: c.gapToLeader,
      onPitRoad: c.onPitRoad,
      lastLapTime: c.lastLapTime,
    }));

  return {
    session: {
      track: session.trackName,
      sessionType: session.sessionType,
      lapsRemaining: session.lapsRemaining,
      timeRemaining: session.timeRemaining,
      sessionPhase: session.sessionPhase,
      activeFlags: session.flags,
    },
    hero: {
      position: hero?.position ?? 0,
      classPosition: hero?.classPosition ?? 0,
      lapCompleted: hero?.lapCompleted ?? 0,
      lastLapTime: hero?.lastLapTime ?? 0,
      lapDeltaToBest: hero?.lapDeltaToBest ?? 0,
      incidentCount: hero?.incidentCount ?? 0,
      fuelSummary: `${hero?.fuelLevel?.toFixed(1) ?? "?"}L remaining`,
      tireSummary: `${hero?.tireCompound ?? "?"} — ${hero?.lapCompleted ?? 0} laps old`,
      lapsSinceLastPit: hero?.lapsSinceLastPit ?? null,
      pitWindowOpen: false, // TODO: derive from FuelModel
    },
    field: neighbors,
    recentEvents: [],
    sessionHistory: history,
  };
}

export function truncateContext(ctx: LLMContext): LLMContext {
  return {
    ...ctx,
    sessionHistory: {
      ...ctx.sessionHistory,
      significantMoments: ctx.sessionHistory.significantMoments.slice(0, 2),
    },
    recentEvents: ctx.recentEvents.slice(0, 3),
    field: ctx.field.filter((c) => Math.abs(c.position - ctx.hero.position) <= 1 || c.position === 1),
    hero: { ...ctx.hero, tireSummary: ctx.hero.tireSummary.split("—")[0].trim() },
  };
}
