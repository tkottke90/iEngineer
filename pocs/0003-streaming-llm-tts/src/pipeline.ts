import { ChatOpenAI } from '@langchain/openai';
import { streamSentences } from './llm.js';
import { streamSpeech } from './tts.js';
import { now } from './timer.js';

export interface StreamingResult {
  llm_ttft_ms: number;
  first_sentence_ms: number;
  first_sentence_text: string;
  tts_first_byte_ms: number;
  total_streaming_ms: number;
  full_response: string;
}

export async function streamingPipeline(
  llmClient: ChatOpenAI,
  systemPrompt: string,
  transcript: string,
  chatterboxUrl: string,
  referenceAudio: string,
): Promise<StreamingResult> {
  const t_start = now();
  let llm_ttft_ms = 0;
  let first_sentence_ms = 0;
  let first_sentence_text = '';
  let tts_first_byte_ms = 0;
  let ttsStarted = false;
  let ttsPromise: Promise<void> | null = null;

  const fullResponse = await streamSentences(llmClient, systemPrompt, transcript, {
    onFirstToken: () => {
      llm_ttft_ms = now() - t_start;
    },
    onSentence: (sentence, index) => {
      if (index === 0) {
        first_sentence_ms = now() - t_start;
        first_sentence_text = sentence;
        ttsStarted = true;

        const t_tts_sent = now();
        ttsPromise = streamSpeech(sentence, chatterboxUrl, referenceAudio, () => {
          tts_first_byte_ms = now() - t_tts_sent;
        });
      }
    },
  });

  // Wait for TTS to complete (first byte received, stream drained)
  if (ttsPromise) {
    await ttsPromise;
  } else if (!ttsStarted) {
    throw new Error('No sentences detected in LLM response');
  }

  const total_streaming_ms = first_sentence_ms + tts_first_byte_ms;

  return {
    llm_ttft_ms,
    first_sentence_ms,
    first_sentence_text,
    tts_first_byte_ms,
    total_streaming_ms,
    full_response: fullResponse,
  };
}
