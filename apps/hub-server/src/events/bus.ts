import { EventEmitter } from "node:events";
import type { RaceEvent } from "@iracing-engineer/types";
import type { PubSubManager } from "../redis/pubsub.js";

export class EventBus {
  private emitter = new EventEmitter();

  constructor(private readonly pubsub: PubSubManager) {}

  async emit(event: RaceEvent): Promise<void> {
    // In-process delivery (agents subscribe synchronously)
    this.emitter.emit("event", event);
    // Redis Pub/Sub for external consumers (overlay, Discord bridge)
    await this.pubsub.publish("session:events", JSON.stringify(event));
  }

  subscribe(handler: (event: RaceEvent) => void): () => void {
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }
}
