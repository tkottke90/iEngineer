export const SessionFlags = {
  checkered: 0x0001,
  white: 0x0002,
  green: 0x0004,
  yellow: 0x0008,
  red: 0x0010,
  blue: 0x0020,
  debris: 0x0040,
  crossed: 0x0080,
  yellowWaving: 0x0100,
  oneLapToGreen: 0x0200,
  greenHeld: 0x0400,
  tenToGo: 0x0800,
  fiveToGo: 0x1000,
  randomWaving: 0x2000,
  caution: 0x4000,
  cautionWaving: 0x8000,
  disqualify: 0x10000,
  servicible: 0x20000,
  furled: 0x40000,
  repair: 0x80000,
  startHidden: 0x10000000,
  startReady: 0x20000000,
  startSet: 0x40000000,
  startGo: 0x80000000,
} as const;

export type SessionFlagKey = keyof typeof SessionFlags;

export interface WeatherState {
  tempCelsius: number;
  humidity: number;
  windSpeedMs: number;
  skies: string;
}

export interface SessionState {
  sessionId: string;
  trackName: string;
  trackLengthMeters: number;
  sessionType: string;
  sessionPhase: import("./telemetry.js").SessionPhase;
  lapsTotal: number | null;
  lapsRemaining: number | null;
  timeRemaining: number | null;
  flags: number;
  weather: WeatherState;
  sessionStartWallClock: number;
}

export interface CarState {
  carIdx: number;
  driverName: string;
  carNumber: string;
  teamName: string;
  carClassId: number;
  lapDistPct: number;
  trackSurface: number;
  position: number;
  classPosition: number;
  lapCompleted: number;
  lastLapTime: number;
  bestLapTime: number;
  estimatedLapTime: number;
  gapToLeader: number;
  onPitRoad: boolean;
  tireCompound: string;
  fastRepairsUsed: number;
  pitEntryTime: number | null;
  pitExitTime: number | null;
  lastPitLap: number | null;
  lapsSinceLastPit: number | null;
}

export interface HeroState extends CarState {
  fuelLevel: number;
  fuelUsePerHour: number;
  brake: number;
  throttle: number;
  latAccel: number;
  longAccel: number;
  speed: number;
  gear: number;
  waterTemp: number;
  oilTemp: number;
  incidentCount: number;
  lapDeltaToBest: number;
  lapCurrentTime: number;
  safeWindowOpen: boolean;
}

export interface ActiveBattle {
  leadCarIdx: number;
  trailCarIdx: number;
}

export interface DerivedSignals {
  safeWindowOpen: boolean;
  cutWindowOpen: boolean;
  activeBattles: ActiveBattle[];
}

export interface RaceState {
  session: SessionState;
  field: Record<number, CarState>;
  hero: HeroState | null;
  signals: DerivedSignals;
}
