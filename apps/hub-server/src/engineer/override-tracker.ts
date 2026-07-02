import type { RecommendationLogEntry } from '@iracing-engineer/types';
import type { SessionMemoryStore } from './session-memory.js';
import { logger } from '../logger.js';

let recCounter = 0;

/**
 * Tracks driver overrides of pit recommendations (FR-019/020) and maintains the
 * per-type deference count (FR-021). The pit recommendation is the M4
 * `hero:pit_window_open` alert; its action window is the recommended lap (clarify
 * Q2). Outcomes and deference state live in SessionMemory so context-assembler can
 * surface them to the LLM.
 */
export class OverrideTracker {
  constructor(
    private memory: SessionMemoryStore,
    private deferenceThreshold: number,
  ) {}

  /** Record a new pit recommendation at `recommendedLap` (window = that lap). */
  recordRecommendation(type: string, recommendedLap: number): string {
    const recId = `rec-${type}-${recommendedLap}-${++recCounter}`;
    this.memory.addRecommendation({
      recId,
      type,
      issuedAtMs: 0,
      actionWindow: { recommendedLap },
      outcome: 'pending',
    });
    logger.info('[engineer] Recommendation logged', { recId, type, recommendedLap });
    return recId;
  }

  /**
   * Driver entered the pit lane on `lap`. A pending pit recommendation whose window
   * this lap reaches is FOLLOWED — not counted toward deference (FR-020).
   */
  onPitEntry(lap: number): void {
    for (const rec of this.pendingPitRecs()) {
      if (lap >= rec.actionWindow.recommendedLap) {
        rec.outcome = 'followed';
        logger.info('[engineer] Pit recommendation followed', { recId: rec.recId, lap });
      }
    }
  }

  /**
   * Hero completed `lap`. A pending pit recommendation whose recommended lap is now
   * complete WITHOUT a pit entry is OVERRIDDEN; the engineer stops advocating it and
   * the override counts toward per-type deference (FR-019/021).
   */
  onLapComplete(lap: number): void {
    for (const rec of this.pendingPitRecs()) {
      if (lap >= rec.actionWindow.recommendedLap) {
        rec.outcome = 'overridden';
        this.recordOverride(rec.type);
        logger.info('[engineer] Pit recommendation overridden — engineer will stop advocating', {
          recId: rec.recId,
          lap,
        });
      }
    }
  }

  private pendingPitRecs(): RecommendationLogEntry[] {
    return this.memory
      .get()
      .recommendations.filter((r) => r.type === 'pit' && r.outcome === 'pending');
  }

  private recordOverride(type: string): void {
    const d = this.memory.get().deference;
    d.overrideCountByType[type] = (d.overrideCountByType[type] ?? 0) + 1;
    if (d.overrideCountByType[type] >= this.deferenceThreshold && !d.deferredTypes.includes(type)) {
      d.deferredTypes.push(type);
      logger.info('[engineer] Entering deference (information) mode for recommendation type', {
        type,
        overrides: d.overrideCountByType[type],
        threshold: this.deferenceThreshold,
      });
    }
  }
}
