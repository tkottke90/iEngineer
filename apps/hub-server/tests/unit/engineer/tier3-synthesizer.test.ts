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

// Deps that record call order, capture audit + LLM-call inputs, and script the
// LLM stream.
function deps(
  llmResult: LlmResult,
  streamText: string[],
  llmConfigRaw: string | null = null,
): {
  deps: Partial<SynthDeps>;
  order: string[];
  finalized: { outcome?: string; response?: string | null };
  recorded: { llmModel?: string; llmBaseUrl?: string };
  llmCalledWith: { model?: string; baseUrl?: string };
} {
  const order: string[] = [];
  const finalized: { outcome?: string; response?: string | null } = {};
  const recorded: { llmModel?: string; llmBaseUrl?: string } = {};
  const llmCalledWith: { model?: string; baseUrl?: string } = {};
  return {
    order,
    finalized,
    recorded,
    llmCalledWith,
    deps: {
      loadPrompt: (name) => `<!-- ${name} -->\nPROMPT ${name} {energy}`,
      getLlmConfigRaw: async () => llmConfigRaw,
      recordEvent: async (input) => {
        order.push('record');
        recorded.llmModel = input.llmModel;
        recorded.llmBaseUrl = input.llmBaseUrl;
        return 'evt-1';
      },
      finalizeEvent: async (_id, input) => {
        order.push('finalize');
        finalized.outcome = input.outcome;
        finalized.response = input.response;
      },
      runLlm: async (c, _m, _t, opts) => {
        llmCalledWith.model = c.model;
        llmCalledWith.baseUrl = c.baseUrl;
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

describe('Tier3Synthesizer — LLM audit fields + runtime config (M10 T043/T018)', () => {
  const mk = (llmResult: LlmResult, raw: string | null) => {
    const queue = new PriorityMessageQueue();
    const d = deps(llmResult, [], raw);
    const synth = new Tier3Synthesizer(
      raceState,
      new SessionMemoryStore('s1'),
      createTools({ getFuelModel: () => null, getTireModel: () => null }),
      queue,
      CONFIG,
      d.deps,
    );
    return { synth, queue, ...d };
  };

  it('T043/D1 (FR-029): the audit row records the model + baseUrl resolved from hub:config:llm', async () => {
    const ok: LlmResult = { status: 'ok', text: 'Copy.', toolsCalled: [], latencyMs: 3 };
    const { synth, recorded, llmCalledWith } = mk(
      ok,
      JSON.stringify({ baseUrl: 'http://redis-llm/v1', model: 'redis-model' }),
    );

    await synth.synthesize({
      type: 'driver-query',
      triggerSource: 'q1',
      userText: 'fuel?',
      personality: P3,
    });

    expect(recorded.llmModel).to.equal('redis-model');
    expect(recorded.llmBaseUrl).to.equal('http://redis-llm/v1');
    // The LLM call itself used the same resolved config (one read per request).
    expect(llmCalledWith.model).to.equal('redis-model');
    expect(llmCalledWith.baseUrl).to.equal('http://redis-llm/v1');
  });

  it('T043/D1: falls back to engineer-config values in the audit row when the key is absent', async () => {
    const ok: LlmResult = { status: 'ok', text: 'Copy.', toolsCalled: [], latencyMs: 3 };
    const { synth, recorded } = mk(ok, null);

    await synth.synthesize({
      type: 'driver-query',
      triggerSource: 'q1',
      userText: 'fuel?',
      personality: P3,
    });

    expect(recorded.llmModel).to.equal('m'); // CONFIG.llm.model
    expect(recorded.llmBaseUrl).to.equal('x'); // CONFIG.llm.baseUrl
  });

  it('T018/U1: an HTTP-status LLM failure (e.g. 404 model typo) suppresses output entirely — no canned line, no fallback', async () => {
    const httpFail: LlmResult = {
      status: 'unreachable',
      error: '404 model not found',
      httpStatus: 404,
    };
    const { synth, queue, finalized } = mk(
      httpFail,
      JSON.stringify({ baseUrl: 'http://redis-llm/v1', model: 'typo-model' }),
    );

    await synth.synthesize({
      type: 'driver-query',
      triggerSource: 'q1',
      userText: 'fuel?',
      personality: P3,
    });

    expect(finalized.outcome).to.equal('skipped-llm-unreachable');
    expect(queue.length, 'full suppression — not even the canned line').to.equal(0);
  });

  it('E1 (in-flight isolation): the config is resolved once at call start; the next call picks up a changed key', async () => {
    // getLlmConfigRaw returns model-A for the first call, model-B afterwards —
    // simulating a Save landing between (or during) calls.
    let call = 0;
    const order: string[] = [];
    const models: string[] = [];
    const llmModels: string[] = [];
    const queue = new PriorityMessageQueue();
    const synth = new Tier3Synthesizer(
      raceState,
      new SessionMemoryStore('s1'),
      createTools({ getFuelModel: () => null, getTireModel: () => null }),
      queue,
      CONFIG,
      {
        loadPrompt: (name) => `PROMPT ${name}`,
        getLlmConfigRaw: async () => {
          call += 1;
          return JSON.stringify({ baseUrl: 'x', model: call === 1 ? 'model-A' : 'model-B' });
        },
        recordEvent: async (input) => {
          order.push('record');
          models.push(input.llmModel);
          return `evt-${call}`;
        },
        finalizeEvent: async () => {
          order.push('finalize');
        },
        runLlm: async (c) => {
          llmModels.push(c.model);
          return { status: 'ok', text: 'Copy.', toolsCalled: [], latencyMs: 1 };
        },
      },
    );

    const input = {
      type: 'driver-query' as const,
      triggerSource: 'q1',
      userText: 'fuel?',
      personality: P3,
    };
    await synth.synthesize(input);
    await synth.synthesize(input);

    // First call resolved model-A and used it end-to-end (audit + LLM call) —
    // no mid-call re-read; the second call picked up model-B.
    expect(models).to.deep.equal(['model-A', 'model-B']);
    expect(llmModels).to.deep.equal(['model-A', 'model-B']);
  });
});
