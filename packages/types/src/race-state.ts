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

// Sky state mapped from iRacing's 0–3 `Skies` enum; out-of-range → 'Clear'.
export type SkyState = 'Clear' | 'PartlyCloudy' | 'MostlyCloudy' | 'Overcast';

// Live sim weather (007 US4 / FR-015). Consumed by out-of-repo stream
// overlays via GET /api/race-state — these doc comments are the overlay's
// only unit contract, so every field states units/range/convention.
export interface WeatherState {
  /** AIR temperature, °C (iRacing `AirTemp`). */
  tempCelsius: number;
  /** Track surface temperature, °C (`TrackTempCrew`). */
  trackTempCelsius: number;
  /** Relative humidity, 0–1 (`RelativeHumidity`). */
  humidity: number;
  /** Wind speed, m/s (`WindVel`). */
  windSpeedMs: number;
  /**
   * Wind direction, radians (`WindDir`). From/to convention is the iRacing
   * SDK's — confirm against the SDK var description + in-sim wind display
   * during the 007 T025 Windows check and update this comment.
   */
  windDirRad: number;
  /** Sky state (see SkyState). */
  skies: SkyState;
  /** Precipitation intensity, 0–1 (`Precipitation`). */
  precipitation: number;
  /** Fog level, 0–1 (`FogLevel`). */
  fogLevel: number;
}

export interface SessionState {
  sessionId: string;
  trackName: string;
  trackLengthMeters: number;
  sessionType: string;
  sessionPhase: import('./telemetry.js').SessionPhase;
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
  estimatedPitDuration: number | null;
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
  pitWindowOpen: boolean;
}

export interface RaceState {
  session: SessionState;
  field: Record<number, CarState>;
  hero: HeroState | null;
  signals: DerivedSignals;
}
