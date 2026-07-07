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
import { OverrideTracker } from '../../../src/engineer/override-tracker.js';
import { createTools } from '../../../src/engineer/tools.js';

const CONFIG = {
  deferenceThreshold: 2,
  llm: {
    tokenBudget: 6000,
    timeoutMs: 1000,
    maxResponseTokens: 300,
    baseUrl: 'x',
    model: 'm',
    provider: 'openai-compatible',
  },
} as unknown as EngineerConfig;
const P3: PersonalityConfig = {
  openness: 3,
  warmth: 3,
  energy: 3,
  conscientiousness: 3,
  assertiveness: 3,
};
const fuelModel = {
  lapsRemaining: 3,
  burnRatePerLap: 2.6,
  fuelRemaining: 8,
  fuelDeficit: 1.2,
  confidenceLevel: 'high',
  dataSource: 'measured',
  lapsSinceCalibration: 4,
} as unknown as FuelModel;

function raceState(): RaceState {
  return {
    session: { sessionId: 's1', sessionPhase: 'Race', lapsRemaining: 20, flags: 0 },
    field: {},
    hero: {
      position: 4,
      lapDistPct: 0.5,
      fuelLevel: 8,
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

function makeSynth(mem: SessionMemoryStore): { synth: Tier3Synthesizer; userMsg: () => string } {
  let captured = '';
  const deps: Partial<SynthDeps> = {
    loadPrompt: (n) => `<!-- ${n} -->\n{energy}`,
    recordEvent: async () => 'evt',
    finalizeEvent: async () => {},
    runLlm: async (_c, messages) => {
      captured = messages[1]?.content ?? ''; // the context/user message
      return { status: 'ok', text: 'ok', toolsCalled: [], latencyMs: 1 };
    },
  };
  const synth = new Tier3Synthesizer(
    raceState,
    mem,
    createTools({ getFuelModel: () => fuelModel, getTireModel: () => null }),
    new PriorityMessageQueue(),
    CONFIG,
    deps,
  );
  return { synth, userMsg: () => captured };
}

describe('session memory in reasoning (US6, FR-011/018)', () => {
  it('an earlier recommendation + override outcome is surfaced in the reasoning context', async () => {
    const mem = new SessionMemoryStore('s1');
    const tracker = new OverrideTracker(mem, 2);
    tracker.recordRecommendation('pit', 12);
    tracker.onLapComplete(12); // overridden

    const { synth, userMsg } = makeSynth(mem);
    await synth.synthesize({
      type: 'driver-query',
      triggerSource: 'q1',
      userText: 'and now?',
      personality: P3,
    });

    const ctx = userMsg();
    expect(ctx).to.include('overridden'); // the outcome is in context
    expect(ctx).to.include('recommendedLap'); // the recommendation window is present
  });

  it('populates the fuel calibration from the M3 model into the context', async () => {
    const mem = new SessionMemoryStore('s1');
    const { synth, userMsg } = makeSynth(mem);
    await synth.synthesize({
      type: 'driver-query',
      triggerSource: 'q1',
      userText: 'fuel?',
      personality: P3,
    });
    // memory now carries the calibration…
    expect(mem.get().fuelCalibration).to.not.equal(null);
    // …and it is present in the assembled context.
    expect(userMsg()).to.include('burnRatePerLap');
  });
});
