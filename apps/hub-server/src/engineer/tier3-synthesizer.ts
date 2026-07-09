import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  RaceState,
  EngineerConfig,
  PersonalityConfig,
  Tier3Type,
  GenerationTiming,
} from '@iracing-engineer/types';
import { assembleContext } from './context-assembler.js';
import { SentenceStreamSplitter } from './sentence-splitter.js';
import { runLlm, resolveLlmConfig, type ChatMessage } from './llm-client.js';
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
  /** Raw `hub:config:llm` Redis value (M10 T018) — production wiring binds this
   *  to the hub's command connection (server-init); null = key absent, which
   *  falls back to the engineer-config defaults with a once-per-startup warn. */
  getLlmConfigRaw: () => Promise<string | null>;
}

function defaultLoadPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf-8');
}

function defaultDeps(): SynthDeps {
  return {
    runLlm,
    recordEvent,
    finalizeEvent,
    loadPrompt: defaultLoadPrompt,
    getLlmConfigRaw: async () => null,
  };
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
      logger.info('[engineer] Tier 3 suppressed at Energy 1', {
        component: 'engineer',
        event: 'tier3_suppressed',
        type,
      });
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

    // M10 T018 (FR-009): resolve the LLM config for THIS call — one Redis read
    // at the start of the request; the resolved value feeds both the audit row
    // and the LLM call, so an in-flight synthesis never switches models
    // mid-execution (edge case E1) and a saved model change applies to the
    // NEXT call with no restart.
    const llm = await resolveLlmConfig(this.deps.getLlmConfigRaw, this.config.llm);

    // 3. Context assembly (token-budgeted) — includes the recommendation log,
    //    override outcomes, deference state, and fuel calibration (FR-011/018).
    const context = assembleContext(race, this.memory.get(), llm.tokenBudget);

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

    // 5. Audit pre-write (fail-closed — skip synthesis if the row cannot be
    //    written). Records the LLM resolved for this call (FR-029/T043).
    let eventId: string;
    try {
      eventId = await this.deps.recordEvent({
        sessionId,
        tier3Type: type,
        prompt: `${system}\n\n${contextMsg}`,
        llmModel: llm.model,
        llmBaseUrl: llm.baseUrl,
      });
    } catch {
      logger.warn('[engineer] Tier 3 skipped — audit pre-write failed', {
        component: 'engineer',
        event: 'tier3_skipped_audit',
        type,
      });
      return;
    }

    // 6–7. Stream → split → enqueue each completed sentence. A single timing handle
    // is shared (by reference) across every sentence clip so the dispatcher can
    // report inference + audio timings on publish; inferenceMs is filled in once the
    // LLM call returns (below).
    const timing: GenerationTiming = {
      genId: randomUUID(),
      startedAt: performance.now(),
      inferenceMs: null,
    };
    logger.info('[engineer] Inference triggered', {
      component: 'engineer',
      event: 'inference_triggered',
      type,
      triggerSource: input.triggerSource,
      genId: timing.genId,
    });

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
        timing,
      });
    };

    const result = await this.deps.runLlm(llm, messages, this.tools, {
      onDelta: (t) => {
        for (const s of splitter.push(t)) enqueueSentence(s);
      },
    });

    // Inference finished — stamp the handle (visible to clips still queued) and log.
    timing.inferenceMs = Math.round(performance.now() - timing.startedAt);
    const toolsCalled = result.status === 'ok' ? result.toolsCalled : [];
    logger.info('[engineer] Inference complete', {
      component: 'engineer',
      event: 'inference_complete',
      type,
      genId: timing.genId,
      status: result.status,
      inferenceMs: timing.inferenceMs,
      sentences: sentenceIndex,
      toolsCalled,
      // Scalar mirror of toolsCalled — Loki's json parser skips arrays, so this is
      // the field to unwrap/alert on (e.g. tool-call rate, "0 tools" detection).
      toolsCalledCount: toolsCalled.length,
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

    // T018/U1: the endpoint RESPONDED with an HTTP error (e.g. 404 from a
    // model-name typo, 401 from a cloud endpoint). Suppress Tier 3 output
    // ENTIRELY — no canned line, no fallback to a previous model, no silent
    // retry. The driver fixes the model via the UI; the next call uses it.
    if (result.status === 'unreachable' && result.httpStatus !== undefined) {
      logger.warn('[engineer] Tier 3 synthesis failed — LLM endpoint returned an error', {
        component: 'engineer',
        event: 'llm-synthesis-failed',
        model: llm.model,
        reason: result.error,
        statusCode: result.httpStatus,
      });
      await this.deps.finalizeEvent(eventId, {
        response: null,
        latencyMs: null,
        toolsCalled: [],
        outcome: 'skipped-llm-unreachable',
      });
      return;
    }

    // LLM unreachable/timeout — skip proactive; canned line for a driver-query (FR-023).
    logger.warn('[engineer] Tier 3 skipped — LLM unavailable', {
      component: 'engineer',
      event: 'tier3_skipped_llm',
      type,
      reason: result.status,
    });
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
        timing,
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
