// SC-005 lag-warning state machine (T029/B2 + E1) — appearance guard AND the
// full dismissal path, with the clock passed in (no Date.now mocking needed).
import { describe, it, expect } from 'vitest';
import {
  lagWarningReducer,
  initialLagWarningState,
  type LagWarningState,
} from './lag-warning.js';

function feed(events: Array<[number | null, number]>): LagWarningState {
  return events.reduce<LagWarningState>(
    (state, [lag, now]) => lagWarningReducer(state, lag, now),
    initialLagWarningState,
  );
}

describe('lagWarningReducer (SC-005)', () => {
  it('B2: a >500ms FIRST snapshot does NOT trigger the warning', () => {
    const state = feed([[900, 1000]]);
    expect(state.visible).toBe(false);
    expect(state.hasReceivedFirstSnapshot).toBe(true);
  });

  it('appears immediately on the first eligible (post-guard) snapshot over 500ms', () => {
    const state = feed([
      [100, 1000], // arms guard
      [501, 2000],
    ]);
    expect(state.visible).toBe(true);
  });

  it('E1 (dismissal path): 5 continuous seconds at ≤500ms dismisses the warning', () => {
    const state = feed([
      [100, 0], // guard
      [900, 1000], // warning ON
      [400, 2000], // countdown starts at 2000
      [300, 4000],
      [200, 6000],
      [100, 7000], // 5000ms elapsed since 2000 → dismissed
    ]);
    expect(state.visible).toBe(false);
  });

  it('a single spike inside the 5s window resets the countdown', () => {
    const state = feed([
      [100, 0], // guard
      [900, 1000], // ON
      [400, 2000], // countdown from 2000
      [800, 4000], // spike — reset
      [300, 5000], // countdown restarts at 5000
      [200, 8000], // only 3000ms — still visible
    ]);
    expect(state.visible).toBe(true);
    const after = lagWarningReducer(state, 100, 10_000); // 5000ms since 5000
    expect(after.visible).toBe(false);
  });

  it('null lag (caught up / Redis unavailable) never shows a warning and counts toward dismissal', () => {
    const noWarn = feed([
      [null, 0],
      [null, 1000],
    ]);
    expect(noWarn.visible).toBe(false);

    const dismissed = feed([
      [100, 0],
      [900, 1000], // ON
      [null, 2000], // countdown from 2000
      [null, 7000], // 5000ms → dismissed
    ]);
    expect(dismissed.visible).toBe(false);
  });
});
