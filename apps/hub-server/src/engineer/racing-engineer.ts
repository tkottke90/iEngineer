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
  Tier3Type,
} from '@iracing-engineer/types';
import type { QueuedAlert } from '@iracing-engineer/types';
import { AudioStore } from './audio-store.js';
import { PriorityMessageQueue } from './message-queue.js';
import { DedupTracker } from './dedup-tracker.js';
import { GapAlertMonitor } from './gap-alert-monitor.js';
import { evaluateTier1, evaluateTier2 } from './alert-rules.js';
import { generateClip } from './tts-client.js';
import { shouldSuppressAlert, parsePersonality } from './personality-config.js';
import type { Tier3Synthesizer } from './tier3-synthesizer.js';
import type { OverrideTracker } from './override-tracker.js';
import { logger } from '../logger.js';
import { performance } from 'node:perf_hooks';

const DISPATCH_INTERVAL_MS = 100;

// Dedup scope for the scoped-event-cleared alert types (007 data-model.md):
// carIdx for competitor pit alerts, degradation level for the pace alert.
function scopeForEvent(event: RaceEvent): string | undefined {
  switch (event.type) {
    case 'competitor:pit_entry':
    case 'competitor:pit_exit':
      return typeof event.payload.carIdx === 'number' ? String(event.payload.carIdx) : undefined;
    case 'hero:pace_degradation':
      return typeof event.payload.signal === 'string' ? event.payload.signal : undefined;
    default:
      return undefined;
  }
}

// Injectable so tests can supply a fake TTS without hitting Chatterbox.
type ClipGenerator = (text: string, config: EngineerConfig) => Promise<Buffer>;

interface SynthRequest {
  type: Tier3Type;
  triggerSource: string;
  userText: string;
  isDriverQuery: boolean;
}

export class RacingEngineerService {
  private sub: Redis | null = null;
  private dispatchTimer: ReturnType<typeof setInterval> | null = null;
  private _generating = false;
  private _personalityWarnEmitted = false;
  private _personalitySeeded = false;
  // Unified serialized synthesis: driver-query + proactive briefings run one at a
  // time (single LLM call in flight). queueDepthCap bounds pending PTT queries (Q4).
  private _synthQueue: SynthRequest[] = [];
  private _synthInFlight = false;
  private _lapCompleteCount = 0;
  // T2-04/05 (007 US2): state-driven gap alerts, evaluated each dispatch tick.
  // Fired alerts route through enqueueAlert; the monitor's own arm/disarm state
  // is the dedup (DedupTracker bypassed by design — research.md R3).
  private gapMonitor: GapAlertMonitor;

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
    private overrides: OverrideTracker | null = null,
  ) {
    this.gapMonitor = new GapAlertMonitor(config, getRaceState, (alert) =>
      this.enqueueAlert(alert),
    );
  }

  // Shared enqueue + FR-012 accounting for rule-path and monitor alerts.
  private enqueueAlert(alert: QueuedAlert): void {
    this.queue.enqueue(alert);
    logger.info('[engineer] Alert enqueued', {
      component: 'engineer',
      event: 'alert_enqueued',
      alertType: alert.eventType,
      tier: alert.tier,
      lapNumber: alert.lapNumber,
    });
  }

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
        component: 'engineer',
        event: 'subscribe_failed',
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
      logger.info('[engineer] PTT query ignored — empty transcript', {
        component: 'engineer',
        event: 'ptt_query_ignored_empty',
        queryId: q.queryId,
      });
      return;
    }
    this.enqueueSynth({
      type: 'driver-query',
      triggerSource: q.queryId,
      userText: q.transcript,
      isDriverQuery: true,
    });
  }

  // Enqueue a Tier 3 synthesis request. PTT queries are bounded by queueDepthCap
  // (Q4); proactive briefings are infrequent and always enqueue.
  private enqueueSynth(req: SynthRequest): void {
    if (req.isDriverQuery) {
      const pending = this._synthQueue.filter((r) => r.isDriverQuery).length;
      if (pending >= this.config.queueDepthCap) {
        logger.warn('[engineer] PTT query dropped — queue depth cap reached', {
          component: 'engineer',
          event: 'ptt_query_dropped',
          reason: 'queue-cap-drop',
          queryId: req.triggerSource,
        });
        return;
      }
    }
    this._synthQueue.push(req);
    void this.drainSynth();
  }

  // One synthesis at a time (single LLM call in flight); the rest wait FIFO.
  private async drainSynth(): Promise<void> {
    if (this._synthInFlight) return;
    if (!this.synthesizer) return;
    this._synthInFlight = true;
    try {
      while (this._synthQueue.length > 0) {
        const req = this._synthQueue.shift()!;
        // Isolate each synthesis: a failure logs and drops that request but must
        // not reject drainSynth (an unhandled rejection would crash the hub) or
        // stall the queue behind it (SC-003 graceful degradation).
        try {
          const personality = await this.readPersonality();
          await this.synthesizer.synthesize({
            type: req.type,
            triggerSource: req.triggerSource,
            userText: req.userText,
            personality,
          });
        } catch (err) {
          logger.error('[engineer] Tier 3 synthesis failed', {
            component: 'engineer',
            event: 'tier3_synthesis_failed',
            type: req.type,
            triggerSource: req.triggerSource,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this._synthInFlight = false;
    }
  }

  // Proactive Tier 3 triggers on hub:events (US2). Safety-car ALSO fires its
  // immediate Tier 1 alert via the rule path (FR-016) — this is additive.
  private maybeProactive(event: RaceEvent): void {
    if (!this.synthesizer) return;
    switch (event.type) {
      case 'hero:pit_entry':
        this.enqueueSynth({
          type: 'pit-entry',
          triggerSource: 'hero:pit_entry',
          userText:
            'Give a brief pit-lane entry briefing — what to expect this stop given the current strategy.',
          isDriverQuery: false,
        });
        break;
      case 'session:safety_car_deployed':
        this.enqueueSynth({
          type: 'safety-car',
          triggerSource: 'session:safety_car_deployed',
          userText:
            'A safety car has been deployed. Brief the driver on what it means for their position and strategy.',
          isDriverQuery: false,
        });
        break;
      case 'hero:lap_complete':
        // Cadence gate: at most once per postSectorMinLapGap laps. Energy=1
        // suppression is enforced in the synthesizer.
        this._lapCompleteCount += 1;
        if (this._lapCompleteCount % Math.max(1, this.config.postSectorMinLapGap) === 0) {
          this.enqueueSynth({
            type: 'post-sector',
            triggerSource: 'hero:lap_complete',
            userText: 'Give a short comment on the lap just completed.',
            isDriverQuery: false,
          });
        }
        break;
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
        // 007 US3 (FR-008): pit exit is the stint boundary — clear BOTH pace
        // degradation level scopes so the new stint re-arms.
        this.dedup.recordCleared('hero:pace_degradation');
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
      // 007 US1: competitor pit events are clear signals for each other's
      // per-car key AND alert candidates — dual role, so NO early return
      // (contract §Compatibility notes).
      case 'competitor:pit_entry':
        if (typeof event.payload.carIdx === 'number') {
          this.dedup.recordCleared('competitor:pit_exit', String(event.payload.carIdx));
        }
        break;
      case 'competitor:pit_exit':
        if (typeof event.payload.carIdx === 'number') {
          this.dedup.recordCleared('competitor:pit_entry', String(event.payload.carIdx));
        }
        break;
    }

    // Proactive Tier 3 briefings (additive to the rule path).
    this.maybeProactive(event);

    // Feed override tracking (US4): pit entry / lap completion drive the outcome
    // of any pending pit recommendation.
    if (this.overrides) {
      if (event.type === 'hero:pit_entry') this.overrides.onPitEntry(event.lapNumber);
      else if (event.type === 'hero:lap_complete') this.overrides.onLapComplete(event.lapNumber);
    }

    const state = this.getRaceState();
    const alert = evaluateTier1(event, this.config) ?? evaluateTier2(event, state, this.config);
    if (!alert) return;

    // 007: scoped dedup dimension — per car for competitor pit alerts, per
    // level for pace degradation (data-model.md §Dedup keys).
    const scope = scopeForEvent(event);
    if (!this.dedup.shouldFire(alert.eventType, alert.lapNumber, scope)) {
      logger.info('[engineer] Alert deduplicated', {
        component: 'engineer',
        event: 'alert_deduplicated',
        alertType: alert.eventType,
        dedupKey: alert.dedupKey,
        lapNumber: alert.lapNumber,
      });
      return;
    }
    this.dedup.recordFired(alert.eventType, alert.lapNumber, scope);
    this.enqueueAlert(alert);

    // The pit-window-open alert IS the pit recommendation (US4) — log it so the
    // override tracker can resolve it as followed/overridden.
    if (this.overrides && alert.eventType === 'hero:pit_window_open') {
      this.overrides.recordRecommendation('pit', alert.lapNumber);
    }
  }

  private async readPersonality(): Promise<PersonalityConfig> {
    let raw: string | null = null;
    try {
      raw = await this.commandConn.get('hub:config:personality');
    } catch {
      raw = null;
    }
    const { personality, usedFallback } = parsePersonality(raw, this.config.personality);
    if (usedFallback) {
      if (!this._personalityWarnEmitted) {
        this._personalityWarnEmitted = true;
        logger.warn(
          '[engineer] Personality key absent, malformed, or out of range — using config defaults',
          {
            component: 'engineer',
            event: 'personality_fallback',
            reason: 'personality-key-fallback',
          },
        );
      }
      // Seed the resolved default back to Redis so the key exists for the Setup UI
      // and subsequent reads stop falling back (self-heals an absent/malformed key).
      // Attempted once per process, best-effort — GET already succeeded, so the
      // connection is up and SET will normally succeed; on failure we keep the
      // in-memory default and do NOT retry (avoids a per-tick write/log storm).
      if (!this._personalitySeeded) {
        this._personalitySeeded = true;
        try {
          await this.commandConn.set('hub:config:personality', JSON.stringify(personality));
          logger.info('[engineer] Personality default seeded to Redis', {
            component: 'engineer',
            event: 'personality_seeded',
          });
        } catch (err) {
          logger.warn('[engineer] Failed to seed personality default to Redis', {
            component: 'engineer',
            event: 'personality_seed_failed',
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return personality;
  }

  private dispatchTick(): void {
    // Gap monitor runs BEFORE dequeue (plan §Gap alerts) so a crossing detected
    // this tick is dispatchable this tick.
    this.gapMonitor.tick();

    if (this._generating) return;

    const lapDistPct = this.getRaceState().hero?.lapDistPct ?? 0;

    void this.readPersonality().then((personality) => {
      if (this._generating) return;
      const msg = this.queue.dequeueNext(lapDistPct, this.zones);
      if (!msg) return;

      // Energy=1 (Tranquil) suppresses Tier 2 alerts at dequeue time (FR-017).
      // Tier 3 commentary suppression is enforced earlier, in the synthesizer.
      if (msg.tier !== 3 && shouldSuppressAlert(msg, personality)) {
        logger.info('[engineer] Alert suppressed', {
          component: 'engineer',
          event: 'alert_suppressed',
          alertType: msg.eventType,
          reason: 'Energy:1',
        });
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
    // Per-generation timing (Tier 3 only); Tier 1/2 alerts are rule-based, no inference.
    const timing = msg.tier === 3 ? msg.timing : undefined;
    try {
      // Audio stage: TTS round-trip to Chatterbox for this one sentence/clip.
      const audioStart = performance.now();
      const buffer = await this.generateClipFn(msg.messageText, this.config);
      const audioMs = Math.round(performance.now() - audioStart);
      logger.info('[engineer] Clip generated', {
        component: 'engineer',
        event: 'clip_generated',
        label,
        tier: msg.tier,
        audioMs,
      });
      const { audioId, clipUrl, storedAt } = this.audioStore.store(buffer);
      const ref: AudioClipRef =
        msg.tier === 3
          ? { audioId, clipUrl, tier: 3, tier3Type: msg.tier3Type, generatedAt: storedAt }
          : { audioId, clipUrl, tier: msg.tier, eventType: msg.eventType, generatedAt: storedAt };
      await this.commandConn.publish('voice:audio', JSON.stringify(ref));
      logger.info('[engineer] Clip published', {
        component: 'engineer',
        event: 'clip_published',
        label,
        tier: msg.tier,
        audioId,
        // Inference stage (whole LLM call for this generation); null for Tier 1/2,
        // or for a Tier 3 clip published before inference finished (streamed clip).
        inferenceMs: timing?.inferenceMs ?? null,
        audioMs,
        // End-to-end: inference trigger → this clip on voice:audio (Tier 3 only).
        totalMs: timing ? Math.round(performance.now() - timing.startedAt) : null,
      });
    } catch (err) {
      logger.error('[engineer] TTS failure', {
        component: 'engineer',
        event: 'tts_failure',
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
