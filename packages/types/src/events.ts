export type EventType =
  | 'session:phase_change'
  | 'session:flag_yellow'
  | 'session:flag_green'
  | 'session:flag_checkered'
  | 'session:safety_car_deployed'
  | 'session:safety_car_cleared'
  | 'hero:pit_entry'
  | 'hero:pit_exit'
  | 'hero:position_change'
  | 'hero:incident'
  | 'hero:blue_flag'
  | 'hero:fuel_critical'
  | 'hero:pit_window_open'
  | 'hero:pace_degradation'
  | 'competitor:pit_entry'
  | 'competitor:pit_exit'
  | 'competitor:position_change'
  | 'gap:closing'
  | 'gap:battle'
  | 'gap:resolved'
  | 'gap:pulling_away'
  | 'source:upgraded';

export interface RaceEvent {
  type: EventType;
  sessionId: string;
  sessionTime: number;
  lapNumber: number;
  lapDistPct: number;
  payload: Record<string, unknown>;
}
