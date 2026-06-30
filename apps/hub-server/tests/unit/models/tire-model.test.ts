import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { TireModelEngine } from '../../../src/models/tire-model.js';

describe('TireModel', () => {
  let engine: TireModelEngine;

  beforeEach(() => {
    engine = new TireModelEngine();
  });

  it('degradationSignal is "nominal" when trend < 0.3s', () => {
    // Inject laps with increasing time < 0.3s trend
    engine.onLapCompletion(90.0, false, false);
    engine.onLapCompletion(90.1, false, false);
    engine.onLapCompletion(90.15, false, false);
    const snap = engine.getSnapshot();
    expect(snap.degradationSignal).to.equal('nominal');
  });

  it('degradationSignal is "watch" when trend 0.3–0.6s', () => {
    engine.onLapCompletion(90.0, false, false);
    engine.onLapCompletion(90.2, false, false);
    engine.onLapCompletion(90.45, false, false);
    const snap = engine.getSnapshot();
    expect(snap.degradationSignal).to.equal('watch');
  });

  it('degradationSignal is "critical" when trend > 0.6s', () => {
    engine.onLapCompletion(90.0, false, false);
    engine.onLapCompletion(90.4, false, false);
    engine.onLapCompletion(90.8, false, false);
    const snap = engine.getSnapshot();
    expect(snap.degradationSignal).to.equal('critical');
  });

  it('degradationSignal is "watch" when trend is exactly 0.6s (upper boundary — NOT critical)', () => {
    engine.onLapCompletion(90.0, false, false);
    engine.onLapCompletion(90.3, false, false);
    engine.onLapCompletion(90.6, false, false);
    const snap = engine.getSnapshot();
    expect(snap.degradationSignal).to.equal('watch');
  });

  it('degradationSignal is "watch" when trend is exactly 0.3s (lower boundary — NOT nominal)', () => {
    engine.onLapCompletion(90.0, false, false);
    engine.onLapCompletion(90.15, false, false);
    engine.onLapCompletion(90.3, false, false);
    const snap = engine.getSnapshot();
    expect(snap.degradationSignal).to.equal('watch');
  });

  it('outlap and inlap are excluded from stint median', () => {
    engine.onLapCompletion(120.0, true, false);   // outlap — excluded
    engine.onLapCompletion(90.0, false, false);
    engine.onLapCompletion(90.2, false, false);
    engine.onLapCompletion(85.0, false, true);    // inlap — excluded
    const snap = engine.getSnapshot();
    // Median of [90.0, 90.2] = 90.1, trend from 90.0 to 90.1 is ~0.1 → nominal
    expect(snap.degradationSignal).to.equal('nominal');
    expect(snap.lapAge).to.equal(2); // outlap + inlap not counted
  });
});
