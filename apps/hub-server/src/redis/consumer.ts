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
      const result = await (redis as any).xautoclaim(stream, group, CONSUMER_NAME, idleMs, '0-0', 'COUNT', '100');
      // result is [nextId, entries, deletedIds] or [nextId, entries]
      const entries = Array.isArray(result[1]) ? result[1] : [];
      totalReclaimed += entries.length;
    } catch (err: unknown) {
      // Stream may not exist yet — ignore
      if (err instanceof Error && (err.message.includes('ERR') || err.message.includes('NOGROUP'))) continue;
      throw err;
    }
  }
  logger.info('[hub] Reclaimed pending messages', { reclaimedCount: totalReclaimed });
  return totalReclaimed;
}

type EntryPayload = string;
type Callback = (payload: EntryPayload, entryId: string) => Promise<void> | void;

function parseEntries(raw: [string, string[]][]): Array<{ id: string; payload: string }> {
  return raw.map(([id, fields]) => {
    const idx = fields.indexOf('payload');
    const payload = idx !== -1 ? fields[idx + 1] : '';
    return { id, payload };
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
    singleStreamLoop(consumerConn, commandConn, STREAMS.sessionEvent, GROUPS.sessionEvent, onSessionEvent, signal),
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
      const result = await (consumerConn as any).xreadgroup(
        'GROUP', group, CONSUMER_NAME,
        'BLOCK', 100,
        'STREAMS', stream, '>'
      ) as Array<[string, [string, string[]][]]> | null;

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
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}
