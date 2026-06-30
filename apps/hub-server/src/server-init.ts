import { createConsumerConnection, createCommandConnection } from './redis/client.js';
import { setupConsumerGroups, reclaimPendingMessages, streamConsumerLoop } from './redis/consumer.js';
import { SessionEventProcessor } from './pipeline/session-event-processor.js';
import { SessionProcessor } from './pipeline/session-processor.js';
import { LiveProcessor } from './pipeline/live-processor.js';
import { FuelModelEngine } from './models/fuel-model.js';
import { TireModelEngine } from './models/tire-model.js';
import { GapModelEngine } from './models/gap-model.js';

let _started = false;
let _abortSignal: { aborted: boolean } | null = null;
let _liveProcessor: LiveProcessor | null = null;

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
  console.log(JSON.stringify({ msg: '[hub] Live Processor started (60 Hz)' }));
  console.log(JSON.stringify({ msg: '[hub] Session Processor started (15 Hz)' }));
  console.log(JSON.stringify({ msg: '[hub] Awaiting telemetry...' }));

  // Start the consumer loop (runs indefinitely)
  streamConsumerLoop(
    consumerConn,
    commandConn,
    (payload) => _liveProcessor!.onLiveTelemetry(payload),
    (payload) => sessionProcessor.onSessionTelemetry(payload),
    (payload) => sessionEventProcessor.onSessionEvent(payload),
    _abortSignal,
  ).catch(err => {
    console.error(JSON.stringify({ msg: '[hub] Consumer loop fatal error', error: String(err) }));
  });

  process.on('SIGTERM', () => shutdown(consumerConn, commandConn));
  process.on('SIGINT', () => shutdown(consumerConn, commandConn));
}

async function shutdown(consumerConn: InstanceType<typeof import('ioredis').default>, commandConn: InstanceType<typeof import('ioredis').default>): Promise<void> {
  console.log(JSON.stringify({ msg: '[hub] Graceful shutdown initiated' }));
  if (_abortSignal) _abortSignal.aborted = true;
  if (_liveProcessor) _liveProcessor.stop();
  await consumerConn.quit();
  await commandConn.quit();
  process.exit(0);
}
