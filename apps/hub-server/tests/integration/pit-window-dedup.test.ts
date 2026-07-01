/**
 * FR-016 / SC-002: pit window alert fires once per stint (event-cleared dedup),
 * suppressed across laps, and re-fires after hero:pit_exit. Requires REDIS_URL.
 */

import { describe, it, before, after, afterEach } from 'mocha';
import { expect } from 'chai';
import Redis from 'ioredis';
import type { RaceState, AudioClipRef } from '@iracing-engineer/types';
import { AudioStore, setAudioStore } from '../../src/engineer/audio-store.js';
import { PriorityMessageQueue } from '../../src/engineer/message-queue.js';
import { DedupTracker } from '../../src/engineer/dedup-tracker.js';
import { RacingEngineerService } from '../../src/engineer/racing-engineer.js';

const REDIS_URL = process.env.REDIS_URL;
const MP3 = Buffer.from([0xff, 0xfb, 0x00, 0x00]);
const CONFIG = { chatterboxUrl: 'http://mock', chatterboxVoiceFile: 'v.wav', fuelCriticalLapsRemaining: 1, gapThresholdSeconds: 2, audioIdleCleanupIntervalMs: 60_000 };

function raceState(): RaceState {
  return {
    session: null as unknown as RaceState['session'],
    field: {},
    hero: { lapDistPct: 0.5 } as RaceState['hero'], // no zones → always safe
    signals: { safeWindowOpen: true, cutWindowOpen: false, activeBattles: [], pitWindowOpen: true },
  };
}

describe('Pit window dedup reset (FR-016)', function () {
  this.timeout(15000);
  const origFetch = globalThis.fetch;
  let command: Redis;
  let engineer: RacingEngineerService | null = null;
  let store: AudioStore | null = null;

  before(function () {
    if (!REDIS_URL) return this.skip();
    command = new Redis(REDIS_URL);
  });
  after(function () {
    if (!REDIS_URL) return;
    command.disconnect();
  });
  afterEach(async function () {
    globalThis.fetch = origFetch;
    if (engineer) await engineer.stop();
    engineer = null;
    if (store) store.destroy();
    store = null;
  });

  it('fires once, suppressed across laps 11 & 12, re-fires after pit exit', async function () {
    if (!REDIS_URL) return this.skip();
    globalThis.fetch = (async () => new Response(MP3, { status: 200 })) as typeof fetch;

    store = new AudioStore(60_000);
    setAudioStore(store);
    engineer = new RacingEngineerService(
      command,
      store,
      new PriorityMessageQueue(),
      new DedupTracker(),
      raceState,
      [],
      CONFIG,
    );

    const sub = new Redis(REDIS_URL);
    const received: AudioClipRef[] = [];
    await sub.subscribe('voice:audio');
    sub.on('message', (_c, m) => received.push(JSON.parse(m) as AudioClipRef));

    await engineer.start();
    await new Promise((r) => setTimeout(r, 100));

    const openAt = (lap: number) =>
      command.publish(
        'hub:events',
        JSON.stringify({ type: 'hero:pit_window_open', sessionId: 's1', sessionTime: lap * 90, lapNumber: lap, lapDistPct: 0.5, payload: {} }),
      );
    const settle = () => new Promise((r) => setTimeout(r, 400));

    await openAt(10); // fires
    await settle();
    await openAt(11); // suppressed (event-cleared key, no lap dimension)
    await settle();
    await openAt(12); // STILL suppressed — per-stint, not per-lap
    await settle();
    expect(received.length, 'exactly one alert across laps 10–12').to.equal(1);

    // Pit exit resets dedup.
    await command.publish(
      'hub:events',
      JSON.stringify({ type: 'hero:pit_exit', sessionId: 's1', sessionTime: 1200, lapNumber: 12, lapDistPct: 0.9, payload: {} }),
    );
    await settle();

    await openAt(13); // fires again next stint
    await settle();
    sub.disconnect();

    expect(received.length, 'second alert after pit exit').to.equal(2);
  });
});
