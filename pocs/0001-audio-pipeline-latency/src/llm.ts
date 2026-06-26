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
