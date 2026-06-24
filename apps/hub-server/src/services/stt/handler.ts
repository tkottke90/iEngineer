import type { LLMClient } from "../llm/client.js";
import type { RaceStateManager } from "../../state/race-state.js";
import type { MessageQueue } from "../../agents/racing-engineer/message-queue.js";
import type { TTSCache } from "../tts/cache.js";
import type { ChatterboxClient } from "../tts/chatterbox.js";
import type { PubSubManager } from "../../redis/pubsub.js";
import { assembleContext } from "../../agents/racing-engineer/context.js";
import { buildSystemPrompt, DEFAULT_PERSONALITY } from "../../agents/racing-engineer/personality.js";
import { RACING_ENGINEER_TOOLS, handleToolCall } from "../../agents/racing-engineer/tools.js";

export class STTHandler {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly pubsub: PubSubManager,
    private readonly llm: LLMClient,
    private readonly state: RaceStateManager,
    private readonly tts: ChatterboxClient,
    private readonly cache: TTSCache,
  ) {}

  start(): void {
    this.unsubscribe = this.pubsub.subscribe("voice:transcription", (raw) => {
      const { text, sessionId } = JSON.parse(raw) as { text: string; sessionId: string };
      this.handleTranscription(text, sessionId).catch(console.error);
    });
  }

  stop(): void {
    this.unsubscribe?.();
  }

  private async handleTranscription(text: string, sessionId: string): Promise<void> {
    const raceState = this.state.getState();
    const context = assembleContext(raceState, { overridesThisSession: 0, lastOverrideDescription: null, significantMoments: [] });
    const system = buildSystemPrompt(DEFAULT_PERSONALITY);

    const messages = [
      { role: "user" as const, content: `Race context:\n${JSON.stringify(context, null, 2)}\n\nDriver: "${text}"` },
    ];

    // Agentic loop: call LLM with tools until stop_reason !== "tool_use"
    let response = await this.llm.chat(messages, RACING_ENGINEER_TOOLS as unknown as Parameters<LLMClient["chat"]>[1], system);
    while (response.toolCalls.length > 0) {
      const toolResults = response.toolCalls.map((tc) => ({
        name: tc.name,
        result: handleToolCall(tc.name, tc.input, raceState),
      }));
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: JSON.stringify(toolResults) });
      response = await this.llm.chat(messages, RACING_ENGINEER_TOOLS as unknown as Parameters<LLMClient["chat"]>[1], system);
    }

    if (!response.content) return;

    const mp3 = await this.tts.synthesize(response.content);
    const clipId = crypto.randomUUID();
    this.cache.set(clipId, mp3);

    await this.pubsub.publish("voice:audio", JSON.stringify({ url: this.cache.getUrl(clipId), sessionId }));
  }
}
