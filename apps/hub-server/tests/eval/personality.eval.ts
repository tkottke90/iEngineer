import { describe, it, before } from 'mocha';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runLlm, type ChatMessage } from '../../src/engineer/llm-client.js';
import { createTools } from '../../src/engineer/tools.js';
import { EVAL_LLM, llmReachable } from './eval-config.js';

// Implements contracts/personality-prompt.md: hybrid grading (deterministic proxies
// + pairwise LLM judge), 5 fixed scenarios, level 1 vs 5, direction must hold >=4/5.
// Runs via `npm run eval` (skips if the LLM is offline). Constitution VI.

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');
const strip = (s: string): string => s.replace(/<!--[\s\S]*?-->/g, '').trim();
const tools = createTools({ getFuelModel: () => null, getTireModel: () => null });

type Traits = {
  openness: number;
  warmth: number;
  energy: number;
  conscientiousness: number;
  assertiveness: number;
};
const BASE: Traits = { openness: 3, warmth: 3, energy: 3, conscientiousness: 3, assertiveness: 3 };

function buildSystem(t: Traits): string {
  const base = strip(readFileSync(join(PROMPTS, 'system-base.md'), 'utf-8'));
  const persona = strip(readFileSync(join(PROMPTS, 'personality.md'), 'utf-8'))
    .replaceAll('{openness}', String(t.openness))
    .replaceAll('{warmth}', String(t.warmth))
    .replaceAll('{energy}', String(t.energy))
    .replaceAll('{conscientiousness}', String(t.conscientiousness))
    .replaceAll('{assertiveness}', String(t.assertiveness));
  return `${base}\n\n${persona}`;
}

const SCENARIOS = [
  'The pit window is open and fuel is tight.',
  'A safety car has just been deployed.',
  'The driver asks how much fuel is left.',
  'The driver asks how the tires are holding up.',
  'The driver just completed a clean, fast lap.',
];

async function say(t: Traits, scenario: string): Promise<string> {
  const msgs: ChatMessage[] = [
    { role: 'system', content: buildSystem(t) },
    { role: 'user', content: scenario },
  ];
  const r = await runLlm(EVAL_LLM, msgs, tools);
  return r.status === 'ok' ? r.text : '';
}

const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
const imperativeScore = (s: string): number =>
  (s.match(/\b(box|push|save|lift|stay|go|hold|keep|brake|short-shift)\b/gi) ?? []).length;

// Pairwise LLM judge: which reply is more <trait word>?
async function judgeMoreThan(word: string, a: string, b: string): Promise<'A' | 'B' | 'tie'> {
  const msgs: ChatMessage[] = [
    {
      role: 'system',
      content: `You compare two race-engineer radio messages. Answer with exactly one letter: A or B — whichever is more ${word}. If truly equal, answer A.`,
    },
    { role: 'user', content: `A: "${a}"\n\nB: "${b}"\n\nWhich is more ${word}? Answer A or B.` },
  ];
  const r = await runLlm({ ...EVAL_LLM, maxResponseTokens: 4 }, msgs, tools);
  const text = (r.status === 'ok' ? r.text : '').trim().toUpperCase();
  if (text.startsWith('A')) return 'A';
  if (text.startsWith('B')) return 'B';
  return 'tie';
}

describe('EVAL: personality direction (SC-005, Constitution VI)', function () {
  this.timeout(600_000);
  before(async function () {
    if (!(await llmReachable())) {
      // eslint-disable-next-line no-console
      console.warn(`[skip] LLM unreachable at ${EVAL_LLM.baseUrl} — skipping personality eval`);
      this.skip();
    }
  });

  it('Energy: level 5 is more verbose than level 1 (>=4/5, deterministic)', async () => {
    let hits = 0;
    for (const s of SCENARIOS) {
      const low = await say({ ...BASE, energy: 1 }, s);
      const high = await say({ ...BASE, energy: 5 }, s);
      if (wordCount(high) > wordCount(low)) hits += 1;
    }
    expect(hits, `energy direction held ${hits}/5`).to.be.at.least(4);
  });

  it('Assertiveness: level 5 is more directive than level 1 (>=4/5, deterministic)', async () => {
    let hits = 0;
    for (const s of SCENARIOS) {
      const low = await say({ ...BASE, assertiveness: 1 }, s);
      const high = await say({ ...BASE, assertiveness: 5 }, s);
      if (imperativeScore(high) >= imperativeScore(low)) hits += 1;
    }
    expect(hits, `assertiveness direction held ${hits}/5`).to.be.at.least(4);
  });

  for (const { trait, word } of [
    { trait: 'warmth' as const, word: 'warm and encouraging' },
    { trait: 'openness' as const, word: 'imaginative or visionary' },
    { trait: 'conscientiousness' as const, word: 'precise and detailed' },
  ]) {
    it(`${trait}: level 5 is more "${word}" than level 1 (>=4/5, LLM judge)`, async () => {
      let hits = 0;
      for (const s of SCENARIOS) {
        const low = await say({ ...BASE, [trait]: 1 }, s);
        const high = await say({ ...BASE, [trait]: 5 }, s);
        if ((await judgeMoreThan(word, high, low)) === 'A') hits += 1;
      }
      expect(hits, `${trait} direction held ${hits}/5`).to.be.at.least(4);
    });
  }
});
