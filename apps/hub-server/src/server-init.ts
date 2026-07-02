import { createConsumerConnection, createCommandConnection } from './redis/client.js';
import { setupConsumerGroups, reclaimPendingMessages, streamConsumerLoop } from './redis/consumer.js';
import { SessionEventProcessor } from './pipeline/session-event-processor.js';
import { SessionProcessor } from './pipeline/session-processor.js';
import { LiveProcessor } from './pipeline/live-processor.js';
import { FuelModelEngine } from './models/fuel-model.js';
import { TireModelEngine } from './models/tire-model.js';
import { GapModelEngine } from './models/gap-model.js';
import { getSnapshot } from './state/race-state.js';
import { AudioStore, setAudioStore } from './engineer/audio-store.js';
import { PriorityMessageQueue } from './engineer/message-queue.js';
import { DedupTracker } from './engineer/dedup-tracker.js';
import { RacingEngineerService } from './engineer/racing-engineer.js';
import { loadEngineerConfig, loadBlackoutZones } from './engineer/personality-config.js';
import { createTools } from './engineer/tools.js';
import { SessionMemoryStore } from './engineer/session-memory.js';
import { Tier3Synthesizer } from './engineer/tier3-synthesizer.js';
import { OverrideTracker } from './engineer/override-tracker.js';
import { runMigrations } from './db/client.js';
import { logger } from './logger.js';

let _started = false;
let _abortSignal: { aborted: boolean } | null = null;
let _liveProcessor: LiveProcessor | null = null;
let _engineer: RacingEngineerService | null = null;
let _synthesizer: Tier3Synthesizer | null = null;

// Exposed so the engineer:query subscription (T038) and proactive triggers (T049)
// can drive Tier 3 synthesis. Shares the RacingEngineerService priority queue so
// Tier 3 clips are dispatched after pending Tier 1/2 (Model A, FR-015).
export function getTier3Synthesizer(): Tier3Synthesizer | null {
  return _synthesizer;
}

export async function startPipeline(): Promise<void> {
  if (_started) return;
  _started = true;
  _abortSignal = { aborted: false };

  const consumerConn = createConsumerConnection();
  const commandConn = createCommandConnection();

  await setupConsumerGroups(commandConn);
  await reclaimPendingMessages(commandConn);

  const fuelModel = new FuelModelEngine();
  const tireModel = new TireModelEngine();
  const gapModel = new GapModelEngine();

  const sessionEventProcessor = new SessionEventProcessor(commandConn);
  const sessionProcessor = new SessionProcessor(commandConn, fuelModel, tireModel, gapModel);
  _liveProcessor = new LiveProcessor(commandConn);

  _liveProcessor.start();
  logger.info('[hub] Live Processor started (60 Hz)');
  logger.info('[hub] Session Processor started (15 Hz)');
  logger.info('[hub] Awaiting telemetry...');

  // Racing Engineer (M4) — subscribes to hub:events, alerts via TTS.
  const engineerConfig = loadEngineerConfig();
  const audioStore = new AudioStore(engineerConfig.audioIdleCleanupIntervalMs);
  setAudioStore(audioStore);
  // One shared priority queue: the dispatcher drains it for all tiers (Model A).
  const queue = new PriorityMessageQueue();

  // M5 Tier 3 reasoning engine — Postgres audit + LLM synthesizer sharing the queue.
  // Migrations are best-effort: a Postgres outage degrades Tier 3 (audit fail-closed)
  // but never blocks the M4 rule path (Constitution I).
  runMigrations().then(
    (applied) => logger.info('[hub] engineer_events migrations applied', { applied }),
    (err) => logger.error('[hub] engineer_events migrations failed — Tier 3 audit degraded', { error: String(err) }),
  );
  const tools = createTools({
    getFuelModel: () => {
      try {
        return fuelModel.getSnapshot();
      } catch {
        return null;
      }
    },
    getTireModel: () => {
      try {
        return tireModel.getSnapshot();
      } catch {
        return null;
      }
    },
  });
  // One session memory shared by the synthesizer (reads it into context) and the
  // override tracker (writes recommendation outcomes + deference state).
  const sessionMemory = new SessionMemoryStore();
  _synthesizer = new Tier3Synthesizer(getSnapshot, sessionMemory, tools, queue, engineerConfig);
  const overrideTracker = new OverrideTracker(sessionMemory, engineerConfig.deferenceThreshold);

  _engineer = new RacingEngineerService(
    commandConn,
    audioStore,
    queue,
    new DedupTracker(),
    getSnapshot,
    loadBlackoutZones(),
    engineerConfig,
    _synthesizer,
    undefined,
    overrideTracker,
  );
  _engineer.start().then(
    () => logger.info('[hub] Racing Engineer started (Tier 1/2 alerts + Tier 3 PTT queries)'),
    (err) => logger.error('[hub] Racing Engineer failed to start', { error: String(err) }),
  );

  // Start the consumer loop (runs indefinitely)
  streamConsumerLoop(
    consumerConn,
    commandConn,
    (payload) => _liveProcessor!.onLiveTelemetry(payload),
    (payload) => sessionProcessor.onSessionTelemetry(payload),
    (payload) => sessionEventProcessor.onSessionEvent(payload),
    _abortSignal,
  ).catch(err => {
    logger.error('[hub] Consumer loop fatal error', { error: String(err) });
  });

  process.on('SIGTERM', () => shutdown(consumerConn, commandConn));
  process.on('SIGINT', () => shutdown(consumerConn, commandConn));
}

async function shutdown(consumerConn: InstanceType<typeof import('ioredis').default>, commandConn: InstanceType<typeof import('ioredis').default>): Promise<void> {
  logger.info('[hub] Graceful shutdown initiated');
  if (_abortSignal) _abortSignal.aborted = true;
  if (_liveProcessor) _liveProcessor.stop();
  if (_engineer) await _engineer.stop();
  await consumerConn.quit();
  await commandConn.quit();
  process.exit(0);
}
