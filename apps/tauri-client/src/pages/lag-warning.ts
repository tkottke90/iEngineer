// T029/B2+E1 (SC-005): the stream-lag warning's appearance/dismissal state
// machine, pure over (state, lagMs, now) so tests drive the clock directly.
//
// Rules:
// - The FIRST received snapshot NEVER triggers the warning — it only arms the
//   guard (hasReceivedFirstSnapshot). From the second snapshot on, any
//   lag > 500ms shows the warning immediately (no appearance hysteresis).
// - Dismissal is time-based: the warning clears only after lag has been
//   continuously ≤ 500ms for 5 wall-clock seconds; a single spike resets the
//   countdown.

export const LAG_THRESHOLD_MS = 500;
export const DISMISS_HYSTERESIS_MS = 5000;

export interface LagWarningState {
  visible: boolean;
  clearStartedAt: number | null;
  hasReceivedFirstSnapshot: boolean;
}

export const initialLagWarningState: LagWarningState = {
  visible: false,
  clearStartedAt: null,
  hasReceivedFirstSnapshot: false,
};

export function lagWarningReducer(
  state: LagWarningState,
  lagMs: number | null,
  nowMs: number,
): LagWarningState {
  if (!state.hasReceivedFirstSnapshot) {
    // First event arms the guard and is ignored for warning purposes —
    // regardless of its lag value (T029/B2).
    return { visible: false, clearStartedAt: null, hasReceivedFirstSnapshot: true };
  }

  const over = lagMs !== null && lagMs > LAG_THRESHOLD_MS;
  if (over) {
    // Immediate appearance; any spike also resets the dismissal countdown.
    return { visible: true, clearStartedAt: null, hasReceivedFirstSnapshot: true };
  }
  if (!state.visible) {
    return state;
  }
  const started = state.clearStartedAt ?? nowMs;
  if (nowMs - started >= DISMISS_HYSTERESIS_MS) {
    return { visible: false, clearStartedAt: null, hasReceivedFirstSnapshot: true };
  }
  return { visible: true, clearStartedAt: started, hasReceivedFirstSnapshot: true };
}
