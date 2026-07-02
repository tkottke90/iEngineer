import type Redis from 'ioredis';
import type {
  RaceEvent,
  RaceState,
  EngineerConfig,
  RadioBlackoutZone,
  AudioClipRef,
  QueuedAlert,
  PersonalityConfig,
} from '@iracing-engineer/types';
import { AudioStore } from './audio-store.js';
import { PriorityMessageQueue } from './message-queue.js';
import { DedupTracker } from './dedup-tracker.js';
import { evaluateTier1, evaluateTier2 } from './alert-rules.js';
import { generateClip } from './tts-client.js';
import { shouldSuppressAlert, parsePersonality } from './personality-config.js';
import { logger } from '../logger.js';

const DISPATCH_INTERVAL_MS = 100;

export class RacingEngineerService {
  private sub: Redis | null = null;
  private dispatchTimer: ReturnType<typeof setInterval> | null = null;
  private _generating = false;
  private _personalityWarnEmitted = false;

  constructor(
    private commandConn: Redis,
    private audioStore: AudioStore,
    private queue: PriorityMessageQueue,
    private dedup: DedupTracker,
    private getRaceState: () => RaceState,
    private zones: RadioBlackoutZone[],
    private config: EngineerConfig,
  ) {}

  async start(): Promise<void> {
    // A subscribed ioredis connection cannot issue other commands, so use a
    // dedicated duplicate for pub/sub. Wrap subscription so a Redis failure
    // degrades the service silently rather than crashing the hub.
    try {
      this.sub = this.commandConn.duplicate();
      await this.sub.subscribe('hub:events');
      this.sub.on('message', (_channel: string, message: string) => {
        this.onEvent(message);
      });
    } catch (err) {
      logger.error('[engineer] Failed to subscribe to hub:events', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    this.dispatchTimer = setInterval(() => this.dispatchTick(), DISPATCH_INTERVAL_MS);
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
      const alert = this.queue.dequeueNext(lapDistPct, this.zones);
      if (!alert) return;

      // Energy=1 (Tranquil) suppresses Tier 2 alerts at dequeue time (FR-017).
      if (shouldSuppressAlert(alert, personality)) {
        logger.info('[engineer] Alert suppressed', { alertType: alert.eventType, reason: 'Energy:1' });
        return;
      }

      this._generating = true;
      void this.generateAndPublish(alert);
    });
  }

  private async generateAndPublish(alert: QueuedAlert): Promise<void> {
    try {
      const buffer = await generateClip(alert.messageText, this.config);
      logger.info('[engineer] Clip generated', { alertType: alert.eventType, tier: alert.tier, lapNumber: alert.lapNumber });
      const { audioId, clipUrl, storedAt } = this.audioStore.store(buffer);
      const ref: AudioClipRef = {
        audioId,
        clipUrl,
        tier: alert.tier,
        eventType: alert.eventType,
        generatedAt: storedAt,
      };
      await this.commandConn.publish('voice:audio', JSON.stringify(ref));
      logger.info('[engineer] Clip published', { alertType: alert.eventType, tier: alert.tier, audioId });
    } catch (err) {
      logger.error('[engineer] TTS failure', {
        alertType: alert.eventType,
        tier: alert.tier,
        lapNumber: alert.lapNumber,
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
