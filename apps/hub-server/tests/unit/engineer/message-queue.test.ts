import { describe, it } from 'mocha';
import { expect } from 'chai';
import type {
  QueuedAlert,
  AlertTier,
  AlertEventType,
  RadioBlackoutZone,
} from '@iracing-engineer/types';
import { PriorityMessageQueue } from '../../../src/engineer/message-queue.js';
import { logger } from '../../../src/logger.js';

function alert(tier: AlertTier, eventType: AlertEventType, lapNumber = 1): QueuedAlert {
  return {
    tier,
    eventType,
    messageText: `${eventType}`,
    lapNumber,
    sessionTime: 0,
    dedupKey: eventType,
  };
}

/** A competitor pit alert exactly as T2-02/T2-03 produce it (contract templates). */
function pitAlert(
  eventType: 'competitor:pit_entry' | 'competitor:pit_exit',
  carNumber: string,
  pos: number,
): QueuedAlert {
  const messageText =
    eventType === 'competitor:pit_entry'
      ? `Car ${carNumber} pitting from P${pos}`
      : `Car ${carNumber} out of pits, P${pos}`;
  return {
    tier: 2,
    eventType,
    messageText,
    lapNumber: 1,
    sessionTime: 0,
    dedupKey: `${eventType}:${carNumber}`,
  };
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

  it('FR-014/007: two pending pit entries dequeue as ONE coalesced alert', () => {
    const q = new PriorityMessageQueue();
    q.enqueue(pitAlert('competitor:pit_entry', '31', 6));
    q.enqueue(pitAlert('competitor:pit_entry', '45', 7));
    const merged = q.dequeueNext(0.7, ZONE);
    expect(merged).to.not.be.null;
    expect((merged as QueuedAlert).messageText).to.equal('Cars 31 and 45 are pitting');
    expect((merged as QueuedAlert).eventType).to.equal('competitor:pit_entry');
    // merged alert counts as ONE dequeued item — nothing left behind
    expect(q.length).to.equal(0);
    expect(q.dequeueNext(0.7, ZONE)).to.be.null;
  });

  it('FR-014/007: three or more pit entries use the count template', () => {
    const q = new PriorityMessageQueue();
    q.enqueue(pitAlert('competitor:pit_entry', '31', 6));
    q.enqueue(pitAlert('competitor:pit_entry', '45', 7));
    q.enqueue(pitAlert('competitor:pit_entry', '7', 9));
    const merged = q.dequeueNext(0.7, ZONE);
    expect((merged as QueuedAlert).messageText).to.equal('3 cars around you are pitting');
  });

  it('FR-014/007: pit exits coalesce with their own templates', () => {
    const q = new PriorityMessageQueue();
    q.enqueue(pitAlert('competitor:pit_exit', '31', 6));
    q.enqueue(pitAlert('competitor:pit_exit', '45', 7));
    expect((q.dequeueNext(0.7, ZONE) as QueuedAlert).messageText).to.equal(
      'Cars 31 and 45 back out of the pits',
    );
    const q3 = new PriorityMessageQueue();
    q3.enqueue(pitAlert('competitor:pit_exit', '31', 6));
    q3.enqueue(pitAlert('competitor:pit_exit', '45', 7));
    q3.enqueue(pitAlert('competitor:pit_exit', '7', 9));
    expect((q3.dequeueNext(0.7, ZONE) as QueuedAlert).messageText).to.equal(
      '3 cars back out of the pits',
    );
  });

  it('FR-014/007: entries NEVER merge with exits', () => {
    const q = new PriorityMessageQueue();
    q.enqueue(pitAlert('competitor:pit_entry', '31', 6));
    q.enqueue(pitAlert('competitor:pit_exit', '45', 7));
    const first = q.dequeueNext(0.7, ZONE) as QueuedAlert;
    expect(first.messageText).to.equal('Car 31 pitting from P6'); // single, unchanged
    const second = q.dequeueNext(0.7, ZONE) as QueuedAlert;
    expect(second.messageText).to.equal('Car 45 out of pits, P7');
  });

  it('FR-009/007: Tier 1 dequeues FIRST and is never merged with coalescible pit alerts', () => {
    const q = new PriorityMessageQueue();
    q.enqueue(pitAlert('competitor:pit_entry', '31', 6));
    q.enqueue(pitAlert('competitor:pit_entry', '45', 7));
    q.enqueue(alert(1, 'session:safety_car_deployed'));
    const first = q.dequeueNext(0.7, ZONE) as QueuedAlert;
    expect(first.tier).to.equal(1);
    expect(first.messageText).to.equal('session:safety_car_deployed'); // untouched by merge
    const second = q.dequeueNext(0.7, ZONE) as QueuedAlert;
    expect(second.messageText).to.equal('Cars 31 and 45 are pitting');
  });

  it('FR-014/007: a single pit alert passes through unchanged', () => {
    const q = new PriorityMessageQueue();
    q.enqueue(pitAlert('competitor:pit_entry', '31', 6));
    const a = q.dequeueNext(0.7, ZONE) as QueuedAlert;
    expect(a.messageText).to.equal('Car 31 pitting from P6');
    expect(a.lapNumber).to.equal(1);
  });

  it('FR-014/007: merged alert takes lapNumber/sessionTime from the head (earliest) alert', () => {
    const q = new PriorityMessageQueue();
    q.enqueue({ ...pitAlert('competitor:pit_entry', '31', 6), lapNumber: 4, sessionTime: 400 });
    q.enqueue({ ...pitAlert('competitor:pit_entry', '45', 7), lapNumber: 5, sessionTime: 500 });
    const merged = q.dequeueNext(0.7, ZONE) as QueuedAlert;
    expect(merged.lapNumber).to.equal(4);
    expect(merged.sessionTime).to.equal(400);
  });

  it('FR-014/007: alerts_coalesced logged with eventType, mergedCount, carNumbers', () => {
    const captured: Array<Record<string, unknown> | undefined> = [];
    const orig = logger.info;
    (logger as unknown as { info: (m: string, meta?: Record<string, unknown>) => void }).info = (
      _m,
      meta,
    ) => captured.push(meta);
    try {
      const q = new PriorityMessageQueue();
      q.enqueue(pitAlert('competitor:pit_entry', '31', 6));
      q.enqueue(pitAlert('competitor:pit_entry', '45', 7));
      q.dequeueNext(0.7, ZONE);
      const log = captured.find((m) => m?.event === 'alerts_coalesced');
      expect(log, 'alerts_coalesced log entry').to.not.be.undefined;
      expect(log!.eventType).to.equal('competitor:pit_entry');
      expect(log!.mergedCount).to.equal(2);
      expect(log!.carNumbers).to.deep.equal(['31', '45']);
    } finally {
      (logger as unknown as { info: typeof logger.info }).info = orig;
    }
  });

  it('FR-014/007: an alert dropped by the 30s gate is NOT resurrected by a later merge', () => {
    let clock = 1_000_000;
    const q = new PriorityMessageQueue(() => clock);
    q.enqueue(pitAlert('competitor:pit_entry', '31', 6)); // enqueuedAt = 1_000_000
    clock += 30_000;
    expect(q.dequeueNext(0.5, ZONE)).to.be.null; // gated → 31 dropped individually
    q.enqueue(pitAlert('competitor:pit_entry', '45', 7));
    q.enqueue(pitAlert('competitor:pit_entry', '7', 9));
    const merged = q.dequeueNext(0.7, ZONE) as QueuedAlert;
    expect(merged.messageText).to.equal('Cars 45 and 7 are pitting'); // 31 stays dropped
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
