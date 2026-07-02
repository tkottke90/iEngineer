import type Redis from 'ioredis';
import type {
  RaceEvent,
  RaceState,
  EngineerConfig,
  RadioBlackoutZone,
  AudioClipRef,
  QueuedMessage,
  PersonalityConfig,
  EngineerQuery,
} from '@iracing-engineer/types';
import { AudioStore } from './audio-store.js';
import { PriorityMessageQueue } from './message-queue.js';
import { DedupTracker } from './dedup-tracker.js';
import { evaluateTier1, evaluateTier2 } from './alert-rules.js';
import { generateClip } from './tts-client.js';
import { shouldSuppressAlert, parsePersonality } from './personality-config.js';
import type { Tier3Synthesizer } from './tier3-synthesizer.js';
import { logger } from '../logger.js';

const DISPATCH_INTERVAL_MS = 100;

// Injectable so tests can supply a fake TTS without hitting Chatterbox.
type ClipGenerator = (text: string, config: EngineerConfig) => Promise<Buffer>;

export class RacingEngineerService {
  private sub: Redis | null = null;
  private dispatchTimer: ReturnType<typeof setInterval> | null = null;
  private _generating = false;
  private _personalityWarnEmitted = false;
  // PTT query concurrency: one synthesis in flight; extra queries queue FIFO up to
  // queueDepthCap, overflow dropped with a log (Q4).
  private _queryQueue: EngineerQuery[] = [];
  private _queryInFlight = false;

  constructor(
    private commandConn: Redis,
    private audioStore: AudioStore,
    private queue: PriorityMessageQueue,
    private dedup: DedupTracker,
    private getRaceState: () => RaceState,
    private zones: RadioBlackoutZone[],
    private config: EngineerConfig,
    private synthesizer: Tier3Synthesizer | null = null,
    private generateClipFn: ClipGenerator = generateClip,
  ) {}

  async start(): Promise<void> {
    // A subscribed ioredis connection cannot issue other commands, so use a
    // dedicated duplicate for pub/sub. Wrap subscription so a Redis failure
    // degrades the service silently rather than crashing the hub.
    try {
      this.sub = this.commandConn.duplicate();
      await this.sub.subscribe('hub:events', 'engineer:query');
      this.sub.on('message', (channel: string, message: string) => {
        if (channel === 'engineer:query') this.onQuery(message);
        else this.onEvent(message);
      });
    } catch (err) {
      logger.error('[engineer] Failed to subscribe to hub:events / engineer:query', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    this.dispatchTimer = setInterval(() => this.dispatchTick(), DISPATCH_INTERVAL_MS);
  }

  // Driver PTT query (transcribed on the client, published to engineer:query).
  private onQuery(message: string): void {
    let q: EngineerQuery;
    try {
      q = JSON.parse(message) as EngineerQuery;
    } catch {
      return;
    }
    // Empty/non-speech is already guarded client-side (FR-004); double-guard here.
    if (!q.transcript || !q.transcript.trim()) {
      logger.info('[engineer] PTT query ignored — empty transcript', { queryId: q.queryId });
      return;
    }
    if (this._queryQueue.length >= this.config.queueDepthCap) {
      logger.warn('[engineer] PTT query dropped — queue depth cap reached', {
        reason: 'queue-cap-drop',
        queryId: q.queryId,
      });
      return;
    }
    this._queryQueue.push(q);
    void this.drainQueries();
  }

  // One driver-query synthesized at a time; the rest wait FIFO.
  private async drainQueries(): Promise<void> {
    if (this._queryInFlight) return;
    if (!this.synthesizer) return;
    this._queryInFlight = true;
    try {
      while (this._queryQueue.length > 0) {
        const q = this._queryQueue.shift()!;
        const personality = await this.readPersonality();
        await this.synthesizer.synthesize({
          type: 'driver-query',
          triggerSource: q.queryId,
          userText: q.transcript,
          personality,
        });
      }
    } finally {
      this._queryInFlight = false;
    }
  }

  private onEvent(message: string): void {
    let event: RaceEvent;
    try {
      event = JSON.parse(message) as RaceEvent;
    } catch {
      return;
    }

    // Dedup-clear signals (consumed, not alerted).
    switch (event.type) {
      case 'hero:pit_exit': // T029 — reset pit-window dedup for next stint
        this.dedup.recordCleared('hero:pit_window_open');
        return;
      case 'session:safety_car_cleared': // T033a
        this.dedup.recordCleared('session:safety_car_deployed');
        return;
      case 'hero:blue_flag_cleared': // T033b
        this.dedup.recordCleared('hero:blue_flag');
        return;
      case 'hero:pit_limiter_active':
        // T033c — active:false is the limiter-off clear signal.
        if (event.payload.active === false) {
          this.dedup.recordCleared('hero:pit_limiter_active');
          return;
        }
        break;
    }

    const signals = this.getRaceState().signals;
    const alert = evaluateTier1(event, this.config) ?? evaluateTier2(event, signals, this.config);
    if (!alert) return;

    if (!this.dedup.shouldFire(alert.eventType, alert.lapNumber)) {
      logger.info('[engineer] Alert deduplicated', { alertType: alert.eventType, lapNumber: alert.lapNumber });
      return;
    }
    this.dedup.recordFired(alert.eventType, alert.lapNumber);
    this.queue.enqueue(alert);
    logger.info('[engineer] Alert enqueued', { alertType: alert.eventType, tier: alert.tier, lapNumber: alert.lapNumber });
  }

  private async readPersonality(): Promise<PersonalityConfig> {
    let raw: string | null = null;
    try {
      raw = await this.commandConn.get('hub:config:personality');
    } catch {
      raw = null;
    }
    const { personality, usedFallback } = parsePersonality(raw, this.config.personality);
    if (usedFallback && !this._personalityWarnEmitted) {
      this._personalityWarnEmitted = true;
      logger.warn('[engineer] Personality key absent, malformed, or out of range — using config defaults', {
        reason: 'personality-key-fallback',
      });
    }
    return personality;
  }

  private dispatchTick(): void {
    if (this._generating) return;

    const lapDistPct = this.getRaceState().hero?.lapDistPct ?? 0;

    void this.readPersonality().then((personality) => {
      if (this._generating) return;
      const msg = this.queue.dequeueNext(lapDistPct, this.zones);
      if (!msg) return;

      // Energy=1 (Tranquil) suppresses Tier 2 alerts at dequeue time (FR-017).
      // Tier 3 commentary suppression is enforced earlier, in the synthesizer.
      if (msg.tier !== 3 && shouldSuppressAlert(msg, personality)) {
        logger.info('[engineer] Alert suppressed', { alertType: msg.eventType, reason: 'Energy:1' });
        return;
      }

      this._generating = true;
      void this.generateAndPublish(msg);
    });
  }

  // Single dispatch point for all tiers (Model A): the queued message — a Tier 1/2
  // alert or a Tier 3 sentence clip — is synthesized to TTS and published to
  // voice:audio. Tier 1/2 refs carry eventType; Tier 3 refs carry tier3Type.
  private async generateAndPublish(msg: QueuedMessage): Promise<void> {
    const label = msg.tier === 3 ? msg.tier3Type : msg.eventType;
    try {
      const buffer = await this.generateClipFn(msg.messageText, this.config);
      logger.info('[engineer] Clip generated', { label, tier: msg.tier });
      const { audioId, clipUrl, storedAt } = this.audioStore.store(buffer);
      const ref: AudioClipRef =
        msg.tier === 3
          ? { audioId, clipUrl, tier: 3, tier3Type: msg.tier3Type, generatedAt: storedAt }
          : { audioId, clipUrl, tier: msg.tier, eventType: msg.eventType, generatedAt: storedAt };
      await this.commandConn.publish('voice:audio', JSON.stringify(ref));
      logger.info('[engineer] Clip published', { label, tier: msg.tier, audioId });
    } catch (err) {
      logger.error('[engineer] TTS failure', {
        label,
        tier: msg.tier,
        failureReason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this._generating = false;
    }
  }

  async stop(): Promise<void> {
    if (this.dispatchTimer) clearInterval(this.dispatchTimer);
    this.dispatchTimer = null;
    if (this.sub) {
      await this.sub.quit();
      this.sub = null;
    }
  }
}
