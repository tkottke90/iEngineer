import { describe, it } from 'mocha';
import { expect } from 'chai';
import type {
  RaceState,
  EngineerConfig,
  PersonalityConfig,
  FuelModel,
} from '@iracing-engineer/types';
import { Tier3Synthesizer, type SynthDeps } from '../../../src/engineer/tier3-synthesizer.js';
import { PriorityMessageQueue } from '../../../src/engineer/message-queue.js';
import { SessionMemoryStore } from '../../../src/engineer/session-memory.js';
import { createTools } from '../../../src/engineer/tools.js';
import type { LlmResult } from '../../../src/engineer/llm-client.js';

const CONFIG = {
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

const fuelModel = {
  lapsRemaining: 7,
  burnRatePerLap: 2.6,
  fuelRemaining: 18,
  fuelDeficit: 0,
  confidenceLevel: 'high',
  dataSource: 'measured',
} as unknown as FuelModel;
const P3: PersonalityConfig = {
  openness: 3,
  warmth: 3,
  energy: 3,
  conscientiousness: 3,
  assertiveness: 3,
};

// Deps that record call order and script the LLM stream.
function deps(
  llmResult: LlmResult,
  streamText: string[],
): {
  deps: Partial<SynthDeps>;
  order: string[];
  finalized: { outcome?: string; response?: string | null };
} {
  const order: string[] = [];
  const finalized: { outcome?: string; response?: string | null } = {};
  return {
    order,
    finalized,
    deps: {
      loadPrompt: (name) => `<!-- ${name} -->\nPROMPT ${name} {energy}`,
      recordEvent: async () => {
        order.push('record');
        return 'evt-1';
      },
      finalizeEvent: async (_id, input) => {
        order.push('finalize');
        finalized.outcome = input.outcome;
        finalized.response = input.response;
      },
      runLlm: async (_c, _m, _t, opts) => {
        for (const chunk of streamText) opts?.onDelta?.(chunk);
        return llmResult;
      },
    },
  };
}

describe('Tier3Synthesizer — happy path (T029/T030)', () => {
  it('audits before acting, enqueues per-sentence Tier 3 clips, finalizes synthesized', async () => {
    const queue = new PriorityMessageQueue();
    const memory = new SessionMemoryStore('s1');
    const tools = createTools({ getFuelModel: () => fuelModel, getTireModel: () => null });
    const {
      deps: d,
      order,
      finalized,
    } = deps(
      {
        status: 'ok',
        text: 'Box this lap. Fuel is tight.',
        toolsCalled: ['get_fuel_status'],
        latencyMs: 12,
      },
      ['Box this lap. ', 'Fuel is tight.'],
    );
    const synth = new Tier3Synthesizer(raceState, memory, tools, queue, CONFIG, d);

    await synth.synthesize({
      type: 'driver-query',
      triggerSource: 'q1',
      userText: 'do we pit?',
      personality: P3,
    });

    // write-before-act
    expect(order).to.deep.equal(['record', 'finalize']);
    expect(finalized.outcome).to.equal('synthesized');
    // two sentence clips enqueued as Tier 3
    const first = queue.dequeueNext(0.1, []);
    const second = queue.dequeueNext(0.1, []);
    expect(first?.tier === 3 && first.messageText).to.equal('Box this lap.');
    expect(second?.tier === 3 && second.messageText).to.equal('Fuel is tight.');
  });
});

describe('Tier3Synthesizer — degradation + suppression', () => {
  it('LLM unreachable: finalizes skipped and enqueues a canned line for a driver-query (FR-023)', async () => {
    const queue = new PriorityMessageQueue();
    const { deps: d, finalized } = deps({ status: 'unreachable', error: 'ECONNREFUSED' }, []);
    const synth = new Tier3Synthesizer(
      raceState,
      new SessionMemoryStore('s1'),
      createTools({ getFuelModel: () => null, getTireModel: () => null }),
      queue,
      CONFIG,
      d,
    );

    await synth.synthesize({
      type: 'driver-query',
      triggerSource: 'q1',
      userText: 'do we pit?',
      personality: P3,
    });

    expect(finalized.outcome).to.equal('skipped-llm-unreachable');
    const canned = queue.dequeueNext(0.1, []);
    expect(canned?.tier === 3 && canned.messageText).to.match(/unavailable/i);
  });

  it('Energy=1 suppresses proactive commentary (no audit, no enqueue)', async () => {
    const queue = new PriorityMessageQueue();
    const { deps: d, order } = deps({ status: 'ok', text: '', toolsCalled: [], latencyMs: 1 }, []);
    const synth = new Tier3Synthesizer(
      raceState,
      new SessionMemoryStore('s1'),
      createTools({ getFuelModel: () => null, getTireModel: () => null }),
      queue,
      CONFIG,
      d,
    );

    await synth.synthesize({
      type: 'post-sector',
      triggerSource: 'hero:lap_complete',
      userText: 'comment on the lap',
      personality: { ...P3, energy: 1 },
    });

    expect(order).to.deep.equal([]); // suppressed before audit
    expect(queue.length).to.equal(0);
  });

  it('Energy=1 still answers a direct driver-query', async () => {
    const queue = new PriorityMessageQueue();
    const { deps: d, order } = deps(
      { status: 'ok', text: 'Yes, box now.', toolsCalled: [], latencyMs: 5 },
      ['Yes, box now. '],
    );
    const synth = new Tier3Synthesizer(
      raceState,
      new SessionMemoryStore('s1'),
      createTools({ getFuelModel: () => null, getTireModel: () => null }),
      queue,
      CONFIG,
      d,
    );

    await synth.synthesize({
      type: 'driver-query',
      triggerSource: 'q1',
      userText: 'should I pit?',
      personality: { ...P3, energy: 1 },
    });

    expect(order).to.deep.equal(['record', 'finalize']);
    expect(queue.length).to.equal(1);
  });
});
