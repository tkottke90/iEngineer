import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import type Redis from 'ioredis';
import type { RaceState, EngineerConfig, AudioClipRef } from '@iracing-engineer/types';
import { RacingEngineerService } from '../../../src/engineer/racing-engineer.js';
import { PriorityMessageQueue } from '../../../src/engineer/message-queue.js';
import { DedupTracker } from '../../../src/engineer/dedup-tracker.js';
import { AudioStore } from '../../../src/engineer/audio-store.js';
import { Tier3Synthesizer, type SynthDeps } from '../../../src/engineer/tier3-synthesizer.js';
import { SessionMemoryStore } from '../../../src/engineer/session-memory.js';
import { createTools } from '../../../src/engineer/tools.js';
import type { LlmResult } from '../../../src/engineer/llm-client.js';

class FakeRedis {
  handlers: Array<(ch: string, msg: string) => void> = [];
  published: Array<{ channel: string; message: string }> = [];
  duplicate(): FakeRedis {
    return this;
  }
  async subscribe(...chs: string[]): Promise<number> {
    return chs.length;
  }
  on(_e: string, cb: (ch: string, msg: string) => void): this {
    this.handlers.push(cb);
    return this;
  }
  async get(): Promise<string | null> {
    return null;
  }
  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    return 1;
  }
  async quit(): Promise<'OK'> {
    return 'OK';
  }
  deliver(channel: string, message: string): void {
    for (const h of this.handlers) h(channel, message);
  }
}

const CONFIG = {
  audioIdleCleanupIntervalMs: 60_000,
  queueDepthCap: 3,
  personality: { openness: 3, warmth: 3, energy: 3, conscientiousness: 3, assertiveness: 3 },
  llm: { baseUrl: 'x', model: 'm', provider: 'openai-compatible', timeoutMs: 1000, maxResponseTokens: 300, tokenBudget: 6000 },
} as unknown as EngineerConfig;

function raceState(): RaceState {
  return {
    session: { sessionId: 's1', sessionPhase: 'Race', lapsRemaining: 20, flags: 0 },
    field: {},
    hero: { position: 4, lapDistPct: 0.5, fuelLevel: 18, tireCompound: 'soft', lastLapTime: 92, onPitRoad: false, fuelUsePerHour: 40, lapDeltaToBest: 0.3, gapToLeader: 12, waterTemp: 88, oilTemp: 95 },
    signals: { pitWindowOpen: true, safeWindowOpen: true },
  } as unknown as RaceState;
}

async function waitUntil(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let active: RacingEngineerService | null = null;
afterEach(async () => {
  if (active) await active.stop();
  active = null;
});

describe('graceful degradation — LLM unreachable (US7)', () => {
  it('rule path (Tier 1/2) still dispatches while the LLM is down; PTT gets a canned line', async () => {
    // synthesizer whose LLM always fails
    const conn = new FakeRedis();
    const queue = new PriorityMessageQueue();
    const deps: Partial<SynthDeps> = {
      loadPrompt: (n) => `<!-- ${n} -->\n{energy}`,
      recordEvent: async () => 'evt',
      finalizeEvent: async () => {},
      runLlm: async () => ({ status: 'unreachable', error: 'ECONNREFUSED' }) as LlmResult,
    };
    const synth = new Tier3Synthesizer(raceState, new SessionMemoryStore('s1'), createTools({ getFuelModel: () => null, getTireModel: () => null }), queue, CONFIG, deps);
    const engineer = new RacingEngineerService(
      conn as unknown as Redis,
      new AudioStore(CONFIG.audioIdleCleanupIntervalMs),
      queue,
      new DedupTracker(),
      raceState,
      [],
      CONFIG,
      synth,
      async () => Buffer.from('mp3'),
    );
    active = engineer;
    await engineer.start();

    // Rule path: a Tier 1 alert enqueued directly must still be dispatched (SC-003).
    queue.enqueue({ tier: 1, eventType: 'hero:fuel_critical', messageText: 'Fuel critical', lapNumber: 1, sessionTime: 0, dedupKey: 'hero:fuel_critical' });
    // PTT query during the outage.
    conn.deliver('engineer:query', JSON.stringify({ queryId: 'q1', transcript: 'do we pit?', sessionId: 's1', capturedAtMs: 1 }));

    await waitUntil(() => conn.published.filter((p) => p.channel === 'voice:audio').length >= 2);
    const refs = conn.published.filter((p) => p.channel === 'voice:audio').map((p) => JSON.parse(p.message) as AudioClipRef);
    // Tier 1 fuel alert delivered (rule path unaffected)
    expect(refs.some((r) => r.tier === 1 && r.eventType === 'hero:fuel_critical')).to.be.true;
    // Canned Tier 3 line for the driver-query
    expect(refs.some((r) => r.tier === 3 && r.tier3Type === 'driver-query')).to.be.true;
  });

  it('recovers automatically when the LLM comes back (no restart)', async () => {
    const conn = new FakeRedis();
    const queue = new PriorityMessageQueue();
    let up = false;
    const deps: Partial<SynthDeps> = {
      loadPrompt: (n) => `<!-- ${n} -->\n{energy}`,
      recordEvent: async () => 'evt',
      finalizeEvent: async () => {},
      runLlm: async (_c, _m, _t, opts) => {
        if (!up) return { status: 'unreachable', error: 'down' };
        opts?.onDelta?.('Box now. ');
        return { status: 'ok', text: 'Box now.', toolsCalled: [], latencyMs: 5 };
      },
    };
    const synth = new Tier3Synthesizer(raceState, new SessionMemoryStore('s1'), createTools({ getFuelModel: () => null, getTireModel: () => null }), queue, CONFIG, deps);
    const engineer = new RacingEngineerService(conn as unknown as Redis, new AudioStore(CONFIG.audioIdleCleanupIntervalMs), queue, new DedupTracker(), raceState, [], CONFIG, synth, async () => Buffer.from('mp3'));
    active = engineer;
    await engineer.start();

    conn.deliver('engineer:query', JSON.stringify({ queryId: 'q1', transcript: 'do we pit?', sessionId: 's1', capturedAtMs: 1 }));
    await waitUntil(() => conn.published.length >= 1); // canned line while down
    up = true; // endpoint recovers
    conn.deliver('engineer:query', JSON.stringify({ queryId: 'q2', transcript: 'and now?', sessionId: 's1', capturedAtMs: 2 }));
    await waitUntil(() => conn.published.filter((p) => p.channel === 'voice:audio').length >= 2);
    const refs = conn.published.filter((p) => p.channel === 'voice:audio').map((p) => JSON.parse(p.message) as AudioClipRef);
    expect(refs.length).to.be.greaterThan(1); // synthesis resumed without a restart
  });
});
