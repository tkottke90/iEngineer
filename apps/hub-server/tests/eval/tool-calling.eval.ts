import { describe, it, before } from 'mocha';
import { expect } from 'chai';
import type { FuelModel, TireModel } from '@iracing-engineer/types';
import { runLlm, type ChatMessage } from '../../src/engineer/llm-client.js';
import { createTools } from '../../src/engineer/tools.js';
import { EVAL_LLM, llmReachable } from './eval-config.js';

// Fixed model snapshots so the eval is deterministic modulo the LLM.
const fuel = { lapsRemaining: 3, burnRatePerLap: 2.6, fuelRemaining: 8, fuelDeficit: 1.2, confidenceLevel: 'high', dataSource: 'measured' } as unknown as FuelModel;
const tire = { compound: 'soft', lapAge: 12, setsRemaining: 2, paceDegradationTrend: 0.05, degradationSignal: 'degrading', degradationConfidence: 'high' } as unknown as TireModel;
const tools = createTools({ getFuelModel: () => fuel, getTireModel: () => tire });
const system: ChatMessage = {
  role: 'system',
  content: 'You are a race engineer. Use the provided tools for any fuel or tire figures; never invent numbers.',
};

// Runs against the live LLM via `npm run eval` (NOT part of npm test / CI). Skips
// gracefully when the endpoint is offline. Validates FR-007 (tools are called, no
// fabrication) per Constitution VI.
describe('EVAL: tool-calling correctness (Constitution VI)', function () {
  this.timeout(120_000);

  before(async function () {
    if (!(await llmReachable())) {
      // eslint-disable-next-line no-console
      console.warn(`[skip] LLM unreachable at ${EVAL_LLM.baseUrl} — skipping tool-calling eval`);
      this.skip();
    }
  });

  const fuelQuestions = ['How much fuel do we have left?', 'Do we have enough fuel to finish?'];
  for (const q of fuelQuestions) {
    it(`fuel question calls get_fuel_status: "${q}"`, async () => {
      const r = await runLlm(EVAL_LLM, [system, { role: 'user', content: q }], tools);
      expect(r.status).to.equal('ok');
      if (r.status === 'ok') expect(r.toolsCalled).to.include('get_fuel_status');
    });
  }

  const tireQuestions = ['How are the tires holding up?', "What's my tire degradation like?"];
  for (const q of tireQuestions) {
    it(`tire question calls get_tire_status: "${q}"`, async () => {
      const r = await runLlm(EVAL_LLM, [system, { role: 'user', content: q }], tools);
      expect(r.status).to.equal('ok');
      if (r.status === 'ok') expect(r.toolsCalled).to.include('get_tire_status');
    });
  }
});
