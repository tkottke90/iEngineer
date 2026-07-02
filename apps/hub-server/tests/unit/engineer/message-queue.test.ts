import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import type { QueuedAlert, AlertTier, AlertEventType, RadioBlackoutZone } from '@iracing-engineer/types';
import { PriorityMessageQueue } from '../../../src/engineer/message-queue.js';
import { logger } from '../../../src/logger.js';

function alert(tier: AlertTier, eventType: AlertEventType, lapNumber = 1): QueuedAlert {
  return { tier, eventType, messageText: `${eventType}`, lapNumber, sessionTime: 0, dedupKey: eventType };
}

const ZONE: RadioBlackoutZone[] = [{ lapDistPctStart: 0.4, lapDistPctEnd: 0.6 }];

describe('PriorityMessageQueue', () => {
  it('Tier 1 dequeues before Tier 2', () => {
    const q = new PriorityMessageQueue();
    q.enqueue(alert(2, 'hero:pit_window_open'));
    q.enqueue(alert(1, 'hero:blue_flag'));
    expect(q.dequeueNext(0.5, [])!.tier).to.equal(1);
  });

  it('two simultaneous Tier 1 alerts both dequeue in FIFO order (Edge Case 2)', () => {
    const q = new PriorityMessageQueue();
    q.enqueue(alert(1, 'hero:blue_flag'));
    q.enqueue(alert(1, 'session:safety_car_deployed'));
    expect(q.dequeueNext(0.5, [])!.eventType).to.equal('hero:blue_flag');
    expect(q.dequeueNext(0.5, [])!.eventType).to.equal('session:safety_car_deployed');
    expect(q.dequeueNext(0.5, [])).to.be.null;
  });

  it('Tier 2 held during blackout zone, delivered after zone clears', () => {
    const q = new PriorityMessageQueue();
    q.enqueue(alert(2, 'hero:pit_window_open'));
    expect(q.dequeueNext(0.5, ZONE)).to.be.null; // 0.5 is inside 0.4–0.6
    expect(q.dequeueNext(0.7, ZONE)!.eventType).to.equal('hero:pit_window_open'); // 0.7 is safe
  });

  it('zone boundaries are inclusive', () => {
    const q = new PriorityMessageQueue();
    q.enqueue(alert(2, 'hero:pit_window_open'));
    expect(q.dequeueNext(0.4, ZONE)).to.be.null; // start boundary inclusive
  });

  it('empty queue returns null', () => {
    expect(new PriorityMessageQueue().dequeueNext(0.5, [])).to.be.null;
  });

  it('T034: Tier 1 bypasses blackout zone and dequeues before held Tier 2', () => {
    const q = new PriorityMessageQueue();
    q.enqueue(alert(2, 'hero:pit_window_open'));
    q.enqueue(alert(1, 'session:safety_car_deployed'));
    // lapDistPct 0.5 is inside the blackout zone — Tier 2 is gated, but Tier 1
    // bypasses the gate and dequeues first.
    const first = q.dequeueNext(0.5, ZONE);
    expect(first!.tier).to.equal(1);
    expect(first!.eventType).to.equal('session:safety_car_deployed');
    // Tier 2 remains held while still in the zone.
    expect(q.dequeueNext(0.5, ZONE)).to.be.null;
  });

  it('FR-017: Tier 2 dropped after 30s with no safe window; 29s alert still delivered', () => {
    let clock = 1_000_000;
    const logs: string[] = [];
    const orig = logger.warn;
    (logger as unknown as { warn: (m: string) => void }).warn = (m: string) => logs.push(String(m));
    try {
      const q = new PriorityMessageQueue(() => clock);
      q.enqueue(alert(2, 'hero:pit_window_open')); // enqueuedAt = 1_000_000
      clock += 30_000; // advance 30s
      expect(q.dequeueNext(0.5, ZONE)).to.be.null; // dropped (still gated)
      expect(logs.some((l) => l.includes('no safe window within 30s'))).to.be.true;

      // Boundary: a 29s-old alert is still delivered when the zone clears.
      clock = 2_000_000;
      q.enqueue(alert(2, 'hero:pit_window_open'));
      clock += 29_000;
      expect(q.dequeueNext(0.7, ZONE)!.eventType).to.equal('hero:pit_window_open');
    } finally {
      (logger as unknown as { warn: typeof logger.warn }).warn = orig;
    }
  });
});
