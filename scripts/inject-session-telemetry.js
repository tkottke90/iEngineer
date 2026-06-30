#!/usr/bin/env node
/**
 * Inject synthetic session telemetry into Redis Streams.
 * Writes to iracing:telemetry:session and iracing:telemetry:live.
 *
 * Usage:
 *   node scripts/inject-session-telemetry.js \
 *     --session-id 1719619200000 \
 *     --hero-car-idx 3 \
 *     --fuel-start 45.0 \
 *     --fuel-burn-per-lap 2.8 \
 *     --laps 2
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
const fuelStart = parseFloat(flag('fuel-start', '45.0'));
const fuelBurnPerLap = parseFloat(flag('fuel-burn-per-lap', '2.8'));
const laps = parseInt(flag('laps', '2'), 10);
const rate = parseInt(flag('rate', '15'), 10); // ticks per lap for load testing

const redis = new Redis(REDIS_URL);

const NUM_CARS = 4;
const LAP_TIME_S = 90;
const TICKS_PER_LAP = rate;

async function run() {
  console.log(`[inject] session=${sessionId} hero=${heroCarIdx} laps=${laps} fuelStart=${fuelStart} burn=${fuelBurnPerLap}`);

  // First inject a session event
  const sessionEvent = JSON.stringify({
    active: true,
    track_name: 'Watkins Glen Boot',
    player_car_name: 'BMW M4 GT3',
    player_car_idx: heroCarIdx,
    session_type: 'Race',
    wall_clock_time: '14:00:00',
    ts: parseInt(sessionId, 10),
    driver_info: {
      drivers: Array.from({ length: NUM_CARS }, (_, i) => ({
        carIdx: i,
        userName: `Driver ${i}`,
        carNumber: String(i + 1),
        teamName: `Team ${i}`,
        carClassID: 4074,
      })),
    },
  });
  await redis.xadd('iracing:events:session', '*', 'payload', sessionEvent);
  console.log('[inject] Session event injected');

  // Walk the phase state machine: PreSession → Formation → Racing
  // Each tick needs a small delay so the processor can handle them sequentially.
  const baseArrays = (lap) => ({
    carIdxLapCompleted: Array.from({ length: NUM_CARS }, (_, i) => i === heroCarIdx ? lap : Math.max(0, lap - 1)),
    carIdxPosition: Array.from({ length: NUM_CARS }, (_, i) => i + 1),
    carIdxClassPosition: Array.from({ length: NUM_CARS }, (_, i) => i + 1),
    carIdxLapDistPct: Array.from({ length: NUM_CARS }, () => 0),
    carIdxOnPitRoad: Array.from({ length: NUM_CARS }, () => false),
    carIdxF2Time: Array.from({ length: NUM_CARS }, (_, i) => i === heroCarIdx ? 0 : (i - heroCarIdx) * 2.5),
    carIdxLastLapTime: Array.from({ length: NUM_CARS }, () => LAP_TIME_S),
    carIdxBestLapTime: Array.from({ length: NUM_CARS }, () => LAP_TIME_S - 0.5),
    carIdxEstTime: Array.from({ length: NUM_CARS }, () => LAP_TIME_S),
    carIdxTrackSurface: Array.from({ length: NUM_CARS }, () => 1),
  });

  // Tick 1: startReady flag → PreSession → Formation (0x20000000)
  await redis.xadd('iracing:telemetry:session', '*', 'payload', JSON.stringify({
    sessionTime: -2, sessionFlags: 0x20000000, sessionLapsRemain: laps, sessionTimeRemain: laps * LAP_TIME_S,
    fuelLevel: fuelStart, fuelUsePerHour: fuelBurnPerLap * 3600 / LAP_TIME_S,
    brake: 0, throttle: 0, latAccel: 0, longAccel: 0, speed: 0, gear: 0, waterTemp: 85, oilTemp: 120,
    playerCarIdx: heroCarIdx, lapCurrentLapTime: 0, lapDeltaToBestLap_DD: 0, incidentCount: 0,
    ...baseArrays(0),
  }));
  await new Promise(r => setTimeout(r, 200));

  // Tick 2: green flag → Formation → Racing (0x0004)
  await redis.xadd('iracing:telemetry:session', '*', 'payload', JSON.stringify({
    sessionTime: -1, sessionFlags: 0x0004, sessionLapsRemain: laps, sessionTimeRemain: laps * LAP_TIME_S,
    fuelLevel: fuelStart, fuelUsePerHour: fuelBurnPerLap * 3600 / LAP_TIME_S,
    brake: 0, throttle: 0.9, latAccel: 0, longAccel: 0, speed: 30, gear: 1, waterTemp: 85, oilTemp: 120,
    playerCarIdx: heroCarIdx, lapCurrentLapTime: 0, lapDeltaToBestLap_DD: 0, incidentCount: 0,
    ...baseArrays(0),
  }));
  await new Promise(r => setTimeout(r, 200));
  console.log('[inject] Phase flags injected: PreSession → Formation → Racing');

  let fuelLevel = fuelStart;

  for (let lap = 0; lap < laps; lap++) {
    const ticksThisLap = TICKS_PER_LAP;

    for (let tick = 0; tick < ticksThisLap; tick++) {
      const lapDistPct = tick / ticksThisLap;
      const sessionTime = (lap * LAP_TIME_S) + (tick * LAP_TIME_S / ticksThisLap);
      const fuelThisTick = fuelLevel - (fuelBurnPerLap * tick / ticksThisLap);

      const carIdxLapCompleted = Array.from({ length: NUM_CARS }, (_, i) =>
        i === heroCarIdx ? lap : Math.max(0, lap - 1)
      );
      const carIdxPosition = Array.from({ length: NUM_CARS }, (_, i) => i + 1);
      const carIdxLapDistPct = Array.from({ length: NUM_CARS }, (_, i) =>
        i === heroCarIdx ? lapDistPct : Math.min(1, lapDistPct + 0.1)
      );
      const carIdxOnPitRoad = Array.from({ length: NUM_CARS }, () => false);
      const carIdxF2Time = Array.from({ length: NUM_CARS }, (_, i) => i === heroCarIdx ? 0 : (i - heroCarIdx) * 2.5);
      const carIdxLastLapTime = Array.from({ length: NUM_CARS }, () => LAP_TIME_S);
      const carIdxBestLapTime = Array.from({ length: NUM_CARS }, () => LAP_TIME_S - 0.5);
      const carIdxEstTime = Array.from({ length: NUM_CARS }, () => LAP_TIME_S);
      const carIdxTrackSurface = Array.from({ length: NUM_CARS }, () => 1);
      const carIdxClassPosition = Array.from({ length: NUM_CARS }, (_, i) => i + 1);

      const sessionPayload = JSON.stringify({
        sessionTime,
        sessionFlags: 0x0004,
        sessionLapsRemain: Math.max(0, laps - lap - 1),
        sessionTimeRemain: (laps - lap) * LAP_TIME_S - tick * LAP_TIME_S / ticksThisLap,
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
        fuelLevel: fuelThisTick,
        fuelUsePerHour: fuelBurnPerLap * 3600 / LAP_TIME_S,
        brake: 0,
        throttle: 0.9,
        latAccel: 0.1,
        longAccel: 0.05,
        speed: 50,
        gear: 4,
        waterTemp: 85,
        oilTemp: 120,
        playerCarIdx: heroCarIdx,
        lapCurrentLapTime: tick * LAP_TIME_S / ticksThisLap,
        lapDeltaToBestLap_DD: 0.1,
        incidentCount: 0,
      });

      await redis.xadd('iracing:telemetry:session', '*', 'payload', sessionPayload);

      const livePayload = JSON.stringify({
        sessionTime,
        brake: 0,
        throttle: 0.9,
        latAccel: 0.1,
        longAccel: 0.05,
        speed: 50,
        lapDistPct,
        carIdxLapDistPct,
      });
      await redis.xadd('iracing:telemetry:live', '*', 'payload', livePayload);

      // Small delay to simulate real cadence
      await new Promise(r => setTimeout(r, 1000 / rate));
    }

    // Lap complete
    fuelLevel -= fuelBurnPerLap;
    console.log(`[inject] Lap ${lap + 1} complete. fuelLevel=${fuelLevel.toFixed(2)}`);
  }

  console.log('[inject] Done.');
  await redis.quit();
}

run().catch(e => { console.error(e); process.exit(1); });
