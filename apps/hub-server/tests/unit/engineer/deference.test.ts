import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { RaceState, EngineerConfig, PersonalityConfig } from '@iracing-engineer/types';
import { Tier3Synthesizer, type SynthDeps } from '../../../src/engineer/tier3-synthesizer.js';
import { PriorityMessageQueue } from '../../../src/engineer/message-queue.js';
import { SessionMemoryStore } from '../../../src/engineer/session-memory.js';
import { createTools } from '../../../src/engineer/tools.js';

const CONFIG = {
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

const INFO_MODE_MARKER = 'do NOT give a directive recommendation';

// Synthesizer whose runLlm records the system prompt it was given.
function makeSynth(mem: SessionMemoryStore): { synth: Tier3Synthesizer; lastSystem: () => string } {
  let captured = '';
  const deps: Partial<SynthDeps> = {
    loadPrompt: (n) => `<!-- ${n} -->\nPROMPT-${n} {energy}`,
    recordEvent: async () => 'evt',
    finalizeEvent: async () => {},
    runLlm: async (_c, messages) => {
      captured = messages[0]?.content ?? '';
      return { status: 'ok', text: 'ok', toolsCalled: [], latencyMs: 1 };
    },
  };
  const synth = new Tier3Synthesizer(
    raceState,
    mem,
    createTools({ getFuelModel: () => null, getTireModel: () => null }),
    new PriorityMessageQueue(),
    CONFIG,
    deps,
  );
  return { synth, lastSystem: () => captured };
}

describe('adaptive deference (US5, FR-021 / SC-007)', () => {
  it('unsolicited (proactive) output shifts to information mode once a type is deferred', async () => {
    const mem = new SessionMemoryStore('s1');
    mem.get().deference.deferredTypes.push('pit');
    const { synth, lastSystem } = makeSynth(mem);
    await synth.synthesize({
      type: 'post-sector',
      triggerSource: 'hero:lap_complete',
      userText: 'comment',
      personality: P3,
    });
    expect(lastSystem()).to.include(INFO_MODE_MARKER);
  });

  it('a direct driver-query still gets a directive answer even when deferred', async () => {
    const mem = new SessionMemoryStore('s1');
    mem.get().deference.deferredTypes.push('pit');
    const { synth, lastSystem } = makeSynth(mem);
    await synth.synthesize({
      type: 'driver-query',
      triggerSource: 'q1',
      userText: 'should I pit?',
      personality: P3,
    });
    expect(lastSystem()).to.not.include(INFO_MODE_MARKER);
  });

  it('a new session resets deference — proactive output is directive again', async () => {
    const mem = new SessionMemoryStore('s1');
    mem.get().deference.deferredTypes.push('pit');
    const { synth, lastSystem } = makeSynth(mem);
    mem.reset('s2');
    await synth.synthesize({
      type: 'post-sector',
      triggerSource: 'hero:lap_complete',
      userText: 'comment',
      personality: P3,
    });
    expect(lastSystem()).to.not.include(INFO_MODE_MARKER);
  });
});
