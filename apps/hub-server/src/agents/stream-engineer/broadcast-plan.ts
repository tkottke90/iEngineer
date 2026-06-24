import type { BroadcastPlan, PrimarySubject, LiveOperatorSignal, HeroCarStatus } from "@iracing-engineer/types";

export class BroadcastPlanManager {
  private plan: BroadcastPlan | null;
  private heroStatuses = new Map<number, HeroCarStatus>();

  constructor(plan: BroadcastPlan | null) {
    this.plan = plan;
  }

  applyOperatorSignal(signal: LiveOperatorSignal): void {
    switch (signal.type) {
      case "hero_status":
        this.heroStatuses.set(signal.carIdx, signal.status);
        break;
      case "storyline_update":
        if (!this.plan) break;
        const subject = this.plan.primarySubjects.find((s) => s.carIdx === signal.carIdx);
        if (subject) subject.storylineAnnotation = signal.annotation;
        break;
      case "incident_flag":
        // TODO: surface to stream engineer for priority override
        break;
    }
  }

  getActivePlan(): BroadcastPlan | null {
    return this.plan;
  }

  getSubjectsForCoverage(): PrimarySubject[] {
    if (!this.plan) return [];
    return this.plan.primarySubjects.filter((s) => {
      const status = this.heroStatuses.get(s.carIdx);
      return status !== "dnf";
    });
  }

  shouldContinueAfterDnf(carIdx: number): boolean {
    if (!this.plan) return false;
    const dnfBehavior = this.plan.dnfBehavior;
    if (dnfBehavior === "end_broadcast") return false;
    if (dnfBehavior === "convert_to_general") return true;
    // continue_on_secondary: check if there's another primary subject
    return this.plan.primarySubjects.some((s) => s.carIdx !== carIdx);
  }
}
