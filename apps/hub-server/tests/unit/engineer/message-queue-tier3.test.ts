import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { QueuedAlert, QueuedTier3, AlertEventType, Tier3Type, RadioBlackoutZone } from '@iracing-engineer/types';
import { PriorityMessageQueue } from '../../../src/engineer/message-queue.js';

function a(tier: 1 | 2, eventType: AlertEventType): QueuedAlert {
  return { tier, eventType, messageText: 'x', lapNumber: 1, sessionTime: 0, dedupKey: eventType };
}
function t3(tier3Type: Tier3Type, sentenceIndex = 0): QueuedTier3 {
  return { tier: 3, tier3Type, messageText: `s${sentenceIndex}`, sentenceIndex };
}

const NO_ZONES: RadioBlackoutZone[] = [];
const WHOLE_LAP: RadioBlackoutZone[] = [{ lapDistPctStart: 0, lapDistPctEnd: 1 }];

describe('PriorityMessageQueue — Tier 3 (FR-015)', () => {
  it('dispatches Tier 1 > Tier 2 > Tier 3', () => {
    const q = new PriorityMessageQueue();
    q.enqueue(t3('post-sector'));
    q.enqueue(a(2, 'hero:pit_window_open'));
    q.enqueue(a(1, 'hero:fuel_critical'));

    expect(q.dequeueNext(0.1, NO_ZONES)?.tier).to.equal(1);
    expect(q.dequeueNext(0.1, NO_ZONES)?.tier).to.equal(2);
    expect(q.dequeueNext(0.1, NO_ZONES)?.tier).to.equal(3);
    expect(q.dequeueNext(0.1, NO_ZONES)).to.equal(null);
  });

  it('within Tier 3, a driver-query outranks proactive commentary (then FIFO)', () => {
    const q = new PriorityMessageQueue();
    q.enqueue(t3('post-sector'));
    q.enqueue(t3('driver-query'));
    q.enqueue(t3('pit-entry'));

    const first = q.dequeueNext(0.1, NO_ZONES);
    expect(first?.tier === 3 && first.tier3Type).to.equal('driver-query');
    // remaining proactive items in FIFO order
    const second = q.dequeueNext(0.1, NO_ZONES);
    expect(second?.tier === 3 && second.tier3Type).to.equal('post-sector');
    const third = q.dequeueNext(0.1, NO_ZONES);
    expect(third?.tier === 3 && third.tier3Type).to.equal('pit-entry');
  });

  it('a gated Tier 2 blocks Tier 3 from releasing early', () => {
    const q = new PriorityMessageQueue();
    q.enqueue(a(2, 'hero:pit_window_open'));
    q.enqueue(t3('post-sector'));

    // Inside a blackout zone: Tier 2 is held AND Tier 3 must not jump ahead.
    expect(q.dequeueNext(0.5, WHOLE_LAP)).to.equal(null);
    // Once safe, Tier 2 goes first, then Tier 3.
    expect(q.dequeueNext(0.5, NO_ZONES)?.tier).to.equal(2);
    expect(q.dequeueNext(0.5, NO_ZONES)?.tier).to.equal(3);
  });

  it('a Tier 1 alert preempts still-pending Tier 3 sentences', () => {
    const q = new PriorityMessageQueue();
    q.enqueue(t3('driver-query', 0));
    q.enqueue(t3('driver-query', 1));
    q.enqueue(a(1, 'hero:blue_flag')); // arrives mid-answer

    expect(q.dequeueNext(0.1, NO_ZONES)?.tier).to.equal(1); // preempts pending Tier 3
    expect(q.dequeueNext(0.1, NO_ZONES)?.tier).to.equal(3);
    expect(q.dequeueNext(0.1, NO_ZONES)?.tier).to.equal(3);
  });
});
