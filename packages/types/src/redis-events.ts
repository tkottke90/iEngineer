export interface ConnectionEvent {
  status: 'Connected' | 'Disconnected';
  ts: number; // Unix epoch milliseconds
}

export interface SessionEvent {
  active: boolean;
  ts: number; // Unix epoch milliseconds
  track_name?: string;
  player_car_name?: string;
  player_car_idx?: number;
  session_type?: string;
  wall_clock_time?: string;
}

export function isConnectionEvent(v: unknown): v is ConnectionEvent {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    (obj['status'] === 'Connected' || obj['status'] === 'Disconnected') &&
    typeof obj['ts'] === 'number'
  );
}

export function isSessionEvent(v: unknown): v is SessionEvent {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj['active'] !== 'boolean') return false;
  if (typeof obj['ts'] !== 'number') return false;
  if (obj['active']) {
    // When active=true, all detail fields must be present and correct types
    if (typeof obj['track_name'] !== 'string') return false;
    if (typeof obj['player_car_name'] !== 'string') return false;
    if (typeof obj['player_car_idx'] !== 'number') return false;
    if (typeof obj['session_type'] !== 'string') return false;
    if (typeof obj['wall_clock_time'] !== 'string') return false;
  }
  return true;
}
