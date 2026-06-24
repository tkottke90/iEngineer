import { db } from "../client.js";
import type { RaceEvent, EventType } from "@iracing-engineer/types";

export async function logEvent(event: RaceEvent, sessionId: string): Promise<void> {
  await db`
    INSERT INTO event_log (session_id, event_type, session_time, lap_number, payload)
    VALUES (${sessionId}, ${event.type}, ${event.sessionTime}, ${event.lapNumber}, ${db.json(event.payload)})
  `;
}

export async function getEvents(sessionId: string, types?: EventType[]): Promise<RaceEvent[]> {
  const rows = await db<{ event_type: string; session_time: number; lap_number: number; payload: Record<string, unknown> }[]>`
    SELECT event_type, session_time, lap_number, payload
    FROM event_log
    WHERE session_id = ${sessionId}
    ${types ? db`AND event_type = ANY(${types})` : db``}
    ORDER BY session_time ASC
  `;
  return rows.map((r) => ({
    type: r.event_type as EventType,
    sessionId,
    sessionTime: r.session_time,
    lapNumber: r.lap_number,
    lapDistPct: 0,
    payload: r.payload,
  }));
}
