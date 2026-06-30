import { describe, it } from 'mocha';
import { expect } from 'chai';
import { reclaimPendingMessages } from '../../../src/redis/consumer.js';

describe('Redis Consumer infrastructure', () => {
  it('XAUTOCLAIM unit test: reclaimPendingMessages uses configurable idleMs and returns reclaimedCount', async () => {
    const xautoclaimCalls: unknown[] = [];
    let reclaimedCount = 0;

    // Mock Redis with XAUTOCLAIM response
    const mockRedis = {
      xautoclaim: async (...args: unknown[]) => {
        xautoclaimCalls.push(args);
        // Return format: [nextId, entries, deletedIds]
        return ['0-0', [['1-1', ['payload', '{"test":1}']], ['1-2', ['payload', '{"test":2}']]], []];
      },
    } as any;

    reclaimedCount = await reclaimPendingMessages(mockRedis, 5000); // custom idleMs = 5000

    expect(xautoclaimCalls.length).to.be.greaterThan(0);
    // Verify idleMs was passed as 5000
    const firstCall = xautoclaimCalls[0] as unknown[];
    expect(firstCall).to.include(5000);
    // Should not be hardcoded to 3600000
    expect(firstCall).to.not.include(3600000);
    // reclaimedCount should reflect reclaimed entries
    expect(reclaimedCount).to.equal(6); // 2 entries per stream × 3 streams = 6
  });

  it('XREVRANGE startup seed: streamConsumerLoop calls XREVRANGE once before first XREADGROUP and passes result to onSessionEvent callback', async () => {
    const xrevrangeCalls: unknown[][] = [];
    const xreadgroupCalls: unknown[][] = [];
    const sessionEventPayloads: string[] = [];

    const abortSignal = { aborted: false };

    // Mock Redis consumer connection
    const mockConsumer = {
      xreadgroup: async (...args: unknown[]) => {
        xreadgroupCalls.push(args);
        // Abort after first call
        abortSignal.aborted = true;
        return null;
      },
    } as any;

    // Mock Redis command connection
    const mockCommand = {
      xrevrange: async (...args: unknown[]) => {
        xrevrangeCalls.push(args as unknown[]);
        return [['1-0', ['payload', '{"active":true,"ts":123,"track_name":"Test","player_car_name":"BMW","player_car_idx":3,"session_type":"Race","wall_clock_time":"12:00"}']]] as any;
      },
      xack: async () => 1,
    } as any;

    const { streamConsumerLoop } = await import('../../../src/redis/consumer.js');

    await streamConsumerLoop(
      mockConsumer,
      mockCommand,
      async () => {},
      async () => {},
      async (payload) => { sessionEventPayloads.push(payload); },
      abortSignal,
    );

    // XREVRANGE must be called exactly once before XREADGROUP
    expect(xrevrangeCalls.length).to.equal(1);
    expect(xrevrangeCalls[0]).to.include('iracing:events:session');
    expect(xrevrangeCalls[0]).to.include('+');
    expect(xrevrangeCalls[0]).to.include('-');
    // Result must be passed to onSessionEvent
    expect(sessionEventPayloads.length).to.equal(1);
    expect(sessionEventPayloads[0]).to.include('track_name');
  });
});
