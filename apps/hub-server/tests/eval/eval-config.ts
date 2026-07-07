import type { LlmConfig } from '@iracing-engineer/types';

// Eval target/judge model — separate from runtime engineer-config.json so the two
// can diverge (contracts/personality-prompt.md). Overridable via env for CI/local.
export const EVAL_LLM: LlmConfig = {
  baseUrl: process.env.EVAL_LLM_BASE_URL ?? 'https://lemonade.tdkottke.com/v1',
  model: process.env.EVAL_LLM_MODEL ?? 'user.Ornith-1.0-35B-GGUF',
  provider: 'openai-compatible',
  timeoutMs: 90_000,
  maxResponseTokens: 300,
  tokenBudget: 6000,
};

/** Probe the endpoint so evals skip gracefully when the LLM is offline. */
export async function llmReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${EVAL_LLM.baseUrl}/models`, { method: 'GET' });
    // Any HTTP response (even 401/404) means the endpoint is up.
    return res.status > 0;
  } catch {
    return false;
  }
}
