import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcribe } from './stt.js';
import { createLLMClient, streamResponse } from './llm.js';
import { streamSpeech } from './tts.js';
import { now, computeStats, fmt } from './timer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures');
const resultsDir = join(__dirname, '..', 'results');

const STT_URL = process.env.STT_URL ?? 'https://lemonade.tdkottke.com';
const STT_MODEL = process.env.STT_MODEL ?? 'Whisper-Large-v3-Turbo';
const CHATTERBOX_URL = process.env.CHATTERBOX_URL ?? 'http://10.0.0.12:8004';
const CHATTERBOX_MODEL = process.env.CHATTERBOX_MODEL ?? 'voice2.wav';
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1';
const LLM_MODEL = process.env.LLM_MODEL ?? 'llama3.2';
const ITERATIONS = parseInt(process.env.ITERATIONS ?? '5', 10);

const WAV_PATH = join(fixturesDir, 'query.wav');
const PROMPT_PATH = join(fixturesDir, 'prompt.txt');

interface RunResult {
  run: number;
  stt_ms: number;
  llm_ttft_ms: number;
  llm_total_ms: number;
  tts_ttfa_ms: number;
  total_ttfa_ms: number;
  transcript: string;
  response: string;
}

async function runIteration(
  index: number,
  llm: ReturnType<typeof createLLMClient>,
  systemPrompt: string,
): Promise<RunResult> {
  console.log(`\n--- Run ${index + 1}/${ITERATIONS} ---`);

  // STT
  const t_stt_start = now();
  const transcript = await transcribe(WAV_PATH, STT_URL, STT_MODEL);
  const stt_ms = now() - t_stt_start;
  console.log(`  STT:      ${fmt(stt_ms)} → "${transcript}"`);

  // LLM (streaming)
  let t_llm_first_token: number | null = null;
  const t_llm_start = now();
  const response = await streamResponse(llm, systemPrompt, transcript, () => {
    t_llm_first_token = now();
  });
  const llm_total_ms = now() - t_llm_start;
  const llm_ttft_ms = (t_llm_first_token ?? now()) - t_llm_start;
  console.log(`  LLM TTFT: ${fmt(llm_ttft_ms)}  total: ${fmt(llm_total_ms)}`);
  console.log(`  Response: "${response.slice(0, 80).replace(/\n/g, ' ')}"`);

  // TTS (streaming)
  let t_tts_first_byte: number | null = null;
  const t_tts_start = now();
  await streamSpeech(response, CHATTERBOX_URL, CHATTERBOX_MODEL, () => {
    t_tts_first_byte = now();
  });
  const tts_ttfa_ms = (t_tts_first_byte ?? now()) - t_tts_start;
  console.log(`  TTS TTFA: ${fmt(tts_ttfa_ms)}`);

  const total_ttfa_ms = (t_tts_first_byte ?? now()) - t_stt_start;
  console.log(`  TOTAL:    ${fmt(total_ttfa_ms)} ${ total_ttfa_ms < 500 ? '✓ under 500ms' : '✗ over 500ms'}`);

  return {
    run: index + 1,
    stt_ms,
    llm_ttft_ms,
    llm_total_ms,
    tts_ttfa_ms,
    total_ttfa_ms,
    transcript,
    response,
  };
}

function printSummary(results: RunResult[]): void {
  const col = (label: string, values: number[]) => {
    const s = computeStats(values);
    return `${label.padEnd(16)} | ${fmt(s.mean).padStart(8)} | ${fmt(s.p50).padStart(8)} | ${fmt(s.p95).padStart(8)}`;
  };

  console.log('\n=== Summary ===');
  console.log('Stage            |     Mean |      p50 |      p95');
  console.log('-----------------|----------|----------|----------');
  console.log(col('STT', results.map((r) => r.stt_ms)));
  console.log(col('LLM TTFT', results.map((r) => r.llm_ttft_ms)));
  console.log(col('LLM Total', results.map((r) => r.llm_total_ms)));
  console.log(col('TTS First Byte', results.map((r) => r.tts_ttfa_ms)));
  console.log(col('TOTAL TTFA', results.map((r) => r.total_ttfa_ms)));
}

async function main(): Promise<void> {
  console.log('POC 0001 — Audio Pipeline Latency');
  console.log('==================================');
  console.log(`STT:  ${STT_URL} (${STT_MODEL})`);
  console.log(`LLM:  ${LLM_BASE_URL} (${LLM_MODEL})`);
  console.log(`TTS:  ${CHATTERBOX_URL} (${CHATTERBOX_MODEL})`);
  console.log(`Runs: ${ITERATIONS}`);

  const systemPrompt = readFileSync(PROMPT_PATH, 'utf-8').trim();
  const llm = createLLMClient(LLM_BASE_URL, LLM_MODEL);

  const results: RunResult[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    results.push(await runIteration(i, llm, systemPrompt));
  }

  printSummary(results);

  const output = {
    config: { STT_URL, STT_MODEL, LLM_BASE_URL, LLM_MODEL, CHATTERBOX_URL, ITERATIONS },
    runs: results,
    summary: {
      stt: computeStats(results.map((r) => r.stt_ms)),
      llm_ttft: computeStats(results.map((r) => r.llm_ttft_ms)),
      llm_total: computeStats(results.map((r) => r.llm_total_ms)),
      tts_ttfa: computeStats(results.map((r) => r.tts_ttfa_ms)),
      total_ttfa: computeStats(results.map((r) => r.total_ttfa_ms)),
    },
  };

  writeFileSync(join(resultsDir, 'measurements.json'), JSON.stringify(output, null, 2));
  console.log('\nWrote results/measurements.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
