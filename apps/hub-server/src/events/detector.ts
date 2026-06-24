import type { RaceStateManager } from "../state/race-state.js";
import type { EventBus } from "./bus.js";
import type { CarState } from "@iracing-engineer/types";

const FUEL_CRITICAL_LAPS = 2;
const GAP_CLOSING_THRESHOLD = 2.0;
const GAP_BATTLE_THRESHOLD = 1.0;

export class EventDetector {
  private prevField: Record<number, CarState> = {};

  constructor(
    private readonly state: RaceStateManager,
    private readonly bus: EventBus,
  ) {}

  async checkPositionChanges(): Promise<void> {
    const { session, field } = this.state.getState();
    for (const [idxStr, car] of Object.entries(field)) {
      const carIdx = Number(idxStr);
      const prev = this.prevField[carIdx];
      if (prev && prev.position !== car.position) {
        await this.bus.emit({
          type: "competitor:position_change",
          sessionId: session.sessionId,
          sessionTime: 0, // TODO: read from state
          lapNumber: car.lapCompleted,
          lapDistPct: car.lapDistPct,
          payload: { carIdx, from: prev.position, to: car.position },
        });
      }
    }
    this.prevField = { ...field };
  }

  async checkPitEvents(): Promise<void> {
    const { session, field, hero } = this.state.getState();
    for (const [idxStr, car] of Object.entries(field)) {
      const carIdx = Number(idxStr);
      const prev = this.prevField[carIdx];
      if (!prev) continue;
      const isHero = hero?.carIdx === carIdx;
      if (!prev.onPitRoad && car.onPitRoad) {
        await this.bus.emit({
          type: isHero ? "hero:pit_entry" : "competitor:pit_entry",
          sessionId: session.sessionId,
          sessionTime: 0,
          lapNumber: car.lapCompleted,
          lapDistPct: car.lapDistPct,
          payload: { carIdx },
        });
      }
      if (prev.onPitRoad && !car.onPitRoad) {
        await this.bus.emit({
          type: isHero ? "hero:pit_exit" : "competitor:pit_exit",
          sessionId: session.sessionId,
          sessionTime: 0,
          lapNumber: car.lapCompleted,
          lapDistPct: car.lapDistPct,
          payload: { carIdx },
        });
      }
    }
  }

  async checkFuelCritical(): Promise<void> {
    const { session, hero } = this.state.getState();
    if (!hero) return;
    // TODO: integrate with FuelModel for lapsRemaining
    // Emit hero:fuel_critical when lapsRemaining < FUEL_CRITICAL_LAPS
  }

  async checkGapThresholds(): Promise<void> {
    // TODO: iterate active GapModels, emit gap:closing / gap:battle / gap:resolved
  }

  async checkFlags(): Promise<void> {
    // TODO: compare prev flags vs current, emit session:flag_* events
  }

  async checkBlueFlagForHero(): Promise<void> {
    // TODO: detect blue flag state for hero car
  }
}
