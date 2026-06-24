export enum MessageTier {
  IMMEDIATE = 0,
  SAFE_WINDOW = 1,
  BRIEFING = 2,
}

interface QueuedMessage {
  text: string;
  tier: MessageTier;
  enqueuedAt: number;
  metadata?: Record<string, unknown>;
}

export class MessageQueue {
  private queues: QueuedMessage[][] = [[], [], []];
  private activeMessages = new Set<string>();

  enqueue(text: string, tier: MessageTier, metadata?: Record<string, unknown>): void {
    if (this.activeMessages.has(text)) return;
    this.queues[tier].push({ text, tier, enqueuedAt: Date.now(), metadata });
    this.activeMessages.add(text);
  }

  processNext(safeWindowOpen: boolean): QueuedMessage | null {
    // Tier 1: always deliver
    if (this.queues[MessageTier.IMMEDIATE].length > 0) {
      return this.dequeue(MessageTier.IMMEDIATE);
    }
    // Tier 2: only when safe window is open
    if (safeWindowOpen && this.queues[MessageTier.SAFE_WINDOW].length > 0) {
      return this.dequeue(MessageTier.SAFE_WINDOW);
    }
    // Tier 3: latency-tolerant, deliver when safe
    if (safeWindowOpen && this.queues[MessageTier.BRIEFING].length > 0) {
      return this.dequeue(MessageTier.BRIEFING);
    }
    return null;
  }

  private dequeue(tier: MessageTier): QueuedMessage {
    const msg = this.queues[tier].shift()!;
    this.activeMessages.delete(msg.text);
    return msg;
  }

  get length(): number {
    return this.queues.reduce((sum, q) => sum + q.length, 0);
  }
}
