import { describe, it } from 'mocha';
import { expect } from 'chai';
import { SessionMemoryStore } from '../../../src/engineer/session-memory.js';
import { OverrideTracker } from '../../../src/engineer/override-tracker.js';

function setup(threshold = 2): { mem: SessionMemoryStore; tracker: OverrideTracker } {
  const mem = new SessionMemoryStore('s1');
  return { mem, tracker: new OverrideTracker(mem, threshold) };
}

describe('override-tracker (FR-019/020/021)', () => {
  it('records a pending pit recommendation', () => {
    const { mem, tracker } = setup();
    tracker.recordRecommendation('pit', 12);
    const recs = mem.get().recommendations;
    expect(recs).to.have.length(1);
    expect(recs[0].outcome).to.equal('pending');
    expect(recs[0].actionWindow.recommendedLap).to.equal(12);
  });

  it('marks OVERRIDDEN when the recommended lap completes without a pit entry (FR-019)', () => {
    const { mem, tracker } = setup();
    tracker.recordRecommendation('pit', 12);
    tracker.onLapComplete(12); // completed the recommended lap, no pit
    expect(mem.get().recommendations[0].outcome).to.equal('overridden');
    expect(mem.get().deference.overrideCountByType.pit).to.equal(1);
  });

  it('marks FOLLOWED on a pit entry within the window; not counted toward deference (FR-020)', () => {
    const { mem, tracker } = setup();
    tracker.recordRecommendation('pit', 12);
    tracker.onPitEntry(12);
    tracker.onLapComplete(12); // already followed — must not flip to overridden
    expect(mem.get().recommendations[0].outcome).to.equal('followed');
    expect(mem.get().deference.overrideCountByType.pit ?? 0).to.equal(0);
  });

  it('enters deference mode for a type after threshold overrides (FR-021)', () => {
    const { mem, tracker } = setup(2);
    tracker.recordRecommendation('pit', 10);
    tracker.onLapComplete(10); // override 1
    expect(mem.get().deference.deferredTypes).to.not.include('pit');
    tracker.recordRecommendation('pit', 15);
    tracker.onLapComplete(15); // override 2 → threshold
    expect(mem.get().deference.deferredTypes).to.include('pit');
  });

  it('reset() clears recommendations and deference for a new session', () => {
    const { mem, tracker } = setup();
    tracker.recordRecommendation('pit', 10);
    tracker.onLapComplete(10);
    mem.reset('s2');
    expect(mem.get().recommendations).to.have.length(0);
    expect(mem.get().deference.deferredTypes).to.have.length(0);
    expect(mem.get().sessionId).to.equal('s2');
  });
});
