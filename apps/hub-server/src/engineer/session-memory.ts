import type {
  SessionMemory,
  RecommendationLogEntry,
  RecommendationOutcome,
} from '@iracing-engineer/types';

function emptyMemory(sessionId: string): SessionMemory {
  return {
    sessionId,
    recommendations: [],
    fuelCalibration: null,
    deference: { overrideCountByType: {}, deferredTypes: [] },
  };
}

/**
 * Per-session in-memory record consumed by context-assembler (FR-018). Holds the
 * recommendation log, override outcomes, the latest fuel-calibration snapshot,
 * and deference state. Resets on a new session. Recommendation/deference
 * mutation logic is filled in by US4 (T055/T056) and US5 (T059); this scaffold
 * provides the container and the accessors those tasks build on.
 */
export class SessionMemoryStore {
  private mem: SessionMemory;

  constructor(sessionId = '') {
    this.mem = emptyMemory(sessionId);
  }

  get(): SessionMemory {
    return this.mem;
  }

  /** Reset all session memory (including deference) for a new session (FR-021). */
  reset(sessionId: string): void {
    this.mem = emptyMemory(sessionId);
  }

  addRecommendation(entry: RecommendationLogEntry): void {
    this.mem.recommendations.push(entry);
  }

  updateRecommendationOutcome(recId: string, outcome: RecommendationOutcome): void {
    const rec = this.mem.recommendations.find((r) => r.recId === recId);
    if (rec) rec.outcome = outcome;
  }

  setFuelCalibration(calibration: Record<string, unknown> | null): void {
    this.mem.fuelCalibration = calibration;
  }
}
