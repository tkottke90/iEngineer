import { randomUUID } from 'node:crypto';

// COUPLING: must equal the hard-coded 60_000 in subscriber.rs (T024) — change
// both together or clips will be served after Tauri considers them stale.
export const AUDIO_CLIP_TTL_MS = 60_000;

interface AudioClipEntry {
  buffer: Buffer;
  storedAt: number; // epoch ms — same instant published as AudioClipRef.generatedAt
}

export interface StoredClip {
  audioId: string;
  clipUrl: string; // RELATIVE path — Tauri prepends its configured hub_url
  storedAt: number;
}

/**
 * In-process store of generated MP3 clips. Clips are TTL-evicted (never deleted
 * on fetch) so a client can re-fetch after a brief disconnect and deep queues
 * still resolve.
 */
export class AudioStore {
  private clips = new Map<string, AudioClipEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(idleCleanupIntervalMs: number) {
    this.cleanupTimer = setInterval(() => this.evictExpired(), idleCleanupIntervalMs);
    // Do not keep the process alive solely for cleanup.
    if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
  }

  store(buffer: Buffer): StoredClip {
    const audioId = randomUUID();
    const storedAt = Date.now();
    this.clips.set(audioId, { buffer, storedAt });
    return { audioId, clipUrl: `/api/audio/${audioId}`, storedAt };
  }

  get(audioId: string): Buffer | null {
    return this.clips.get(audioId)?.buffer ?? null;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.clips) {
      if (now - entry.storedAt > AUDIO_CLIP_TTL_MS) {
        this.clips.delete(id);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.clips.clear();
  }
}

// Singleton accessor so api.ts routes (T019/T039) reach the same store the
// RacingEngineerService owns. NOTE: this must survive module duplication — under
// Vite dev SSR, server-init.ts and api.ts can load separate copies of this
// module, so a plain module-level `let` would not be shared. Anchor the instance
// on globalThis so every module copy sees the same store.
const GLOBAL_KEY = Symbol.for('iracing-engineer.audio-store');
type GlobalWithStore = typeof globalThis & { [GLOBAL_KEY]?: AudioStore | null };

export function setAudioStore(store: AudioStore): void {
  (globalThis as GlobalWithStore)[GLOBAL_KEY] = store;
}

export function getAudioStore(): AudioStore | null {
  return (globalThis as GlobalWithStore)[GLOBAL_KEY] ?? null;
}
