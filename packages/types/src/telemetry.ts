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
