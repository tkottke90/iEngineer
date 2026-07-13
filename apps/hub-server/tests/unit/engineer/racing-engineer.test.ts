// Service-wiring suite (007 T010): clear-signal routing, scoped dedup wiring,
// and monitor integration for the RacingEngineerService. Behavior-level service
// tests live in the behavior-named suites (degradation/proactive-briefings/
// driver-query/override.test.ts); this file owns the 007 wiring assertions.
// File created by T010 (US1); extended by T017 (US2) and T019 (US3).
import { describe, it, afterEach, beforeEach } from 'mocha';
import { expect } from 'chai';
import type Redis from 'ioredis';
import type {
  RaceState,
  CarState,
  HeroState,
  EngineerConfig,
  AudioClipRef,
  RaceEvent,
  EventType,
} from '@iracing-engineer/types';
import { RacingEngineerService } from '../../../src/engineer/racing-engineer.js';
import { PriorityMessageQueue } from '../../../src/engineer/message-queue.js';
import { DedupTracker } from '../../../src/engineer/dedup-tracker.js';
import { AudioStore } from '../../../src/engineer/audio-store.js';
import { logger } from '../../../src/logger.js';

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
  async set(): Promise<'OK'> {
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
  queueDepthCap: 3,
  fuelCriticalLapsRemaining: 1.0,
  gapThresholdSeconds: 2.0,
  relevantPositionRange: 3,
  gapHysteresisMarginSeconds: 0.5,
  personality: { openness: 3, warmth: 3, energy: 3, conscientiousness: 3, assertiveness: 3 },
} as unknown as EngineerConfig;

function car(over: Partial<CarState>): CarState {
  return {
    carIdx: 0,
    driverName: 'D',
    carNumber: '0',
    teamName: '',
    carClassId: 100,
    lapDistPct: 0.1,
    trackSurface: 3,
    position: 1,
    classPosition: 1,
    lapCompleted: 5,
    lastLapTime: 90,
    bestLapTime: 89,
    estimatedLapTime: 90,
    gapToLeader: 0,
    onPitRoad: false,
    tireCompound: '',
    fastRepairsUsed: 0,
    pitEntryTime: null,
    pitExitTime: null,
    lastPitLap: null,
    lapsSinceLastPit: null,
    estimatedPitDuration: null,
    ...over,
  };
}

function makeRaceState(): RaceState {
  const hero = car({
    carIdx: 0,
    carNumber: '42',
    position: 8,
    classPosition: 8,
    lapDistPct: 0.1,
  }) as HeroState;
  return {
    session: { sessionPhase: 'Racing' } as RaceState['session'],
    field: {
      0: hero,
      3: car({ carIdx: 3, carNumber: '31', position: 6, classPosition: 6 }),
    },
    hero,
    signals: { safeWindowOpen: true, cutWindowOpen: false, activeBattles: [], pitWindowOpen: false },
  };
}

function ev(type: EventType, payload: Record<string, unknown> = {}, lapNumber = 5): RaceEvent {
  return { type, sessionId: 's1', sessionTime: 100, lapNumber, lapDistPct: 0.1, payload };
}

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Harness {
  conn: FakeRedis;
  engineer: RacingEngineerService;
  raceState: RaceState;
  logs: Array<{ msg: string; meta: Record<string, unknown> | undefined }>;
  refs: () => AudioClipRef[];
}

let active: RacingEngineerService | null = null;
let origInfo: typeof logger.info;

beforeEach(() => {
  origInfo = logger.info;
});
afterEach(async () => {
  (logger as unknown as { info: typeof logger.info }).info = origInfo;
  if (active) await active.stop();
  active = null;
});

async function startHarness(config: EngineerConfig = CONFIG): Promise<Harness> {
  const conn = new FakeRedis();
  const raceState = makeRaceState();
  const logs: Harness['logs'] = [];
  (logger as unknown as { info: (m: string, meta?: Record<string, unknown>) => void }).info = (
    m,
    meta,
  ) => logs.push({ msg: m, meta });
  const engineer = new RacingEngineerService(
    conn as unknown as Redis,
    new AudioStore(config.audioIdleCleanupIntervalMs),
    new PriorityMessageQueue(),
    new DedupTracker(),
    () => raceState,
    [],
    config,
    null,
    async () => Buffer.from('mp3'),
  );
  active = engineer;
  await engineer.start();
  return {
    conn,
    engineer,
    raceState,
    logs,
    refs: () =>
      conn.published
        .filter((p) => p.channel === 'voice:audio')
        .map((p) => JSON.parse(p.message) as AudioClipRef),
  };
}

describe('racing-engineer wiring — competitor pit clear signals (US1, FR-003)', () => {
  it('pit_exit clears the entry key AND still fires as a T2-03 alert (dual role, no early return)', async () => {
    const h = await startHarness();
    // Visit 1: entry fires
    h.conn.deliver('hub:events', JSON.stringify(ev('competitor:pit_entry', { carIdx: 3 })));
    await waitUntil(() => h.refs().length >= 1);
    expect(h.refs()[0].eventType).to.equal('competitor:pit_entry');

    // Repeat entry (same visit) is deduplicated, not re-announced
    h.conn.deliver('hub:events', JSON.stringify(ev('competitor:pit_entry', { carIdx: 3 })));
    await waitUntil(() => h.logs.some((l) => l.meta?.event === 'alert_deduplicated'));
    expect(h.refs().length).to.equal(1);

    // Exit fires as an alert (dual role — must NOT be swallowed as clear-signal-only)
    h.conn.deliver('hub:events', JSON.stringify(ev('competitor:pit_exit', { carIdx: 3 })));
    await waitUntil(() => h.refs().length >= 2);
    expect(h.refs()[1].eventType).to.equal('competitor:pit_exit');

    // Visit 2: entry re-announces — the exit cleared competitor:pit_entry:3
    h.conn.deliver('hub:events', JSON.stringify(ev('competitor:pit_entry', { carIdx: 3 })));
    await waitUntil(() => h.refs().length >= 3);
    expect(h.refs()[2].eventType).to.equal('competitor:pit_entry');
  });

  it('pit_entry clears the exit key (second visit exit re-announces)', async () => {
    const h = await startHarness();
    // Visit 1 exit
    h.conn.deliver('hub:events', JSON.stringify(ev('competitor:pit_exit', { carIdx: 3 })));
    await waitUntil(() => h.refs().length >= 1);
    // Repeat exit deduplicated
    h.conn.deliver('hub:events', JSON.stringify(ev('competitor:pit_exit', { carIdx: 3 })));
    await waitUntil(() => h.logs.some((l) => l.meta?.event === 'alert_deduplicated'));
    expect(h.refs().length).to.equal(1);
    // Visit 2: entry (clears exit:3) then exit re-announces
    h.conn.deliver('hub:events', JSON.stringify(ev('competitor:pit_entry', { carIdx: 3 })));
    await waitUntil(() => h.refs().length >= 2);
    h.conn.deliver('hub:events', JSON.stringify(ev('competitor:pit_exit', { carIdx: 3 })));
    await waitUntil(() => h.refs().length >= 3);
    expect(h.refs()[2].eventType).to.equal('competitor:pit_exit');
  });

  it('per-car independence: car 5 pitting is not suppressed by car 3 having pitted', async () => {
    const h = await startHarness();
    h.raceState.field[5] = car({ carIdx: 5, carNumber: '88', position: 9, classPosition: 9 });
    h.conn.deliver('hub:events', JSON.stringify(ev('competitor:pit_entry', { carIdx: 3 })));
    await waitUntil(() => h.refs().length >= 1);
    h.conn.deliver('hub:events', JSON.stringify(ev('competitor:pit_entry', { carIdx: 5 })));
    await waitUntil(() => h.refs().length >= 2);
    expect(h.refs().every((r) => r.eventType === 'competitor:pit_entry')).to.be.true;
  });

  it('coalesced-then-suppressed ordering: Energy=1 logs alerts_coalesced then ONE alert_suppressed', async () => {
    const energy1 = {
      ...CONFIG,
      personality: { ...CONFIG.personality, energy: 1 },
    } as EngineerConfig;
    const h = await startHarness(energy1);
    h.raceState.field[5] = car({ carIdx: 5, carNumber: '88', position: 9, classPosition: 9 });
    // Deliver two entries in the same tick window so both are pending together.
    h.conn.deliver('hub:events', JSON.stringify(ev('competitor:pit_entry', { carIdx: 3 })));
    h.conn.deliver('hub:events', JSON.stringify(ev('competitor:pit_entry', { carIdx: 5 })));
    await waitUntil(() => h.logs.some((l) => l.meta?.event === 'alert_suppressed'));
    const coalesced = h.logs.filter((l) => l.meta?.event === 'alerts_coalesced');
    const suppressed = h.logs.filter((l) => l.meta?.event === 'alert_suppressed');
    expect(coalesced.length).to.equal(1); // merge happened at dequeue, before suppression
    expect(suppressed.length).to.equal(1); // ONE suppression for the merged alert
    expect(h.logs.indexOf(coalesced[0])).to.be.lessThan(h.logs.indexOf(suppressed[0]));
    expect(h.refs().length).to.equal(0); // nothing published
  });
});
