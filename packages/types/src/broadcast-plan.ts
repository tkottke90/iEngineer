export type BroadcastType = "hero" | "general";
export type DnfBehavior = "end_broadcast" | "convert_to_general" | "continue_on_secondary";
export type CutRate = "conservative" | "default" | "dynamic";
export type CoverageStyle = "hero_focused" | "default" | "narrative";
export type EditorialAggression = "reactive" | "default" | "anticipatory";

export interface ProductionStyle {
  cutRate: CutRate;
  coverageStyle: CoverageStyle;
  editorialAggression: EditorialAggression;
}

export interface PrimarySubject {
  carIdx: number;
  carNumber: string;
  driverName: string;
  priority: number;
  storylineAnnotation: string | null;
  expectedPitDurationSeconds: number | null;
}

export interface BroadcastPlan {
  id: string;
  sessionId: string;
  broadcastType: BroadcastType;
  primarySubjects: PrimarySubject[];
  dnfBehavior: DnfBehavior;
  productionStyle: ProductionStyle;
  preRaceNotes: string | null;
  createdAt: number;
  updatedAt: number;
}

export type HeroCarStatus = "active" | "in_repair" | "dnf";

export type LiveOperatorSignal =
  | {
      type: "hero_status";
      carIdx: number;
      status: HeroCarStatus;
      repairTimerSeconds?: number;
    }
  | {
      type: "storyline_update";
      carIdx: number;
      annotation: string;
    }
  | {
      type: "incident_flag";
      carIdx: number;
      description: string;
      sessionTime: number;
    };
