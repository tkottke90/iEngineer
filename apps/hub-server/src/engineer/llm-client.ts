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
  | { status: 'unreachable'; error: string };

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
      logger.warn('[engineer] LLM unreachable', { error: String(err) });
      return { status: 'unreachable', error: String(err) };
    }
  };

  const result = await Promise.race([work(), timeoutPromise]);
  if (timer) clearTimeout(timer);
  return result;
}
