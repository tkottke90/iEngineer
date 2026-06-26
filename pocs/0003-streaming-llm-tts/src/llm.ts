import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

export function createLLMClient(baseUrl: string, model: string): ChatOpenAI {
  return new ChatOpenAI({
    model,
    streaming: true,
    openAIApiKey: 'ollama',
    configuration: {
      baseURL: baseUrl,
    },
  });
}

function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'object' && c !== null && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .join('');
  }
  return '';
}

export async function streamResponse(
  client: ChatOpenAI,
  systemPrompt: string,
  userMessage: string,
  onFirstToken: () => void,
): Promise<string> {
  let sawFirstToken = false;
  let fullResponse = '';

  const stream = await client.stream([
    new SystemMessage(systemPrompt),
    new HumanMessage(userMessage),
  ]);

  for await (const chunk of stream) {
    const content = extractContent(chunk.content);
    if (content && !sawFirstToken) {
      sawFirstToken = true;
      onFirstToken();
    }
    fullResponse += content;
  }

  return fullResponse;
}

export interface SentenceCallbacks {
  onFirstToken: () => void;
  onSentence: (sentence: string, index: number) => void;
}

export async function streamSentences(
  client: ChatOpenAI,
  systemPrompt: string,
  userMessage: string,
  callbacks: SentenceCallbacks,
): Promise<string> {
  let sawFirstToken = false;
  let buffer = '';
  let fullResponse = '';
  let sentenceIndex = 0;

  const SENTENCE_END = /[.!?](?:\s|$)/;

  const flushSentence = (text: string): string => {
    const match = SENTENCE_END.exec(text);
    if (!match) return text;

    const end = match.index + match[0].length;
    const sentence = text.slice(0, end).trim();
    const remainder = text.slice(end);

    if (sentence) {
      callbacks.onSentence(sentence, sentenceIndex++);
    }

    // Recursively flush if remainder contains more sentences
    return flushSentence(remainder);
  };

  const stream = await client.stream([
    new SystemMessage(systemPrompt),
    new HumanMessage(userMessage),
  ]);

  for await (const chunk of stream) {
    const content = extractContent(chunk.content);
    if (!content) continue;

    if (!sawFirstToken) {
      sawFirstToken = true;
      callbacks.onFirstToken();
    }

    fullResponse += content;
    buffer += content;
    buffer = flushSentence(buffer);
  }

  // Flush any remaining text as final sentence
  const remaining = buffer.trim();
  if (remaining) {
    callbacks.onSentence(remaining, sentenceIndex);
  }

  return fullResponse;
}
