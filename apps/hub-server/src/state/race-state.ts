import type Redis from 'ioredis';
import type { RaceState, SessionState, CarState, HeroState, DerivedSignals, WeatherState } from '@iracing-engineer/types';

const state: RaceState = {
  session: null as unknown as SessionState,
  field: {},
  hero: null,
  signals: {
    safeWindowOpen: false,
    cutWindowOpen: false,
    pitWindowOpen: false,
    activeBattles: [],
  },
};

export function setSession(session: SessionState): void {
  state.session = session;
}

export function updateCarState(carIdx: number, update: Partial<CarState>): void {
  state.field[carIdx] = { ...state.field[carIdx], ...update } as CarState;
}

export function setHeroState(hero: HeroState | null): void {
  state.hero = hero;
}

export function updateSignals(signals: Partial<DerivedSignals>): void {
  state.signals = { ...state.signals, ...signals };
}

// 007 US4 (FR-015/FR-016): merge live weather into the session. Partial by
// design — a frame updates exactly the fields it carries; absent fields keep
// their previous values (per-field no-regress guard).
export function updateWeather(update: Partial<WeatherState>): void {
  if (!state.session) return;
  state.session.weather = { ...state.session.weather, ...update };
}

export function getSnapshot(): RaceState {
  return state;
}

export async function writeKvSnapshot(commandConn: Redis, sessionId: string): Promise<void> {
  const json = JSON.stringify(state);
  await Promise.all([
    commandConn.setex(`hub:race-state:${sessionId}`, 7200, json),
    commandConn.setex('hub:race-state:latest', 7200, json),
  ]);
}
