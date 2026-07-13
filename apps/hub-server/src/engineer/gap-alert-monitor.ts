import type {
  RaceState,
  CarState,
  HeroState,
  EngineerConfig,
  QueuedAlert,
} from '@iracing-engineer/types';
import { logger } from '../logger.js';

// T2-04/T2-05 (007 US2, FR-004–FR-007): state-driven gap alerts. The gap
// model's events cannot express crossings of the configurable threshold
// (research.md R1), so this monitor reads RaceState on the dispatch tick and
// detects them itself. Its arm/disarm state IS the dedup — the DedupTracker is
// deliberately bypassed (research.md R3).

type Direction = 'ahead' | 'behind';
type SuppressionReason = 'caution' | 'hero-on-pit-road' | 'adjacent-on-pit-road';

// Mirrors the gap model's LAPPED_CAR_THRESHOLD so both components agree on
// what "lapped" means (data-model.md §Lapped-scale definition).
const LAPPED_SCALE = 0.8;
const DEFAULT_LAP_TIME_S = 90;

interface DirectionState {
  adjacentCarIdx: number | null;
  // Init FALSE — arms on the first observation of g ≥ T, so a gap already
  // under T at first sight (green flag, post-overtake) never fires (FR-004).
  closingArmed: boolean;
  // Arms only via a closing fire — a battle never seen crossing below T
  // produces no breaking-away confirmation (FR-005).
  wideningArmed: boolean;
  // Previous tick's suppression state: a suppression-condition CLEARING resets
  // the slot to disarmed (no alert burst as the field spreads out again).
  wasSuppressed: boolean;
}

function freshSlot(): DirectionState {
  return { adjacentCarIdx: null, closingArmed: false, wideningArmed: false, wasSuppressed: false };
}

export class GapAlertMonitor {
  private slots: Record<Direction, DirectionState> = {
    ahead: freshSlot(),
    behind: freshSlot(),
  };

  constructor(
    private config: EngineerConfig,
    private getRaceState: () => RaceState,
    // Injected so the service routes fired alerts through its own
    // enqueue/logging path — and tests observe alerts without Redis.
    private enqueue: (alert: QueuedAlert) => void,
  ) {}

  /** Evaluate both directions once. Called from the 100ms dispatch tick. */
  tick(): void {
    const state = this.getRaceState();
    const hero = state.hero;
    if (!hero) {
      // Standing non-battle condition (pre-session) — reset silently.
      this.slots.ahead = freshSlot();
      this.slots.behind = freshSlot();
      return;
    }
    this.evaluate('ahead', state, hero);
    this.evaluate('behind', state, hero);
  }

  private evaluate(direction: Direction, state: RaceState, hero: HeroState): void {
    const adjacent = findByPosition(
      state,
      direction === 'ahead' ? hero.position - 1 : hero.position + 1,
      hero.carIdx,
    );

    // Standing non-battle conditions reset the slot and are never logged per
    // tick (FR-007): no adjacent car, or a cross-class adjacent car (valid
    // class data on both cars — degenerate data falls back to evaluating,
    // same rule as pit relevance).
    if (!adjacent || isCrossClass(hero, adjacent)) {
      this.slots[direction] = freshSlot();
      return;
    }

    const gap =
      direction === 'ahead'
        ? hero.gapToLeader - adjacent.gapToLeader
        : adjacent.gapToLeader - hero.gapToLeader;
    if (!isBattleGap(gap, hero)) {
      this.slots[direction] = freshSlot();
      return;
    }

    let slot = this.slots[direction];

    // Adjacency change: a different car is now the battle partner — the old
    // arm state is meaningless (FR-004 crossing semantics restart).
    if (slot.adjacentCarIdx !== adjacent.carIdx) {
      slot = freshSlot();
      this.slots[direction] = slot;
    }
    slot.adjacentCarIdx = adjacent.carIdx;

    // Suppression (FR-007): evaluation CONTINUES with firing replaced by
    // logging, so a would-fire crossing mid-caution is still accountable
    // (US2-AC7). When the condition clears, the slot restarts disarmed.
    const suppression = suppressionReason(state, hero, adjacent);
    if (slot.wasSuppressed && suppression === null) {
      slot = freshSlot();
      slot.adjacentCarIdx = adjacent.carIdx;
      this.slots[direction] = slot;
    }
    slot.wasSuppressed = suppression !== null;

    const T = this.config.gapThresholdSeconds;
    const M = this.config.gapHysteresisMarginSeconds;

    if (gap >= T && !slot.closingArmed && !slot.wideningArmed) {
      slot.closingArmed = true; // initial arming — no fire
      return;
    }
    if (gap < T && slot.closingArmed) {
      this.fire(direction, 'gap:closing', gap, hero, suppression);
      slot.closingArmed = false;
      slot.wideningArmed = true;
      return;
    }
    if (gap > T + M && slot.wideningArmed) {
      this.fire(direction, 'gap:pulling_away', gap, hero, suppression);
      slot.wideningArmed = false;
      slot.closingArmed = true;
    }
    // T ≤ gap ≤ T+M: dead band — no transitions (FR-006).
  }

  private fire(
    direction: Direction,
    eventType: 'gap:closing' | 'gap:pulling_away',
    gap: number,
    hero: HeroState,
    suppression: SuppressionReason | null,
  ): void {
    if (suppression !== null) {
      logger.info('[engineer] Gap alert suppressed', {
        component: 'engineer',
        event: 'gap_alert_suppressed',
        direction,
        reason: suppression,
      });
      return;
    }
    const g = gap.toFixed(1);
    const messageText =
      eventType === 'gap:closing'
        ? direction === 'ahead'
          ? `Gap closing — ${g} seconds to the car ahead`
          : `Car behind closing — gap ${g} seconds`
        : direction === 'ahead'
          ? `Losing touch — gap ${g} seconds to the car ahead`
          : `Gap ${g} seconds — you're pulling away`;
    this.enqueue({
      tier: 2,
      eventType,
      messageText,
      // Gap/degradation EVENTS publish lapNumber 0 (research.md R6); the
      // monitor is state-driven, so lap metadata comes from the hero.
      lapNumber: hero.lapCompleted,
      sessionTime: 0,
      dedupKey: `${eventType}:${direction}`, // descriptive — logging only, monitor state is the dedup
    });
  }
}

function findByPosition(state: RaceState, position: number, heroCarIdx: number): CarState | null {
  if (position < 1) return null;
  for (const car of Object.values(state.field)) {
    if (car.carIdx !== heroCarIdx && car.position === position) return car;
  }
  return null;
}

function isCrossClass(hero: HeroState, adjacent: CarState): boolean {
  const classValid =
    hero.carClassId > 0 &&
    adjacent.carClassId > 0 &&
    hero.classPosition > 0 &&
    adjacent.classPosition > 0;
  return classValid && adjacent.carClassId !== hero.carClassId;
}

function isBattleGap(gap: number, hero: HeroState): boolean {
  if (!Number.isFinite(gap) || gap <= 0) return false;
  const lapTime = hero.estimatedLapTime > 0 ? hero.estimatedLapTime : DEFAULT_LAP_TIME_S;
  return gap <= LAPPED_SCALE * lapTime;
}

function suppressionReason(
  state: RaceState,
  hero: HeroState,
  adjacent: CarState,
): SuppressionReason | null {
  if (state.session?.sessionPhase === 'Caution') return 'caution';
  if (hero.onPitRoad) return 'hero-on-pit-road';
  if (adjacent.onPitRoad) return 'adjacent-on-pit-road';
  return null;
}
