/**
 * SC-006: Tier 2 alert held during a Radio Blackout Zone is delivered within
 * 3 seconds of the zone ending. Requires REDIS_URL; Chatterbox mocked.
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

describe('Safe-window gate (SC-006)', function () {
  this.timeout(10000);
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

  it('holds Tier 2 during blackout zone, delivers within 3s of zone exit', async function () {
    if (!REDIS_URL) return this.skip();
    globalThis.fetch = (async () => new Response(MP3, { status: 200 })) as typeof fetch;

    // Mutable hero position — car starts inside the 0.4–0.6 zone.
    const hero = { lapDistPct: 0.5 } as RaceState['hero'];
    const raceState = (): RaceState => ({
      session: null as unknown as RaceState['session'],
      field: {},
      hero,
      signals: { safeWindowOpen: true, cutWindowOpen: false, activeBattles: [], pitWindowOpen: true },
    });

    store = new AudioStore(60_000);
    setAudioStore(store);
    engineer = new RacingEngineerService(
      command,
      store,
      new PriorityMessageQueue(),
      new DedupTracker(),
      raceState,
      [{ lapDistPctStart: 0.4, lapDistPctEnd: 0.6 }],
      CONFIG,
    );

    const sub = new Redis(REDIS_URL);
    const received: AudioClipRef[] = [];
    await sub.subscribe('voice:audio');
    sub.on('message', (_c, m) => received.push(JSON.parse(m) as AudioClipRef));

    await engineer.start();
    await new Promise((r) => setTimeout(r, 100));

    // Pit window opens while inside the blackout zone.
    await command.publish(
      'hub:events',
      JSON.stringify({ type: 'hero:pit_window_open', sessionId: 's1', sessionTime: 100, lapNumber: 10, lapDistPct: 0.5, payload: {} }),
    );

    // Assert NOT delivered within 3s while gated.
    await new Promise((r) => setTimeout(r, 3000));
    expect(received.length, 'should be held during blackout zone').to.equal(0);

    // Car exits the zone → alert must arrive within 3s.
    const zoneExitPublishedAt = Date.now();
    hero!.lapDistPct = 0.7;

    const deadline = Date.now() + 3000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    sub.disconnect();

    expect(received.length, 'delivered after zone exit').to.be.greaterThan(0);
    expect(Date.now() - zoneExitPublishedAt).to.be.lessThanOrEqual(3000);
    expect(received[0].eventType).to.equal('hero:pit_window_open');
  });
});
