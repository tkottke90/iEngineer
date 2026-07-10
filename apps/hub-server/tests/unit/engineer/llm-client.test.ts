import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { LlmConfig, FuelModel } from '@iracing-engineer/types';
import {
  runLlm,
  type StreamChunk,
  type LlmDeps,
  type ChatMessage,
} from '../../../src/engineer/llm-client.js';
import { createTools } from '../../../src/engineer/tools.js';

const CONFIG: LlmConfig = {
  baseUrl: 'http://test',
  model: 'test-model',
  provider: 'openai-compatible',
  timeoutMs: 1000,
  maxResponseTokens: 300,
  tokenBudget: 6000,
};

function streamOf(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function contentChunk(text: string, finish: string | null = null): StreamChunk {
  return { choices: [{ delta: { content: text }, finish_reason: finish }] };
}

const fuelModel = {
  lapsRemaining: 7,
  burnRatePerLap: 2.6,
  fuelRemaining: 18,
  fuelDeficit: 0,
  confidenceLevel: 'high',
  dataSource: 'measured',
} as unknown as FuelModel;
const tools = createTools({ getFuelModel: () => fuelModel, getTireModel: () => null });
const msgs: ChatMessage[] = [{ role: 'user', content: 'do we pit?' }];

describe('llm-client — runLlm', () => {
  it('streams content deltas and returns the assembled text (onDelta fires)', async () => {
    const deps: LlmDeps = {
      createStream: async () => streamOf([contentChunk('Box '), contentChunk('this lap.', 'stop')]),
    };
    const deltas: string[] = [];
    const r = await runLlm(CONFIG, msgs, tools, { deps, onDelta: (t) => deltas.push(t) });
    expect(r.status).to.equal('ok');
    if (r.status === 'ok') {
      expect(r.text).to.equal('Box this lap.');
      expect(r.toolsCalled).to.deep.equal([]);
    }
    expect(deltas).to.deep.equal(['Box ', 'this lap.']);
  });

  it('executes a tool call then answers (tool loop)', async () => {
    let call = 0;
    const deps: LlmDeps = {
      createStream: async () => {
        call += 1;
        if (call === 1) {
          // round 1: request get_fuel_status
          return streamOf([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'c1',
                        function: { name: 'get_fuel_status', arguments: '{}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ]);
        }
        // round 2: final answer
        return streamOf([contentChunk('Seven laps of fuel, box now.', 'stop')]);
      },
    };
    const r = await runLlm(CONFIG, msgs, tools, { deps });
    expect(r.status).to.equal('ok');
    if (r.status === 'ok') {
      expect(r.toolsCalled).to.deep.equal(['get_fuel_status']);
      expect(r.text).to.include('Seven laps');
    }
  });

  it('returns timeout when the stream hangs past timeoutMs', async () => {
    const deps: LlmDeps = { createStream: () => new Promise<AsyncIterable<StreamChunk>>(() => {}) };
    const r = await runLlm({ ...CONFIG, timeoutMs: 20 }, msgs, tools, { deps });
    expect(r.status).to.equal('timeout');
  });

  it('returns unreachable when the endpoint errors', async () => {
    const deps: LlmDeps = {
      createStream: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const r = await runLlm(CONFIG, msgs, tools, { deps });
    expect(r.status).to.equal('unreachable');
    if (r.status === 'unreachable') expect(r.error).to.include('ECONNREFUSED');
  });
});

// ─── M10 T018/T021: hub:config:llm resolution ───────────────────────────────

import type { LlmConfig } from '@iracing-engineer/types';
import {
  parseLlmConfig,
  resolveLlmConfig,
  _resetLlmConfigWarnings,
} from '../../../src/engineer/llm-client.js';
import { logger } from '../../../src/logger.js';

const FALLBACK: LlmConfig = {
  baseUrl: 'http://fallback/v1',
  model: 'fallback-model',
  provider: 'openai-compatible',
  timeoutMs: 8000,
  maxResponseTokens: 300,
  tokenBudget: 6000,
};

function captureWarns(): { warns: string[]; restore: () => void } {
  const warns: string[] = [];
  const orig = logger.warn;
  (logger as unknown as { warn: (m: string) => void }).warn = (m: string) => warns.push(String(m));
  return {
    warns,
    restore: () => {
      (logger as unknown as { warn: typeof logger.warn }).warn = orig;
    },
  };
}

describe('llm-client — parseLlmConfig / resolveLlmConfig (M10 T018, tested per T021)', () => {
  beforeEach(() => _resetLlmConfigWarnings());

  it('absent key → config defaults + exactly one warn per startup', async () => {
    const { warns, restore } = captureWarns();
    try {
      const first = await resolveLlmConfig(async () => null, FALLBACK);
      const second = await resolveLlmConfig(async () => null, FALLBACK);
      expect(first.model).to.equal('fallback-model');
      expect(first.baseUrl).to.equal('http://fallback/v1');
      expect(second.model).to.equal('fallback-model');
      const fallbackWarns = warns.filter((w) => w.includes('absent'));
      expect(fallbackWarns, 'one warn per startup, not per call').to.have.length(1);
    } finally {
      restore();
    }
  });

  it('present key with valid JSON → baseUrl/model applied on the next call', async () => {
    const raw = JSON.stringify({ baseUrl: 'http://new/v1', model: 'new-model' });
    const resolved = await resolveLlmConfig(async () => raw, FALLBACK);
    expect(resolved.model).to.equal('new-model');
    expect(resolved.baseUrl).to.equal('http://new/v1');
    // Static fields always come from the fallback config.
    expect(resolved.timeoutMs).to.equal(8000);
    expect(resolved.tokenBudget).to.equal(6000);
  });

  it('malformed JSON → config defaults + one warn', async () => {
    const { warns, restore } = captureWarns();
    try {
      const resolved = await resolveLlmConfig(async () => '{not json', FALLBACK);
      expect(resolved.model).to.equal('fallback-model');
      await resolveLlmConfig(async () => '{not json', FALLBACK);
      expect(warns.filter((w) => w.includes('malformed'))).to.have.length(1);
    } finally {
      restore();
    }
  });

  it('C3 (FR-009 no-restart): a key change between calls is applied — no process restart simulated', async () => {
    let raw = JSON.stringify({ baseUrl: 'x', model: 'model-A' });
    const getRaw = async () => raw;
    const first = await resolveLlmConfig(getRaw, FALLBACK);
    raw = JSON.stringify({ baseUrl: 'x', model: 'model-B' });
    const second = await resolveLlmConfig(getRaw, FALLBACK);
    expect(first.model).to.equal('model-A');
    expect(second.model).to.equal('model-B');
  });

  it('C2 (contract): apiKey is never read from the Redis value — a stray one is ignored', async () => {
    const raw = JSON.stringify({ baseUrl: 'http://new/v1', model: 'new-model', apiKey: 'sk-leak' });
    const resolved = await resolveLlmConfig(async () => raw, FALLBACK);
    expect(resolved).to.not.have.property('apiKey');
    expect(JSON.stringify(resolved)).to.not.include('sk-leak');
  });

  it('per-field fallback: an empty or missing field falls back individually', () => {
    const { config } = parseLlmConfig(JSON.stringify({ model: 'only-model' }), FALLBACK);
    expect(config.model).to.equal('only-model');
    expect(config.baseUrl).to.equal('http://fallback/v1');
    const { config: c2 } = parseLlmConfig(JSON.stringify({ baseUrl: '', model: '' }), FALLBACK);
    expect(c2.baseUrl).to.equal('http://fallback/v1');
    expect(c2.model).to.equal('fallback-model');
  });

  it('a throwing getter (Redis down) degrades to the absent-key path', async () => {
    const resolved = await resolveLlmConfig(async () => {
      throw new Error('redis down');
    }, FALLBACK);
    expect(resolved.model).to.equal('fallback-model');
  });
});
