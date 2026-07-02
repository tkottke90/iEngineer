import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import type Redis from 'ioredis';
import type { RaceState, EngineerConfig, AudioClipRef, RaceEvent } from '@iracing-engineer/types';
import { RacingEngineerService } from '../../../src/engineer/racing-engineer.js';
import { PriorityMessageQueue } from '../../../src/engineer/message-queue.js';
import { DedupTracker } from '../../../src/engineer/dedup-tracker.js';
import { AudioStore } from '../../../src/engineer/audio-store.js';
import { Tier3Synthesizer, type SynthDeps } from '../../../src/engineer/tier3-synthesizer.js';
import { SessionMemoryStore } from '../../../src/engineer/session-memory.js';
import { createTools } from '../../../src/engineer/tools.js';

class FakeRedis {
  handlers: Array<(ch: string, msg: string) => void> = [];
  published: Array<{ channel: string; message: string }> = [];
  personalityRaw: string | null = null;
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
  async get(key: string): Promise<string | null> {
    return key === 'hub:config:personality' ? this.personalityRaw : null;
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
  postSectorMinLapGap: 2,
  personality: { openness: 3, warmth: 3, energy: 3, conscientiousness: 3, assertiveness: 3 },
  fuelCriticalLapsRemaining: 1.0,
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

function ev(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, sessionId: 's1', sessionTime: 0, lapNumber: 5, payload: {}, ...extra } as RaceEvent);
}

const okRun: SynthDeps['runLlm'] = async (_c, _m, _t, opts) => {
  opts?.onDelta?.('Briefing sentence. ');
  return { status: 'ok', text: 'Briefing sentence.', toolsCalled: [], latencyMs: 5 };
};

function makeEngineer(): { engineer: RacingEngineerService; conn: FakeRedis } {
  const conn = new FakeRedis();
  const queue = new PriorityMessageQueue();
  const synth = new Tier3Synthesizer(
    raceState,
    new SessionMemoryStore('s1'),
    createTools({ getFuelModel: () => null, getTireModel: () => null }),
    queue,
    CONFIG,
    { loadPrompt: (n) => `<!-- ${n} -->\n{energy}`, recordEvent: async () => 'evt', finalizeEvent: async () => {}, runLlm: okRun },
  );
  const engineer = new RacingEngineerService(conn as unknown as Redis, new AudioStore(CONFIG.audioIdleCleanupIntervalMs), queue, new DedupTracker(), raceState, [], CONFIG, synth, async () => Buffer.from('mp3'));
  return { engineer, conn };
}

async function waitUntil(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
function refs(conn: FakeRedis): AudioClipRef[] {
  return conn.published.filter((p) => p.channel === 'voice:audio').map((p) => JSON.parse(p.message) as AudioClipRef);
}

let active: RacingEngineerService | null = null;
afterEach(async () => {
  if (active) await active.stop();
  active = null;
});

describe('proactive Tier 3 briefings (US2)', () => {
  it('pit-lane entry triggers a pit-entry briefing', async () => {
    const { engineer, conn } = makeEngineer();
    active = engineer;
    await engineer.start();
    conn.deliver('hub:events', ev('hero:pit_entry'));
    await waitUntil(() => refs(conn).some((r) => r.tier3Type === 'pit-entry'));
    expect(refs(conn).some((r) => r.tier === 3 && r.tier3Type === 'pit-entry')).to.be.true;
  });

  it('safety car fires the immediate Tier 1 alert AND an additive Tier 3 briefing (FR-016)', async () => {
    const { engineer, conn } = makeEngineer();
    active = engineer;
    await engineer.start();
    conn.deliver('hub:events', ev('session:safety_car_deployed'));
    await waitUntil(() => refs(conn).some((r) => r.tier === 3 && r.tier3Type === 'safety-car'));
    const all = refs(conn);
    expect(all.some((r) => r.tier === 1 && r.eventType === 'session:safety_car_deployed'), 'Tier 1 alert').to.be.true;
    expect(all.some((r) => r.tier === 3 && r.tier3Type === 'safety-car'), 'Tier 3 briefing').to.be.true;
  });

  it('post-sector commentary fires only every postSectorMinLapGap laps', async () => {
    const { engineer, conn } = makeEngineer();
    active = engineer;
    await engineer.start();
    conn.deliver('hub:events', ev('hero:lap_complete')); // lap 1 — no
    conn.deliver('hub:events', ev('hero:lap_complete')); // lap 2 — fires (gap 2)
    await waitUntil(() => refs(conn).some((r) => r.tier3Type === 'post-sector'));
    expect(refs(conn).filter((r) => r.tier3Type === 'post-sector')).to.have.length(1);
  });

  it('Energy=1 suppresses post-sector commentary', async () => {
    const { engineer, conn } = makeEngineer();
    conn.personalityRaw = JSON.stringify({ openness: 3, warmth: 3, energy: 1, conscientiousness: 3, assertiveness: 3 });
    active = engineer;
    await engineer.start();
    conn.deliver('hub:events', ev('hero:lap_complete'));
    conn.deliver('hub:events', ev('hero:lap_complete')); // would fire at gap 2
    await new Promise((r) => setTimeout(r, 250));
    expect(refs(conn).filter((r) => r.tier3Type === 'post-sector')).to.have.length(0);
  });
});
