import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { LlmConfig, FuelModel } from '@iracing-engineer/types';
import { runLlm, type StreamChunk, type LlmDeps, type ChatMessage } from '../../../src/engineer/llm-client.js';
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

const fuelModel = { lapsRemaining: 7, burnRatePerLap: 2.6, fuelRemaining: 18, fuelDeficit: 0, confidenceLevel: 'high', dataSource: 'measured' } as unknown as FuelModel;
const tools = createTools({ getFuelModel: () => fuelModel, getTireModel: () => null });
const msgs: ChatMessage[] = [{ role: 'user', content: 'do we pit?' }];

describe('llm-client — runLlm', () => {
  it('streams content deltas and returns the assembled text (onDelta fires)', async () => {
    const deps: LlmDeps = { createStream: async () => streamOf([contentChunk('Box '), contentChunk('this lap.', 'stop')]) };
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
                  delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_fuel_status', arguments: '{}' } }] },
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
