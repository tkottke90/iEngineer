import type Redis from 'ioredis';
import type { RaceEvent, EventType } from '@iracing-engineer/types';
import { logger } from '../logger.js';

// Allowlist of all valid event types (used for schema validation stub per T027)
export const VALID_EVENT_TYPES: Set<EventType> = new Set([
  'session:phase_change',
  'session:flag_yellow',
  'session:flag_green',
  'session:flag_checkered',
  'session:safety_car_deployed',
  'session:safety_car_cleared',
  'hero:pit_entry',
  'hero:pit_exit',
  'hero:position_change',
  'hero:incident',
  'hero:blue_flag',
  'hero:blue_flag_cleared',
  'hero:fuel_critical',
  'hero:pit_limiter_active',
  'hero:pit_window_open',
  'hero:pace_degradation',
  'competitor:pit_entry',
  'competitor:pit_exit',
  'competitor:position_change',
  'gap:closing',
  'gap:battle',
  'gap:resolved',
  'gap:pulling_away',
  'source:upgraded',
]);

export async function publishEvent(
  event: RaceEvent,
  commandConn: Redis,
  sessionId: string,
  detectedAtMs: number,
): Promise<void> {
  const emitLatencyMs = Date.now() - detectedAtMs;
  const json = JSON.stringify(event);
  const ringKey = `hub:events:ring:${sessionId}`;

  await Promise.all([
    commandConn.publish('hub:events', json),
    commandConn.lpush(ringKey, json).then(() =>
      commandConn.ltrim(ringKey, 0, 99)
    ).then(() =>
      commandConn.expire(ringKey, 7200)
    ),
  ]);

  logger.info('[hub] Event published', {
    type: event.type,
    sessionId,
    sessionTime: event.sessionTime,
    emitLatencyMs,
  });
}
