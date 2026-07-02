import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import type Redis from 'ioredis';
import type { RaceState, EngineerConfig, RaceEvent } from '@iracing-engineer/types';
import { RacingEngineerService } from '../../../src/engineer/racing-engineer.js';
import { PriorityMessageQueue } from '../../../src/engineer/message-queue.js';
import { DedupTracker } from '../../../src/engineer/dedup-tracker.js';
import { AudioStore } from '../../../src/engineer/audio-store.js';
import { SessionMemoryStore } from '../../../src/engineer/session-memory.js';
import { OverrideTracker } from '../../../src/engineer/override-tracker.js';

class FakeRedis {
  handlers: Array<(ch: string, msg: string) => void> = [];
  duplicate(): FakeRedis {
    return this;
  }
  async subscribe(...c: string[]): Promise<number> {
    return c.length;
  }
  on(_e: string, cb: (ch: string, msg: string) => void): this {
    this.handlers.push(cb);
    return this;
  }
  async get(): Promise<string | null> {
    return null;
  }
  async publish(): Promise<number> {
    return 1;
  }
  async quit(): Promise<'OK'> {
    return 'OK';
  }
  deliver(ch: string, msg: string): void {
    for (const h of this.handlers) h(ch, msg);
  }
}

const CONFIG = {
  audioIdleCleanupIntervalMs: 60_000,
  queueDepthCap: 3,
  postSectorMinLapGap: 2,
  deferenceThreshold: 2,
  personality: { openness: 3, warmth: 3, energy: 3, conscientiousness: 3, assertiveness: 3 },
  llm: { baseUrl: 'x', model: 'm', provider: 'openai-compatible', timeoutMs: 1000, maxResponseTokens: 300, tokenBudget: 6000 },
} as unknown as EngineerConfig;

function raceState(): RaceState {
  return {
    session: { sessionId: 's1', sessionPhase: 'Race', lapsRemaining: 20, flags: 0 },
    field: {},
    hero: { position: 4, lapDistPct: 0.5, fuelLevel: 18, tireCompound: 'soft', onPitRoad: false },
    signals: { pitWindowOpen: true, safeWindowOpen: true },
  } as unknown as RaceState;
}

function ev(type: string, lapNumber: number): string {
  return JSON.stringify({ type, sessionId: 's1', sessionTime: 0, lapNumber, payload: {} } as RaceEvent);
}

function makeEngineer(): { engineer: RacingEngineerService; conn: FakeRedis; mem: SessionMemoryStore } {
  const conn = new FakeRedis();
  const mem = new SessionMemoryStore('s1');
  const tracker = new OverrideTracker(mem, CONFIG.deferenceThreshold);
  const engineer = new RacingEngineerService(
    conn as unknown as Redis,
    new AudioStore(CONFIG.audioIdleCleanupIntervalMs),
    new PriorityMessageQueue(),
    new DedupTracker(),
    raceState,
    [],
    CONFIG,
    null, // no synthesizer needed
    async () => Buffer.from('mp3'), // fake TTS (no Chatterbox)
    tracker,
  );
  return { engineer, conn, mem };
}

let active: RacingEngineerService | null = null;
afterEach(async () => {
  if (active) await active.stop();
  active = null;
});

describe('override tracking end-to-end (US4, SC-006)', () => {
  it('logs the pit recommendation, marks it overridden, and does not re-issue it', async () => {
    const { engineer, conn, mem } = makeEngineer();
    active = engineer;
    await engineer.start();

    // Pit window opens on lap 12 → the recommendation.
    conn.deliver('hub:events', ev('hero:pit_window_open', 12));
    expect(mem.get().recommendations).to.have.length(1);
    expect(mem.get().recommendations[0].outcome).to.equal('pending');

    // Lap 12 completes with no pit entry → overridden.
    conn.deliver('hub:events', ev('hero:lap_complete', 12));
    expect(mem.get().recommendations[0].outcome).to.equal('overridden');

    // Pit window "opens" again lap 13 — M4 dedup suppresses it (no pit_exit reset),
    // so the recommendation is NOT re-issued (SC-006).
    conn.deliver('hub:events', ev('hero:pit_window_open', 13));
    expect(mem.get().recommendations).to.have.length(1);
  });

  it('marks the recommendation followed when the driver pits within the window', async () => {
    const { engineer, conn, mem } = makeEngineer();
    active = engineer;
    await engineer.start();
    conn.deliver('hub:events', ev('hero:pit_window_open', 12));
    conn.deliver('hub:events', ev('hero:pit_entry', 12));
    conn.deliver('hub:events', ev('hero:lap_complete', 12));
    expect(mem.get().recommendations[0].outcome).to.equal('followed');
    expect(mem.get().deference.overrideCountByType.pit ?? 0).to.equal(0);
  });
});
