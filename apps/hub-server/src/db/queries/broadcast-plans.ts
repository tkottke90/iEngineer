import { db } from "../client.js";
import type { BroadcastPlan } from "@iracing-engineer/types";

export async function savePlan(plan: BroadcastPlan): Promise<void> {
  await db`
    INSERT INTO broadcast_plans (id, session_id, broadcast_type, primary_subjects, dnf_behavior, production_style, pre_race_notes, updated_at)
    VALUES (${plan.id}, ${plan.sessionId}, ${plan.broadcastType}, ${db.json(plan.primarySubjects)},
            ${plan.dnfBehavior}, ${db.json(plan.productionStyle)}, ${plan.preRaceNotes}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      broadcast_type   = EXCLUDED.broadcast_type,
      primary_subjects = EXCLUDED.primary_subjects,
      dnf_behavior     = EXCLUDED.dnf_behavior,
      production_style = EXCLUDED.production_style,
      pre_race_notes   = EXCLUDED.pre_race_notes,
      updated_at       = NOW()
  `;
}

export async function getPlan(id: string): Promise<BroadcastPlan | null> {
  const [row] = await db<BroadcastPlan[]>`
    SELECT id, session_id as "sessionId", broadcast_type as "broadcastType",
           primary_subjects as "primarySubjects", dnf_behavior as "dnfBehavior",
           production_style as "productionStyle", pre_race_notes as "preRaceNotes",
           EXTRACT(EPOCH FROM created_at)::BIGINT * 1000 as "createdAt",
           EXTRACT(EPOCH FROM updated_at)::BIGINT * 1000 as "updatedAt"
    FROM broadcast_plans WHERE id = ${id}
  `;
  return row ?? null;
}

export async function getLatestPlanForSession(sessionId: string): Promise<BroadcastPlan | null> {
  const [row] = await db<BroadcastPlan[]>`
    SELECT id, session_id as "sessionId", broadcast_type as "broadcastType",
           primary_subjects as "primarySubjects", dnf_behavior as "dnfBehavior",
           production_style as "productionStyle", pre_race_notes as "preRaceNotes",
           EXTRACT(EPOCH FROM created_at)::BIGINT * 1000 as "createdAt",
           EXTRACT(EPOCH FROM updated_at)::BIGINT * 1000 as "updatedAt"
    FROM broadcast_plans WHERE session_id = ${sessionId}
    ORDER BY created_at DESC LIMIT 1
  `;
  return row ?? null;
}
