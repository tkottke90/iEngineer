import type { CarState, SessionState } from '@iracing-engineer/types';
import type { RaceEvent } from '@iracing-engineer/types';

export type BattleStatus = 'open' | 'closing' | 'battle' | 'resolved';

export interface GapEntry {
  leadCarIdx: number;
  trailCarIdx: number;
  gapSeconds: number;
  gapTrend: number;
  closingRate: number;
  lapsToContact: number | null;
  battleStatus: BattleStatus;
}

interface PairState {
  entry: GapEntry;
  prevGap: number;
  fastClosingTicks: number;
  wideGapTicks: number;
}

export interface GapUpdateResult {
  changed: GapEntry[];
  events: Pick<RaceEvent, 'type' | 'payload'>[];
}

const LAPPED_CAR_THRESHOLD = 0.8;
const BATTLE_GAP = 1.0;
const RESOLVE_GAP = 1.5;
const RESOLVE_TICKS = 2;
const PULLING_AWAY_RATE = 0.3;
const PULLING_AWAY_TICKS = 2;

export class GapModelEngine {
  private pairs: Map<string, PairState> = new Map();

  update(field: Record<number, CarState>, sessionState: SessionState & { estimatedLapTime?: number }): GapUpdateResult {
    const estimatedLapTime = (sessionState as any).estimatedLapTime ?? 90;
    const lappedThreshold = LAPPED_CAR_THRESHOLD * estimatedLapTime;

    // Sort cars by position ascending
    const cars = Object.values(field).sort((a, b) => a.position - b.position || a.carIdx - b.carIdx);

    const changed: GapEntry[] = [];
    const events: Pick<RaceEvent, 'type' | 'payload'>[] = [];

    for (let i = 0; i < cars.length - 1; i++) {
      const lead = cars[i];
      const trail = cars[i + 1];
      const key = `${lead.carIdx}-${trail.carIdx}`;

      const rawGap = trail.gapToLeader - lead.gapToLeader;
      const gapSeconds = Math.abs(rawGap);

      // Lapped car detection: negative gap or gap > 80% of lap time
      const isLapped = trail.gapToLeader < 0 || gapSeconds > lappedThreshold;

      const prev = this.pairs.get(key);
      const prevGap = prev?.prevGap ?? gapSeconds;
      const closingRate = prevGap - gapSeconds; // positive = gap closing

      let state = prev?.entry ?? { leadCarIdx: lead.carIdx, trailCarIdx: trail.carIdx, gapSeconds, gapTrend: 0, closingRate, lapsToContact: null, battleStatus: 'open' as BattleStatus };
      const prevStatus = state.battleStatus;

      // Update state fields
      state = { ...state, gapSeconds, gapTrend: gapSeconds - prevGap, closingRate };

      let fastClosingTicks = prev?.fastClosingTicks ?? 0;
      let wideGapTicks = prev?.wideGapTicks ?? 0;

      if (isLapped) {
        state.battleStatus = 'open';
        state.lapsToContact = null;
        fastClosingTicks = 0;
        wideGapTicks = 0;
      } else {
        // Battle state machine
        if (gapSeconds <= BATTLE_GAP) {
          state.battleStatus = 'battle';
          state.lapsToContact = closingRate > 0 ? gapSeconds / closingRate : null;
          wideGapTicks = 0;
        } else if (gapSeconds <= RESOLVE_GAP && prevStatus !== 'resolved') {
          if (prevStatus === 'battle' || prevStatus === 'closing') {
            // Gap widened but not past resolve threshold
            wideGapTicks++;
          }
          state.battleStatus = prevStatus === 'battle' || prevStatus === 'closing' ? prevStatus : 'open';
          state.lapsToContact = null;
        } else {
          if (prevStatus === 'battle' || prevStatus === 'closing') {
            wideGapTicks++;
            if (wideGapTicks >= RESOLVE_TICKS) {
              state.battleStatus = 'resolved';
            } else {
              state.battleStatus = prevStatus;
            }
          } else if (prevStatus !== 'resolved') {
            state.battleStatus = 'open';
          }
          state.lapsToContact = null;
        }

        // Closing/opening transition for non-resolved states
        if (state.battleStatus !== 'resolved' && state.battleStatus !== 'battle') {
          if (closingRate > 0 && gapSeconds > BATTLE_GAP) {
            state.battleStatus = 'closing';
          } else if (gapSeconds > RESOLVE_GAP && state.battleStatus !== 'resolved') {
            state.battleStatus = prevStatus === 'resolved' ? 'resolved' : 'open';
          }
        }

        // gap:pulling_away: closingRate > 0.3 s/lap for 2+ ticks in battle/closing
        if ((state.battleStatus === 'battle' || state.battleStatus === 'closing') && closingRate > PULLING_AWAY_RATE) {
          fastClosingTicks++;
          if (fastClosingTicks >= PULLING_AWAY_TICKS) {
            events.push({ type: 'gap:pulling_away', payload: { leadCarIdx: lead.carIdx, trailCarIdx: trail.carIdx, gapDelta: closingRate } });
          }
        } else {
          fastClosingTicks = 0;
        }
      }

      this.pairs.set(key, { entry: state, prevGap: gapSeconds, fastClosingTicks, wideGapTicks });

      if (state.battleStatus !== prevStatus) {
        changed.push(state);
        // Emit specific gap events for status transitions
        if (state.battleStatus === 'battle') {
          events.push({ type: 'gap:battle', payload: { leadCarIdx: lead.carIdx, trailCarIdx: trail.carIdx, gapSeconds } });
        } else if (state.battleStatus === 'closing') {
          events.push({ type: 'gap:closing', payload: { leadCarIdx: lead.carIdx, trailCarIdx: trail.carIdx, gapSeconds, lapsToContact: state.lapsToContact } });
        } else if (state.battleStatus === 'resolved') {
          events.push({ type: 'gap:resolved', payload: { leadCarIdx: lead.carIdx, trailCarIdx: trail.carIdx } });
        }
      }
    }

    return { changed, events };
  }

  getEntries(): GapEntry[] {
    return Array.from(this.pairs.values()).map(p => p.entry);
  }
}
