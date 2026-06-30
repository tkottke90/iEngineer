export type FuelDataSource = 'live' | 'blended' | 'estimated';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface FuelModel {
  burnRatePerLap: number;
  burnRateConfidence: number;
  fuelRemaining: number;
  lapsRemaining: number | null;
  fuelToFinish: number;
  fuelDeficit: number;
  confidenceLevel: ConfidenceLevel;
  dataSource: FuelDataSource;
  lapsSinceCalibration: number;
  summary: string;
  timeRemaining: number | null;
}

export type DegradationSignal = 'nominal' | 'watch' | 'critical';

export interface TireModel {
  compound: string;
  lapAge: number;
  setsRemaining: number;
  paceDegradationTrend: number;
  degradationSignal: DegradationSignal;
  degradationConfidence: ConfidenceLevel;
}

export type BattleStatus = 'open' | 'closing' | 'battle' | 'resolved';

export interface GapModel {
  leadCarIdx: number;
  trailCarIdx: number;
  gapSeconds: number;
  gapTrend: number;
  closingRate: number;
  lapsToContact: number | null;
  battleStatus: BattleStatus;
}
