export type SessionPhase = 'PreSession' | 'Formation' | 'Racing' | 'Caution' | 'PostRace';

export type TelemetrySource = 'driver' | 'observer';

export interface TelemetryEnvelope {
  sessionId: string;
  sessionTick: number;
  sessionTime: number;
  sessionPhase: SessionPhase;
  source: TelemetrySource;
  data: Record<string, unknown>;
}

export interface LiveTelemetryData {
  brake: number;
  throttle: number;
  latAccel: number;
  longAccel: number;
  speed: number;
  gear: number;
  steeringWheelAngle: number;
  carIdxLapDistPct: number[];
}

export interface SessionTelemetryData {
  // Weather (007 US4/FR-015) — GLOBAL sim vars, present in BOTH driver and
  // observer mode (not hero-gated). Optional: absent on older collector
  // builds; the hub preserves previous values per field (FR-016). On the
  // wire these are the raw SDK names (AirTemp, TrackTempCrew, …).
  airTemp?: number; // °C
  trackTempCrew?: number; // °C
  relativeHumidity?: number; // 0–1
  windVel?: number; // m/s
  windDir?: number; // radians
  skies?: number; // 0–3 enum → SkyState
  precipitation?: number; // 0–1
  fogLevel?: number; // 0–1
  // Per-car indexed arrays (carIdx → value)
  carIdxPosition: number[];
  carIdxClassPosition: number[];
  carIdxLap: number[];
  carIdxLapCompleted: number[];
  carIdxLapDistPct: number[];
  carIdxLastLapTime: number[];
  carIdxBestLapTime: number[];
  carIdxEstTime: number[];
  carIdxF2Time: number[];
  carIdxOnPitRoad: boolean[];
  carIdxTrackSurface: number[];
  carIdxTireCompound: string[];
  carIdxFastRepairsUsed: number[];
  // Hero-only fields (only present when source === "driver")
  fuelLevel?: number;
  fuelUsePerHour?: number;
  waterTemp?: number;
  oilTemp?: number;
  incidentCount?: number;
  lapDeltaToBestLap?: number;
  lapCurrentLapTime?: number;
  playerCarIdx?: number;
  sessionFlags?: number;
  sessionLapsRemain?: number;
  sessionTimeRemain?: number;
}
