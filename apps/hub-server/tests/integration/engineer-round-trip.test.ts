/**
 * Integration tests for the Racing Engineer round-trip (US1).
 * Requires REDIS_URL. Chatterbox is mocked at the fetch layer (instant).
 *
 * Run: REDIS_URL=redis://localhost:6379 npm run test:integration
 */

import { describe, it, before, after, afterEach } from 'mocha';
import { expect } from 'chai';
import Redis from 'ioredis';
import type { RaceState, AudioClipRef } from '@iracing-engineer/types';
import { AudioStore, setAudioStore } from '../../src/engineer/audio-store.js';
import { PriorityMessageQueue } from '../../src/engineer/message-queue.js';
import { DedupTracker } from '../../src/engineer/dedup-tracker.js';
import { RacingEngineerService } from '../../src/engineer/racing-engineer.js';
import { logger } from '../../src/logger.js';
import app from '../../src/api.js';

const REDIS_URL = process.env.REDIS_URL;

// Minimal RaceState with pitWindowOpen signal + hero position.
function raceStateStub(): RaceState {
  return {
    session: null as unknown as RaceState['session'],
    field: {},
    hero: { lapDistPct: 0.5 } as RaceState['hero'],
    signals: { safeWindowOpen: true, cutWindowOpen: false, activeBattles: [], pitWindowOpen: true },
  };
}

const MP3_BYTES = Buffer.from([0xff, 0xfb, 0x00, 0x00]); // fake MP3 header

describe('Racing Engineer round-trip', function () {
  this.timeout(10000);
  const origFetch = globalThis.fetch;
  let command: Redis;
  let engineer: RacingEngineerService | null = null;
  let audioStore: AudioStore | null = null;

  before(function () {
    if (!REDIS_URL) return this.skip();
    command = new Redis(REDIS_URL);
  });

  after(async function () {
    if (!REDIS_URL) return;
    command.disconnect();
  });

  afterEach(async function () {
    globalThis.fetch = origFetch;
    if (engineer) await engineer.stop();
    engineer = null;
    if (audioStore) audioStore.destroy();
    audioStore = null;
  });

  it('SC-001: hero:fuel_critical → AudioClipRef on voice:audio; clip served over HTTP', async function () {
    if (!REDIS_URL) return this.skip();

    // Mock Chatterbox — returns instantly with MP3 bytes.
    globalThis.fetch = (async () =>
      new Response(MP3_BYTES, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })) as typeof fetch;

    audioStore = new AudioStore(60_000);
    setAudioStore(audioStore);
    engineer = new RacingEngineerService(
      command,
      audioStore,
      new PriorityMessageQueue(),
      new DedupTracker(),
      raceStateStub,
      [],
      { chatterboxUrl: 'http://mock', chatterboxVoiceFile: 'v.wav', fuelCriticalLapsRemaining: 1.0, gapThresholdSeconds: 2, audioIdleCleanupIntervalMs: 60_000 },
    );

    const sub = new Redis(REDIS_URL);
    const received: AudioClipRef[] = [];
    await sub.subscribe('voice:audio');
    sub.on('message', (_c, m) => received.push(JSON.parse(m) as AudioClipRef));

    await engineer.start();
    await new Promise((r) => setTimeout(r, 100)); // let subscription settle

    await command.publish(
      'hub:events',
      JSON.stringify({ type: 'hero:fuel_critical', sessionId: 's1', sessionTime: 100, lapNumber: 5, lapDistPct: 0.5, payload: { lapsRemaining: 0.5 } }),
    );

    // Wait up to 5s for the AudioClipRef.
    const deadline = Date.now() + 5000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    sub.disconnect();

    expect(received.length).to.be.greaterThan(0);
    const ref = received[0];
    expect(ref.eventType).to.equal('hero:fuel_critical');
    expect(ref.tier).to.equal(1);
    expect(ref.clipUrl).to.match(/^\/api\/audio\//);

    // GET /api/audio/:audioId returns 200 + binary body.
    const res = await app.request(ref.clipUrl);
    expect(res.status).to.equal(200);
    expect(res.headers.get('Content-Type')).to.equal('audio/mpeg');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).to.be.greaterThan(0);
  });

  it('E2: Redis subscribe failure degrades silently (start does not throw)', async function () {
    // Stub whose duplicate().subscribe() rejects.
    const logs: string[] = [];
    const orig = logger.error;
    (logger as unknown as { error: (m: string) => void }).error = (m: string) => logs.push(String(m));
    const failingConn = {
      duplicate() {
        return {
          async subscribe() {
            throw new Error('ECONNREFUSED');
          },
          on() {},
        };
      },
    } as unknown as Redis;

    const store = new AudioStore(60_000);
    const svc = new RacingEngineerService(
      failingConn,
      store,
      new PriorityMessageQueue(),
      new DedupTracker(),
      raceStateStub,
      [],
      { chatterboxUrl: 'http://mock', chatterboxVoiceFile: 'v.wav', fuelCriticalLapsRemaining: 1, gapThresholdSeconds: 2, audioIdleCleanupIntervalMs: 60_000 },
    );

    try {
      await svc.start(); // must not throw
      expect(logs.some((l) => l.includes('Failed to subscribe to hub:events'))).to.be.true;
    } finally {
      (logger as unknown as { error: typeof logger.error }).error = orig;
      store.destroy();
    }
  });
});
