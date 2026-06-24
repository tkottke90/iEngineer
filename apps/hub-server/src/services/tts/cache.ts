const TTL_MS = 60_000;
const CLEANUP_INTERVAL_MS = 30_000;

interface CacheEntry {
  buffer: Buffer;
  expiresAt: number;
}

export class TTSCache {
  private store = new Map<string, CacheEntry>();

  constructor() {
    setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  set(clipId: string, buffer: Buffer): void {
    this.store.set(clipId, { buffer, expiresAt: Date.now() + TTL_MS });
  }

  get(clipId: string): Buffer | null {
    const entry = this.store.get(clipId);
    if (!entry || Date.now() > entry.expiresAt) {
      this.store.delete(clipId);
      return null;
    }
    return entry.buffer;
  }

  getUrl(clipId: string): string {
    return `/audio/${clipId}.mp3`;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(id);
    }
  }
}
