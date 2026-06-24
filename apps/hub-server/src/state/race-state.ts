import type { Redis } from "ioredis";
import type {
  RaceState,
  SessionState,
  CarState,
  HeroState,
  DerivedSignals,
} from "@iracing-engineer/types";

const DEFAULT_STATE: RaceState = {
  session: {
    sessionId: "",
    trackName: "",
    trackLengthMeters: 0,
    sessionType: "",
    sessionPhase: "PreSession",
    lapsTotal: null,
    lapsRemaining: null,
    timeRemaining: null,
    flags: 0,
    weather: { tempCelsius: 0, humidity: 0, windSpeedMs: 0, skies: "" },
    sessionStartWallClock: 0,
  },
  field: {},
  hero: null,
  signals: { safeWindowOpen: false, cutWindowOpen: false, activeBattles: [] },
};

export class RaceStateManager {
  private state: RaceState = structuredClone(DEFAULT_STATE);

  constructor(private readonly redis: Redis) {}

  getState(): RaceState {
    return this.state;
  }

  updateSession(patch: Partial<SessionState>): void {
    Object.assign(this.state.session, patch);
  }

  updateCar(carIdx: number, patch: Partial<CarState>): void {
    this.state.field[carIdx] = { ...this.state.field[carIdx], ...patch } as CarState;
  }

  updateHero(patch: Partial<HeroState>): void {
    if (this.state.hero) {
      Object.assign(this.state.hero, patch);
    } else {
      this.state.hero = patch as HeroState;
    }
  }

  updateSignals(patch: Partial<DerivedSignals>): void {
    Object.assign(this.state.signals, patch);
  }

  async snapshot(): Promise<void> {
    const key = `race_state:${this.state.session.sessionId}`;
    await this.redis.set(key, JSON.stringify(this.state), "EX", 7200);
  }

  async restore(sessionId: string): Promise<void> {
    const key = `race_state:${sessionId}`;
    const raw = await this.redis.get(key);
    if (raw) {
      this.state = JSON.parse(raw) as RaceState;
    }
  }
}
