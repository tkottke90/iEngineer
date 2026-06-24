import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolCalls: Array<{ name: string; input: unknown }>;
  stopReason: string;
}

export class LLMClient {
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;
  private model: string;

  constructor() {
    const mode = process.env.LLM_MODE ?? "frontier";
    this.model = process.env.LLM_MODEL ?? "claude-sonnet-4-6";

    if (mode === "frontier") {
      this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } else {
      this.openai = new OpenAI({
        baseURL: process.env.LLM_BASE_URL,
        apiKey: process.env.LLM_API_KEY ?? "local",
      });
    }
  }

  async chat(messages: Message[], tools?: Tool[], system?: string): Promise<LLMResponse> {
    if (this.anthropic) {
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1024,
        system,
        messages,
        tools: tools as Anthropic.Tool[],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      const toolBlocks = response.content.filter((b) => b.type === "tool_use");

      return {
        content: textBlock?.type === "text" ? textBlock.text : "",
        toolCalls: toolBlocks.map((b) => b.type === "tool_use" ? { name: b.name, input: b.input } : { name: "", input: null }),
        stopReason: response.stop_reason ?? "end_turn",
      };
    }

    if (this.openai) {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          ...(system ? [{ role: "system" as const, content: system }] : []),
          ...messages,
        ],
      });

      return {
        content: response.choices[0]?.message.content ?? "",
        toolCalls: [],
        stopReason: response.choices[0]?.finish_reason ?? "stop",
      };
    }

    throw new Error("No LLM backend configured");
  }
}
