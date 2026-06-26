import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLLMClient, streamResponse } from './llm.js';
import { streamSpeech } from './tts.js';
import { streamingPipeline } from './pipeline.js';
import { now, computeStats, fmt } from './timer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures');
const resultsDir = join(__dirname, '..', 'results');

const LLM_BASE_URL = process.env.LLM_BASE_URL ?? 'https://lemonade.tdkottke.com/v1';
const LLM_MODEL = process.env.LLM_MODEL ?? 'qwen3.5-9b-FLM';
const CHATTERBOX_URL = process.env.CHATTERBOX_URL ?? 'http://10.0.0.12:8004';
const CHATTERBOX_MODEL = process.env.CHATTERBOX_MODEL ?? 'voice2.wav';
const ITERATIONS = parseInt(process.env.ITERATIONS ?? '5', 10);

const TRANSCRIPT = "What's my gap to the car ahead?";

interface RunResult {
  run: number;
  batch: {
    llm_total_ms: number;
    tts_first_byte_ms: number;
    combined_ms: number;
    response: string;
  };
  streaming: {
    llm_ttft_ms: number;
    first_sentence_ms: number;
    first_sentence_text: string;
    tts_first_byte_ms: number;
    combined_ms: number;
    full_response: string;
  };
}

async function runIteration(index: number, llm: ReturnType<typeof createLLMClient>, systemPrompt: string): Promise<RunResult> {
  console.log(`\n--- Run ${index + 1}/${ITERATIONS} ---`);

  // Batch mode
  const t_batch_start = now();
  const batchResponse = await streamResponse(llm, systemPrompt, TRANSCRIPT, () => {});
  const batch_llm_total_ms = now() - t_batch_start;

  let batch_tts_first_byte: number | null = null;
  const t_batch_tts = now();
  await streamSpeech(batchResponse, CHATTERBOX_URL, CHATTERBOX_MODEL, () => {
    batch_tts_first_byte = now() - t_batch_tts;
  });
  const batch_tts_first_byte_ms = batch_tts_first_byte ?? (now() - t_batch_tts);
  const batch_combined_ms = batch_llm_total_ms + batch_tts_first_byte_ms;

  console.log(`  [batch]     LLM total: ${fmt(batch_llm_total_ms)}  TTS: ${fmt(batch_tts_first_byte_ms)}  combined: ${fmt(batch_combined_ms)}`);
  console.log(`  [batch]     response: "${batchResponse.slice(0, 80).replace(/\n/g, ' ')}"`);

  // Streaming mode
  const streamResult = await streamingPipeline(llm, systemPrompt, TRANSCRIPT, CHATTERBOX_URL, CHATTERBOX_MODEL);

  console.log(`  [streaming] TTFT: ${fmt(streamResult.llm_ttft_ms)}  1st sentence: ${fmt(streamResult.first_sentence_ms)}  TTS: ${fmt(streamResult.tts_first_byte_ms)}  combined: ${fmt(streamResult.total_streaming_ms)}`);
  console.log(`  [streaming] 1st sentence: "${streamResult.first_sentence_text}"`);
  console.log(`  [streaming] delta vs batch: ${fmt(batch_combined_ms - streamResult.total_streaming_ms)} faster`);

  return {
    run: index + 1,
    batch: {
      llm_total_ms: batch_llm_total_ms,
      tts_first_byte_ms: batch_tts_first_byte_ms,
      combined_ms: batch_combined_ms,
      response: batchResponse,
    },
    streaming: {
      llm_ttft_ms: streamResult.llm_ttft_ms,
      first_sentence_ms: streamResult.first_sentence_ms,
      first_sentence_text: streamResult.first_sentence_text,
      tts_first_byte_ms: streamResult.tts_first_byte_ms,
      combined_ms: streamResult.total_streaming_ms,
      full_response: streamResult.full_response,
    },
  };
}

function printSummary(results: RunResult[]): void {
  const col = (label: string, values: number[]) => {
    const s = computeStats(values);
    return `${label.padEnd(22)} | ${fmt(s.mean).padStart(8)} | ${fmt(s.p50).padStart(8)} | ${fmt(s.p95).padStart(8)}`;
  };

  console.log('\n=== Summary ===');
  console.log('Stage                  |     Mean |      p50 |      p95');
  console.log('-----------------------|----------|----------|----------');
  console.log(col('Batch LLM Total', results.map((r) => r.batch.llm_total_ms)));
  console.log(col('Batch TTS First Byte', results.map((r) => r.batch.tts_first_byte_ms)));
  console.log(col('Batch Combined', results.map((r) => r.batch.combined_ms)));
  console.log('-----------------------|----------|----------|----------');
  console.log(col('Streaming TTFT', results.map((r) => r.streaming.llm_ttft_ms)));
  console.log(col('Streaming 1st Sentence', results.map((r) => r.streaming.first_sentence_ms)));
  console.log(col('Streaming TTS (short)', results.map((r) => r.streaming.tts_first_byte_ms)));
  console.log(col('Streaming Combined', results.map((r) => r.streaming.combined_ms)));

  const batchMean = computeStats(results.map((r) => r.batch.combined_ms)).mean;
  const streamingMean = computeStats(results.map((r) => r.streaming.combined_ms)).mean;
  const reduction = ((batchMean - streamingMean) / batchMean * 100).toFixed(1);
  console.log(`\nStreaming is ${fmt(batchMean - streamingMean)} (${reduction}%) faster than batch`);
  console.log(`Streaming TTFA floor: ${fmt(streamingMean)} (add ~60ms STT for full pipeline)`);
}

async function main(): Promise<void> {
  console.log('POC 0003 — Streaming LLM→TTS Chain');
  console.log('====================================');
  console.log(`LLM:  ${LLM_BASE_URL} (${LLM_MODEL})`);
  console.log(`TTS:  ${CHATTERBOX_URL} (${CHATTERBOX_MODEL})`);
  console.log(`Input: "${TRANSCRIPT}"`);
  console.log(`Runs: ${ITERATIONS}`);

  const systemPrompt = readFileSync(join(fixturesDir, 'prompt.txt'), 'utf-8').trim();
  const llm = createLLMClient(LLM_BASE_URL, LLM_MODEL);

  const results: RunResult[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    results.push(await runIteration(i, llm, systemPrompt));
  }

  printSummary(results);

  const output = {
    config: { LLM_BASE_URL, LLM_MODEL, CHATTERBOX_URL, CHATTERBOX_MODEL, ITERATIONS, transcript: TRANSCRIPT },
    runs: results,
    summary: {
      batch: {
        llm_total: computeStats(results.map((r) => r.batch.llm_total_ms)),
        tts_first_byte: computeStats(results.map((r) => r.batch.tts_first_byte_ms)),
        combined: computeStats(results.map((r) => r.batch.combined_ms)),
      },
      streaming: {
        llm_ttft: computeStats(results.map((r) => r.streaming.llm_ttft_ms)),
        first_sentence: computeStats(results.map((r) => r.streaming.first_sentence_ms)),
        tts_first_byte_short: computeStats(results.map((r) => r.streaming.tts_first_byte_ms)),
        combined: computeStats(results.map((r) => r.streaming.combined_ms)),
      },
    },
  };

  writeFileSync(join(resultsDir, 'measurements.json'), JSON.stringify(output, null, 2));
  console.log('\nWrote results/measurements.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
