import OpenAI from 'openai';
import type { LlmConfig } from '@iracing-engineer/types';
import type { Tools } from './tools.js';
import { logger } from '../logger.js';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface StreamChunk {
  choices: Array<{
    delta: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  maxTokens: number;
  signal: AbortSignal;
}

// Seam for tests: production uses the OpenAI SDK; tests inject a scripted stream.
export interface LlmDeps {
  createStream: (params: ChatParams) => Promise<AsyncIterable<StreamChunk>>;
}

export type LlmResult =
  | { status: 'ok'; text: string; toolsCalled: string[]; latencyMs: number }
  | { status: 'timeout' }
  // httpStatus present = the endpoint RESPONDED with an error (e.g. 404 from a
  // model-name typo) — the T018/U1 degraded-mode branch in the synthesizer
  // suppresses Tier 3 entirely for these; absent = network-level failure
  // (connection refused), which keeps M5's canned-line behavior (FR-023).
  | { status: 'unreachable'; error: string; httpStatus?: number };

// ─── M10 T018: per-request LLM config from hub:config:llm ───────────────────

export type LlmConfigSource = 'redis' | 'absent' | 'malformed';

/**
 * Merge the raw `hub:config:llm` Redis value over the engineer-config fallback.
 * Only `baseUrl` and `model` are runtime-switchable (per-field: an invalid or
 * missing field falls back individually); provider/timeouts/budgets always come
 * from the static config. `apiKey` is NEVER read from Redis — the write
 * contract (contracts/hub-llm-config.md) excludes it and this parser ignores
 * any stray value (C2).
 */
export function parseLlmConfig(
  raw: string | null | undefined,
  fallback: LlmConfig,
): { config: LlmConfig; source: LlmConfigSource } {
  if (raw === null || raw === undefined || raw === '') {
    return { config: { ...fallback }, source: 'absent' };
  }
  let parsed: { baseUrl?: unknown; model?: unknown };
  try {
    parsed = JSON.parse(raw) as { baseUrl?: unknown; model?: unknown };
  } catch {
    return { config: { ...fallback }, source: 'malformed' };
  }
  const str = (v: unknown, d: string): string =>
    typeof v === 'string' && v.length > 0 ? v : d;
  return {
    config: {
      ...fallback,
      baseUrl: str(parsed.baseUrl, fallback.baseUrl),
      model: str(parsed.model, fallback.model),
    },
    source: 'redis',
  };
}

// One warn per fallback type per startup (T018) — mirrors the
// _personalityWarnEmitted pattern in racing-engineer.ts.
const llmConfigWarned = { absent: false, malformed: false };

/** Test hook: reset the once-per-startup warn guards. */
export function _resetLlmConfigWarnings(): void {
  llmConfigWarned.absent = false;
  llmConfigWarned.malformed = false;
}

/**
 * Resolve the LLM config for ONE synthesis call: read `hub:config:llm` (via the
 * injected getter — the caller owns the Redis connection), merge over the
 * static fallback, and warn once per startup per fallback type. Called at the
 * START of each synthesis request (FR-009) — the resolved value is then used
 * for both the audit row and the LLM call, so an in-flight call never switches
 * models mid-execution (spec edge case E1).
 */
export async function resolveLlmConfig(
  getRaw: () => Promise<string | null>,
  fallback: LlmConfig,
): Promise<LlmConfig> {
  let raw: string | null = null;
  try {
    raw = await getRaw();
  } catch {
    raw = null; // Redis unreachable → same path as an absent key
  }
  const { config, source } = parseLlmConfig(raw, fallback);
  if (source === 'absent' && !llmConfigWarned.absent) {
    llmConfigWarned.absent = true;
    logger.warn('[engineer] hub:config:llm absent — using engineer-config defaults', {
      component: 'engineer',
      event: 'llm-config-fallback',
      reason: 'hub:config:llm absent',
    });
  }
  if (source === 'malformed' && !llmConfigWarned.malformed) {
    llmConfigWarned.malformed = true;
    logger.warn('[engineer] hub:config:llm malformed — using engineer-config defaults', {
      component: 'engineer',
      event: 'llm-config-malformed',
    });
  }
  return config;
}

const MAX_TOOL_ROUNDS = 4;

function defaultDeps(config: LlmConfig): LlmDeps {
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: process.env.LLM_API_KEY ?? 'not-needed',
  });
  return {
    createStream: async (params) =>
      (await client.chat.completions.create(
        {
          model: params.model,
          messages:
            params.messages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
          tools: params.tools as unknown as OpenAI.Chat.Completions.ChatCompletionTool[],
          max_tokens: params.maxTokens,
          stream: true,
        },
        { signal: params.signal },
      )) as unknown as AsyncIterable<StreamChunk>,
  };
}

/**
 * Run one reasoning turn against an OpenAI-compatible endpoint: stream tokens
 * (onDelta per content chunk, for sentence-by-sentence TTS), execute tool calls in
 * a loop, and enforce a response-token ceiling (maxResponseTokens) plus a hard
 * timeout. NEVER throws into the caller — returns a discriminated result; `timeout`
 * and `unreachable` are the degradation signals the synthesizer maps to
 * skip-with-log / canned line (FR-009, FR-023, research R1/R11).
 */
export async function runLlm(
  config: LlmConfig,
  messages: ChatMessage[],
  tools: Tools,
  opts: { onDelta?: (t: string) => void; deps?: LlmDeps } = {},
): Promise<LlmResult> {
  const deps = opts.deps ?? defaultDeps(config);
  const controller = new AbortController();
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<LlmResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: 'timeout' });
    }, config.timeoutMs);
  });

  const work = async (): Promise<LlmResult> => {
    const convo: ChatMessage[] = [...messages];
    const toolsCalled: string[] = [];
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const stream = await deps.createStream({
          model: config.model,
          messages: convo,
          tools: tools.schemas,
          maxTokens: config.maxResponseTokens,
          signal: controller.signal,
        });

        let content = '';
        const pending: Record<number, { id: string; name: string; args: string }> = {};
        let finish: string | null = null;

        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const d = choice.delta;
          if (d?.content) {
            content += d.content;
            opts.onDelta?.(d.content);
          }
          if (d?.tool_calls) {
            for (const tc of d.tool_calls) {
              const slot = (pending[tc.index] ??= { id: '', name: '', args: '' });
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.name += tc.function.name;
              if (tc.function?.arguments) slot.args += tc.function.arguments;
            }
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }

        const calls = Object.values(pending).filter((c) => c.name);
        if (finish === 'tool_calls' && calls.length > 0) {
          convo.push({
            role: 'assistant',
            content: content || null,
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: c.args },
            })),
          });
          for (const c of calls) {
            toolsCalled.push(c.name);
            const result = tools.run(c.name);
            convo.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
          }
          continue;
        }

        return { status: 'ok', text: content.trim(), toolsCalled, latencyMs: Date.now() - start };
      }
      return { status: 'ok', text: '', toolsCalled, latencyMs: Date.now() - start };
    } catch (err) {
      if (controller.signal.aborted) return { status: 'timeout' };
      // The OpenAI SDK attaches `status` on HTTP-level errors (401/404/5xx) —
      // surfaced so the synthesizer can distinguish "endpoint responded with an
      // error" (T018/U1 full suppression) from network-level unreachable.
      const httpStatus =
        typeof (err as { status?: unknown })?.status === 'number'
          ? (err as { status: number }).status
          : undefined;
      logger.warn('[engineer] LLM unreachable', {
        component: 'engineer',
        event: 'llm_unreachable',
        error: String(err),
        ...(httpStatus !== undefined ? { statusCode: httpStatus } : {}),
      });
      return { status: 'unreachable', error: String(err), httpStatus };
    }
  };

  const result = await Promise.race([work(), timeoutPromise]);
  if (timer) clearTimeout(timer);
  return result;
}
