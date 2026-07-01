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
import { logger } from './logger.js';

let _started = false;
let _abortSignal: { aborted: boolean } | null = null;
let _liveProcessor: LiveProcessor | null = null;
let _engineer: RacingEngineerService | null = null;

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
  _engineer = new RacingEngineerService(
    commandConn,
    audioStore,
    new PriorityMessageQueue(),
    new DedupTracker(),
    getSnapshot,
    loadBlackoutZones(),
    engineerConfig,
  );
  _engineer.start().then(
    () => logger.info('[hub] Racing Engineer started'),
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
