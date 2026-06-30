#!/usr/bin/env node
/**
 * Inject a synthetic braking sequence into iracing:telemetry:live.
 * Tests the safe window signal: during braking → false; after 150m clearance → true.
 *
 * Usage:
 *   node scripts/inject-braking-sequence.js \
 *     --session-id 1719619200000 \
 *     --brake-duration-ms 800 \
 *     --post-brake-distance-m 200
 */

import Redis from 'ioredis';

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : def;
}

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const sessionId = flag('session-id', String(Date.now()));
const brakeDurationMs = parseInt(flag('brake-duration-ms', '800'), 10);
const postBrakeDistanceM = parseInt(flag('post-brake-distance-m', '200'), 10);

const redis = new Redis(REDIS_URL);

async function run() {
  console.log(`[inject-braking] session=${sessionId} brakeDuration=${brakeDurationMs}ms postDistance=${postBrakeDistanceM}m`);

  const TICK_MS = 16; // ~60 Hz
  const SPEED_MS = 55; // m/s

  // Phase 1: braking ticks
  const brakeTicks = Math.ceil(brakeDurationMs / TICK_MS);
  console.log(`[inject-braking] Phase 1: ${brakeTicks} braking ticks`);
  for (let i = 0; i < brakeTicks; i++) {
    const payload = JSON.stringify({
      sessionTime: i * TICK_MS / 1000,
      brake: 0.9,
      throttle: 0,
      latAccel: 0.1,
      longAccel: -2.5,
      speed: SPEED_MS * (1 - i / brakeTicks * 0.3),
      lapDistPct: 0.5 + i * 0.001,
    });
    await redis.xadd('iracing:telemetry:live', '*', 'payload', payload);
    await new Promise(r => setTimeout(r, TICK_MS));
  }

  // Phase 2: post-brake travel ticks (safe window should open after 150m)
  const postBrakeTicks = Math.ceil(postBrakeDistanceM / (SPEED_MS * TICK_MS / 1000));
  console.log(`[inject-braking] Phase 2: ${postBrakeTicks} post-brake ticks (~${postBrakeDistanceM}m @ ${SPEED_MS}m/s)`);
  for (let i = 0; i < postBrakeTicks; i++) {
    const payload = JSON.stringify({
      sessionTime: (brakeTicks + i) * TICK_MS / 1000,
      brake: 0,
      throttle: 0.95,
      latAccel: 0.05,
      longAccel: 0.2,
      speed: SPEED_MS,
      lapDistPct: 0.5 + brakeTicks * 0.001 + i * 0.001,
    });
    await redis.xadd('iracing:telemetry:live', '*', 'payload', payload);
    await new Promise(r => setTimeout(r, TICK_MS));
  }

  console.log('[inject-braking] Done. safeWindowOpen should be true now.');
  await redis.quit();
}

run().catch(e => { console.error(e); process.exit(1); });
