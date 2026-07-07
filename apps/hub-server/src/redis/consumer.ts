import type Redis from 'ioredis';
import { logger } from '../logger.js';

const CONSUMER_NAME = 'hub-server-1';

const STREAMS = {
  live: 'iracing:telemetry:live',
  session: 'iracing:telemetry:session',
  sessionEvent: 'iracing:events:session',
} as const;

const GROUPS = {
  live: 'hub:live-processor',
  session: 'hub:session-processor',
  sessionEvent: 'hub:session-event-processor',
  racingEngineer: 'hub:racing-engineer',
  streamEngineer: 'hub:stream-engineer',
} as const;

async function xgroupCreate(redis: Redis, stream: string, group: string): Promise<void> {
  try {
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (err: unknown) {
    // Ignore BUSYGROUP — group already exists
    if (err instanceof Error && err.message.includes('BUSYGROUP')) return;
    throw err;
  }
}

export async function setupConsumerGroups(redis: Redis): Promise<void> {
  await xgroupCreate(redis, STREAMS.live, GROUPS.live);
  await xgroupCreate(redis, STREAMS.session, GROUPS.session);
  await xgroupCreate(redis, STREAMS.sessionEvent, GROUPS.sessionEvent);
  // Downstream groups for M4 and M6 (FR-004)
  await xgroupCreate(redis, STREAMS.session, GROUPS.racingEngineer);
  await xgroupCreate(redis, STREAMS.live, GROUPS.racingEngineer);
  await xgroupCreate(redis, STREAMS.live, GROUPS.streamEngineer);
  logger.info('[hub] Consumer groups created', { groups: Object.values(GROUPS) });
}

export async function reclaimPendingMessages(redis: Redis, idleMs = 30_000): Promise<number> {
  let totalReclaimed = 0;
  const streams = [
    { stream: STREAMS.live, group: GROUPS.live },
    { stream: STREAMS.session, group: GROUPS.session },
    { stream: STREAMS.sessionEvent, group: GROUPS.sessionEvent },
  ];
  for (const { stream, group } of streams) {
    try {
      // XAUTOCLAIM: reclaim messages idle > idleMs
      const result = await (redis as any).xautoclaim(
        stream,
        group,
        CONSUMER_NAME,
        idleMs,
        '0-0',
        'COUNT',
        '100',
      );
      // result is [nextId, entries, deletedIds] or [nextId, entries]
      const entries = Array.isArray(result[1]) ? result[1] : [];
      totalReclaimed += entries.length;
    } catch (err: unknown) {
      // Stream may not exist yet — ignore
      if (err instanceof Error && (err.message.includes('ERR') || err.message.includes('NOGROUP')))
        continue;
      throw err;
    }
  }
  logger.info('[hub] Reclaimed pending messages', { reclaimedCount: totalReclaimed });
  return totalReclaimed;
}

type EntryPayload = string;
type Callback = (payload: EntryPayload, entryId: string) => Promise<void> | void;

// Coerce a Redis stream field value (always a string on the wire) back to the JSON
// type the processors expect — numbers, booleans, arrays like "[1,3,2,4]", or the
// raw string. An empty value (iRacing "Unavailable") becomes null.
function coerceFieldValue(v: string): unknown {
  if (v === '') return null;
  if (v.startsWith('[') && v.endsWith(']')) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

// Two on-wire encodings exist:
//   • Events streams write a single `payload` JSON field (RedisPublisher.publish_event).
//   • Telemetry streams (live/session) write field-per-column (publish_live/publish_session).
// Normalize both to the `payload` JSON string the processors JSON.parse.
export function parseEntries(raw: [string, string[]][]): Array<{ id: string; payload: string }> {
  return raw.map(([id, fields]) => {
    const idx = fields.indexOf('payload');
    if (idx !== -1) {
      return { id, payload: fields[idx + 1] ?? '' };
    }
    // Field-per-column telemetry — reconstruct the tick object.
    const obj: Record<string, unknown> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) {
      obj[fields[i]] = coerceFieldValue(fields[i + 1]);
    }
    return { id, payload: JSON.stringify(obj) };
  });
}

// Redis XREADGROUP requires the same group name on every stream in a single call.
// We use three independent loops (one per stream/group) running concurrently.
export async function streamConsumerLoop(
  consumerConn: Redis,
  commandConn: Redis,
  onLive: Callback,
  onSession: Callback,
  onSessionEvent: Callback,
  signal?: { aborted: boolean },
): Promise<void> {
  // Startup seed: deliver latest session event to onSessionEvent (FR-002)
  try {
    const seed = await (commandConn as any).xrevrange(STREAMS.sessionEvent, '+', '-', 'COUNT', 1);
    if (Array.isArray(seed) && seed.length > 0) {
      const entries = parseEntries(seed);
      for (const e of entries) {
        await onSessionEvent(e.payload, e.id);
      }
    }
  } catch {
    // Stream doesn't exist yet — skip seed
  }

  // Run one loop per stream/group pair concurrently
  await Promise.all([
    singleStreamLoop(consumerConn, commandConn, STREAMS.live, GROUPS.live, onLive, signal),
    singleStreamLoop(consumerConn, commandConn, STREAMS.session, GROUPS.session, onSession, signal),
    singleStreamLoop(
      consumerConn,
      commandConn,
      STREAMS.sessionEvent,
      GROUPS.sessionEvent,
      onSessionEvent,
      signal,
    ),
  ]);
}

async function singleStreamLoop(
  consumerConn: Redis,
  commandConn: Redis,
  stream: string,
  group: string,
  callback: Callback,
  signal?: { aborted: boolean },
): Promise<void> {
  while (!signal?.aborted) {
    try {
      const result = (await (consumerConn as any).xreadgroup(
        'GROUP',
        group,
        CONSUMER_NAME,
        'BLOCK',
        100,
        'STREAMS',
        stream,
        '>',
      )) as Array<[string, [string, string[]][]]> | null;

      if (!result) continue;

      for (const [, rawEntries] of result) {
        if (!Array.isArray(rawEntries) || rawEntries.length === 0) continue;
        const entries = parseEntries(rawEntries as [string, string[]][]);
        for (const { id, payload } of entries) {
          try {
            await callback(payload, id);
            await commandConn.xack(stream, group, id);
          } catch (err) {
            logger.error('[hub] Entry processing error', { stream, id, error: String(err) });
          }
        }
      }
    } catch (err: unknown) {
      if (signal?.aborted) break;
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('[hub] XREADGROUP error', { stream, group, error: errMsg, retryIn: 1000 });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
