import Redis from 'ioredis';
import { logger } from '../logger.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

function makeRetryStrategy(attempt: number): number | null {
  const delay = Math.min(1000 * 2 ** attempt, 15000);
  logger.info('[hub] Redis reconnecting', { attempt, delayMs: delay });
  return delay;
}

let _consumerConn: Redis | null = null;
let _commandConn: Redis | null = null;

export function createConsumerConnection(): Redis {
  if (!_consumerConn) {
    _consumerConn = new Redis(REDIS_URL, { retryStrategy: makeRetryStrategy });
  }
  return _consumerConn;
}

export function createCommandConnection(): Redis {
  if (!_commandConn) {
    _commandConn = new Redis(REDIS_URL, { retryStrategy: makeRetryStrategy });
  }
  return _commandConn;
}
