#!/usr/bin/env node
/**
 * Inject a synthetic pit entry event for the hero car.
 *
 * Usage:
 *   node scripts/inject-pit-entry.js --session-id 1719619200000 --hero-car-idx 3
 */

import Redis from 'ioredis';

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : def;
}

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const sessionId = flag('session-id', String(Date.now()));
const heroCarIdx = parseInt(flag('hero-car-idx', '0'), 10);

const redis = new Redis(REDIS_URL);

async function run() {
  console.log(`[inject-pit] session=${sessionId} hero=${heroCarIdx}`);

  const NUM_CARS = 4;
  const LAP_TIME_S = 90;

  // Helper to build a session telemetry payload
  function buildPayload(onPitRoad) {
    const carIdxLapCompleted = Array.from({ length: NUM_CARS }, (_, i) => i === heroCarIdx ? 3 : 2);
    const carIdxPosition = Array.from({ length: NUM_CARS }, (_, i) => i + 1);
    const carIdxLapDistPct = Array.from({ length: NUM_CARS }, (_, i) => i === heroCarIdx ? 0.01 : 0.15);
    const carIdxOnPitRoad = Array.from({ length: NUM_CARS }, (_, i) => i === heroCarIdx ? onPitRoad : false);
    const carIdxF2Time = Array.from({ length: NUM_CARS }, (_, i) => i === heroCarIdx ? 0 : (i - heroCarIdx) * 2.5);
    const carIdxLastLapTime = Array.from({ length: NUM_CARS }, () => LAP_TIME_S);
    const carIdxBestLapTime = Array.from({ length: NUM_CARS }, () => LAP_TIME_S - 0.5);
    const carIdxEstTime = Array.from({ length: NUM_CARS }, () => LAP_TIME_S);
    const carIdxTrackSurface = Array.from({ length: NUM_CARS }, () => 1);
    const carIdxClassPosition = Array.from({ length: NUM_CARS }, (_, i) => i + 1);

    return JSON.stringify({
      sessionTime: 1842.3,
      sessionFlags: 0x0004,
      sessionLapsRemain: 5,
      sessionTimeRemain: 450,
      carIdxLapCompleted,
      carIdxPosition,
      carIdxClassPosition,
      carIdxLapDistPct,
      carIdxOnPitRoad,
      carIdxF2Time,
      carIdxLastLapTime,
      carIdxBestLapTime,
      carIdxEstTime,
      carIdxTrackSurface,
      fuelLevel: 39.4,
      fuelUsePerHour: 112,
      brake: 0,
      throttle: 0.9,
      latAccel: 0.1,
      longAccel: 0.05,
      speed: 5,
      gear: 1,
      waterTemp: 85,
      oilTemp: 120,
      playerCarIdx: heroCarIdx,
      lapCurrentLapTime: 2.3,
      lapDeltaToBestLap_DD: 0,
      incidentCount: 0,
    });
  }

  // Tick with car NOT on pit road (baseline)
  await redis.xadd('iracing:telemetry:session', '*', 'payload', buildPayload(false));
  await new Promise(r => setTimeout(r, 100));

  // Tick with car ON pit road (triggers pit entry detection)
  await redis.xadd('iracing:telemetry:session', '*', 'payload', buildPayload(true));

  console.log('[inject-pit] Pit entry injected');
  await redis.quit();
}

run().catch(e => { console.error(e); process.exit(1); });
