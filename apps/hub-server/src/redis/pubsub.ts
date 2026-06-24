import type { Redis } from "ioredis";

type Handler = (message: string) => void;

export class PubSubManager {
  private handlers = new Map<string, Set<Handler>>();

  constructor(
    private readonly sub: Redis,
    private readonly pub: Redis,
  ) {
    sub.on("message", (channel, message) => {
      this.handlers.get(channel)?.forEach((h) => h(message));
    });
  }

  subscribe(channel: string, handler: Handler): () => void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      this.sub.subscribe(channel);
    }
    this.handlers.get(channel)!.add(handler);

    return () => {
      this.handlers.get(channel)?.delete(handler);
      if (this.handlers.get(channel)?.size === 0) {
        this.handlers.delete(channel);
        this.sub.unsubscribe(channel);
      }
    };
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.pub.publish(channel, message);
  }
}
