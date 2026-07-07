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
import { logger } from '../../../src/logger.js';

// Minimal ioredis fake: acts as both the command connection and its duplicate.
class FakeRedis {
  handlers: Array<(ch: string, msg: string) => void> = [];
  published: Array<{ channel: string; message: string }> = [];
  kv: Record<string, string> = {};
  duplicate(): FakeRedis {
    return this;
  }
  async subscribe(...chs: string[]): Promise<number> {
    return chs.length;
  }
  on(_event: string, cb: (ch: string, msg: string) => void): this {
    this.handlers.push(cb);
    return this;
  }
  async get(key: string): Promise<string | null> {
    return this.kv[key] ?? null;
  }
  async set(key: string, value: string): Promise<'OK'> {
    this.kv[key] = value;
    return 'OK';
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
  queueDepthCap: 2,
  personality: { openness: 3, warmth: 3, energy: 3, conscientiousness: 3, assertiveness: 3 },
  llm: {
    baseUrl: 'x',
    model: 'm',
    provider: 'openai-compatible',
    timeoutMs: 1000,
    maxResponseTokens: 300,
    tokenBudget: 6000,
  },
} as unknown as EngineerConfig;

function raceState(): RaceState {
  return {
    session: { sessionId: 's1', sessionPhase: 'Race', lapsRemaining: 20, flags: 0 },
    field: {},
    hero: {
      position: 4,
      lapDistPct: 0.5,
      fuelLevel: 18,
      tireCompound: 'soft',
      lastLapTime: 92,
      onPitRoad: false,
      fuelUsePerHour: 40,
      lapDeltaToBest: 0.3,
      gapToLeader: 12,
      waterTemp: 88,
      oilTemp: 95,
    },
    signals: { pitWindowOpen: true, safeWindowOpen: true },
  } as unknown as RaceState;
}

function synthDeps(run: SynthDeps['runLlm']): Partial<SynthDeps> {
  return {
    loadPrompt: (name) => `<!-- ${name} -->\nPROMPT {energy}`,
    recordEvent: async () => 'evt',
    finalizeEvent: async () => {},
    runLlm: run,
  };
}

function makeEngineer(run: SynthDeps['runLlm']): {
  engineer: RacingEngineerService;
  conn: FakeRedis;
} {
  const conn = new FakeRedis();
  const queue = new PriorityMessageQueue();
  const synth = new Tier3Synthesizer(
    raceState,
    new SessionMemoryStore('s1'),
    createTools({ getFuelModel: () => null, getTireModel: () => null }),
    queue,
    CONFIG,
    synthDeps(run),
  );
  const engineer = new RacingEngineerService(
    conn as unknown as Redis,
    new AudioStore(CONFIG.audioIdleCleanupIntervalMs),
    queue,
    new DedupTracker(),
    raceState,
    [],
    CONFIG,
    synth,
    async () => Buffer.from('fake-mp3'), // injected clip generator (no Chatterbox)
  );
  return { engineer, conn };
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

describe('driver-query flow — engineer:query → voice:audio (US1)', () => {
  it('transcribed query is synthesized and published as Tier 3 clips', async () => {
    const okRun: SynthDeps['runLlm'] = async (_c, _m, _t, opts) => {
      opts?.onDelta?.('Box this lap. ');
      opts?.onDelta?.('Fuel is tight.');
      return {
        status: 'ok',
        text: 'Box this lap. Fuel is tight.',
        toolsCalled: ['get_fuel_status'],
        latencyMs: 10,
      } as LlmResult;
    };
    const { engineer, conn } = makeEngineer(okRun);
    active = engineer;
    await engineer.start();

    conn.deliver(
      'engineer:query',
      JSON.stringify({
        queryId: 'q1',
        transcript: 'do we pit this lap?',
        sessionId: 's1',
        capturedAtMs: 1,
      }),
    );

    await waitUntil(() => conn.published.filter((p) => p.channel === 'voice:audio').length >= 2);
    const refs = conn.published
      .filter((p) => p.channel === 'voice:audio')
      .map((p) => JSON.parse(p.message) as AudioClipRef);
    expect(refs).to.have.length(2);
    expect(refs[0].tier).to.equal(3);
    expect(refs[0].tier3Type).to.equal('driver-query');
  });

  it('seeds the default personality to Redis when the key is absent', async () => {
    const okRun: SynthDeps['runLlm'] = async (_c, _m, _t, opts) => {
      opts?.onDelta?.('Box now.');
      return { status: 'ok', text: 'Box now.', toolsCalled: [], latencyMs: 1 } as LlmResult;
    };
    const { engineer, conn } = makeEngineer(okRun);
    active = engineer;
    // Key absent up front → readPersonality falls back and should seed the default.
    expect(conn.kv['hub:config:personality']).to.equal(undefined);
    await engineer.start();

    conn.deliver(
      'engineer:query',
      JSON.stringify({ queryId: 'q1', transcript: 'do we pit?', sessionId: 's1', capturedAtMs: 1 }),
    );

    await waitUntil(() => conn.kv['hub:config:personality'] !== undefined);
    expect(JSON.parse(conn.kv['hub:config:personality'])).to.deep.equal(CONFIG.personality);
  });

  it('ignores an empty transcript (no synthesis, no publish)', async () => {
    const { engineer, conn } = makeEngineer(async () => ({
      status: 'ok',
      text: '',
      toolsCalled: [],
      latencyMs: 1,
    }));
    active = engineer;
    await engineer.start();

    conn.deliver(
      'engineer:query',
      JSON.stringify({ queryId: 'q1', transcript: '   ', sessionId: 's1', capturedAtMs: 1 }),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(conn.published.filter((p) => p.channel === 'voice:audio')).to.have.length(0);
  });

  it('drops queries beyond queueDepthCap while one is in flight (Q4)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hangRun: SynthDeps['runLlm'] = async () => {
      await gate;
      return { status: 'ok', text: 'ok', toolsCalled: [], latencyMs: 1 };
    };
    const { engineer, conn } = makeEngineer(hangRun);
    active = engineer;
    await engineer.start();

    const warns: string[] = [];
    const origWarn = logger.warn;
    (logger as unknown as { warn: (m: string) => void }).warn = (m: string) =>
      warns.push(String(m));
    try {
      // 1 goes in-flight (hangs); 2 queue (cap=2); the 4th is dropped.
      for (let i = 0; i < 4; i++) {
        conn.deliver(
          'engineer:query',
          JSON.stringify({
            queryId: `q${i}`,
            transcript: 'do we pit?',
            sessionId: 's1',
            capturedAtMs: i,
          }),
        );
      }
      await waitUntil(() => warns.some((w) => w.includes('queue depth cap')));
      expect(warns.some((w) => w.includes('queue depth cap'))).to.be.true;
    } finally {
      (logger as unknown as { warn: typeof logger.warn }).warn = origWarn;
      release();
    }
  });
});
