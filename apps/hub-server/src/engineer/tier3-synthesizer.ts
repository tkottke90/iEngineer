import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  RaceState,
  EngineerConfig,
  PersonalityConfig,
  Tier3Type,
} from '@iracing-engineer/types';
import { assembleContext } from './context-assembler.js';
import { SentenceStreamSplitter } from './sentence-splitter.js';
import { runLlm, type ChatMessage } from './llm-client.js';
import { recordEvent, finalizeEvent } from './engineer-events.js';
import type { Tools } from './tools.js';
import type { SessionMemoryStore } from './session-memory.js';
import { PriorityMessageQueue } from './message-queue.js';
import { logger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '..', '..', 'prompts');

// Seam for tests: production reads prompt files, hits the LLM, and writes Postgres.
export interface SynthDeps {
  runLlm: typeof runLlm;
  recordEvent: typeof recordEvent;
  finalizeEvent: typeof finalizeEvent;
  loadPrompt: (name: string) => string;
}

function defaultLoadPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf-8');
}

function defaultDeps(): SynthDeps {
  return { runLlm, recordEvent, finalizeEvent, loadPrompt: defaultLoadPrompt };
}

export interface SynthesizeInput {
  type: Tier3Type;
  triggerSource: string; // queryId | event type
  userText: string; // the driver's question, or the proactive task instruction
  personality: PersonalityConfig;
}

/**
 * Turns a trigger + context into spoken Tier 3 audio (Model A): assembles context,
 * builds the versioned prompt, writes the audit row BEFORE acting, streams the LLM
 * answer sentence-by-sentence, and enqueues each sentence as a QueuedTier3 for the
 * dispatcher to TTS + publish. Degrades to skip-with-log / canned line when the LLM
 * is unreachable (FR-023). See contracts/tier3-synthesis.md.
 */
export class Tier3Synthesizer {
  private deps: SynthDeps;

  constructor(
    private getRaceState: () => RaceState,
    private memory: SessionMemoryStore,
    private tools: Tools,
    private queue: PriorityMessageQueue,
    private config: EngineerConfig,
    deps: Partial<SynthDeps> = {},
  ) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  async synthesize(input: SynthesizeInput): Promise<void> {
    const { type, personality } = input;

    // 1. Suppression — Energy=1 (Tranquil) suppresses proactive commentary, but a
    //    direct driver-query is always answered.
    if (personality.energy === 1 && type !== 'driver-query') {
      logger.info('[engineer] Tier 3 suppressed at Energy 1', { type });
      return;
    }

    // 2. Deference (FR-021) — after repeated overrides of a recommendation type,
    //    unsolicited output shifts to information mode; a direct driver-query still
    //    gets a directive answer.
    const informationMode =
      type !== 'driver-query' && this.memory.get().deference.deferredTypes.length > 0;

    const race = this.getRaceState();
    const sessionId = race.session?.sessionId ?? '';

    // Refresh session memory with the latest M3 fuel calibration so the context
    // reflects current model state (US6, T062).
    const fuel = this.tools.run('get_fuel_status');
    if (fuel.available) this.memory.setFuelCalibration(fuel.data ?? null);

    // 3. Context assembly (token-budgeted) — includes the recommendation log,
    //    override outcomes, deference state, and fuel calibration (FR-011/018).
    const context = assembleContext(race, this.memory.get(), this.config.llm.tokenBudget);

    // 4. Prompt build (versioned files + personality substitution).
    const system = this.buildSystemPrompt(personality, type, informationMode);
    const contextMsg = `${input.userText}\n\nRace context:\n${JSON.stringify({
      raceState: context.raceState,
      memory: context.memoryExcerpt,
    })}`;
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: contextMsg },
    ];

    // 5. Audit pre-write (fail-closed — skip synthesis if the row cannot be written).
    let eventId: string;
    try {
      eventId = await this.deps.recordEvent({
        sessionId,
        tier3Type: type,
        prompt: `${system}\n\n${contextMsg}`,
      });
    } catch {
      logger.warn('[engineer] Tier 3 skipped — audit pre-write failed', { type });
      return;
    }

    // 6–7. Stream → split → enqueue each completed sentence.
    const splitter = new SentenceStreamSplitter();
    let sentenceIndex = 0;
    const enqueueSentence = (text: string): void => {
      const clean = text.trim();
      if (!clean) return;
      this.queue.enqueue({
        tier: 3,
        tier3Type: type,
        messageText: clean,
        sentenceIndex: sentenceIndex++,
      });
    };

    const result = await this.deps.runLlm(this.config.llm, messages, this.tools, {
      onDelta: (t) => {
        for (const s of splitter.push(t)) enqueueSentence(s);
      },
    });

    // 8. Finalize audit + degradation.
    if (result.status === 'ok') {
      const trailing = splitter.flush();
      if (trailing) enqueueSentence(trailing);
      await this.deps.finalizeEvent(eventId, {
        response: result.text,
        latencyMs: result.latencyMs,
        toolsCalled: result.toolsCalled,
        outcome: 'synthesized',
      });
      return;
    }

    // LLM unreachable/timeout — skip proactive; canned line for a driver-query (FR-023).
    logger.warn('[engineer] Tier 3 skipped — LLM unavailable', { type, reason: result.status });
    await this.deps.finalizeEvent(eventId, {
      response: null,
      latencyMs: null,
      toolsCalled: [],
      outcome: 'skipped-llm-unreachable',
    });
    if (type === 'driver-query') {
      this.queue.enqueue({
        tier: 3,
        tier3Type: type,
        messageText: 'Reasoning engine unavailable.',
        sentenceIndex: 0,
      });
    }
  }

  private buildSystemPrompt(
    p: PersonalityConfig,
    type: Tier3Type,
    informationMode = false,
  ): string {
    const strip = (s: string): string => s.replace(/<!--[\s\S]*?-->/g, '').trim();
    const base = strip(this.deps.loadPrompt('system-base'));
    const persona = strip(this.deps.loadPrompt('personality'))
      .replaceAll('{openness}', String(p.openness))
      .replaceAll('{warmth}', String(p.warmth))
      .replaceAll('{energy}', String(p.energy))
      .replaceAll('{conscientiousness}', String(p.conscientiousness))
      .replaceAll('{assertiveness}', String(p.assertiveness));
    // Per-type task prompt is best-effort — its file may not exist yet (added per
    // story: T037 driver-query, T046–T048 proactive). Fall back to base only.
    let task = '';
    try {
      task = strip(this.deps.loadPrompt(`tier3-${type}`));
    } catch {
      task = '';
    }
    const deference = informationMode
      ? 'The driver has repeatedly declined your recommendations this session. Present the relevant information and let them decide — do NOT give a directive recommendation.'
      : '';
    return [base, persona, task, deference].filter(Boolean).join('\n\n');
  }
}
