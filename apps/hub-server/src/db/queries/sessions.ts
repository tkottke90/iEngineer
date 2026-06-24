import { db } from "../client.js";

interface SessionRow {
  id: string;
  session_id: string;
  track_name: string;
  session_type: string;
  started_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  created_at: Date;
}

export async function createSession(data: {
  sessionId: string;
  trackName: string;
  sessionType: string;
  startedAt?: Date;
}): Promise<SessionRow> {
  const [row] = await db<SessionRow[]>`
    INSERT INTO sessions (session_id, track_name, session_type, started_at)
    VALUES (${data.sessionId}, ${data.trackName}, ${data.sessionType}, ${data.startedAt ?? null})
    RETURNING *
  `;
  return row;
}

export async function updateSession(
  sessionId: string,
  patch: { endedAt?: Date; durationSeconds?: number },
): Promise<void> {
  await db`
    UPDATE sessions
    SET ended_at = COALESCE(${patch.endedAt ?? null}, ended_at),
        duration_seconds = COALESCE(${patch.durationSeconds ?? null}, duration_seconds)
    WHERE session_id = ${sessionId}
  `;
}

export async function getSession(sessionId: string): Promise<SessionRow | null> {
  const [row] = await db<SessionRow[]>`
    SELECT * FROM sessions WHERE session_id = ${sessionId}
  `;
  return row ?? null;
}

export async function listRecentSessions(limit = 20): Promise<SessionRow[]> {
  return db<SessionRow[]>`
    SELECT * FROM sessions ORDER BY created_at DESC LIMIT ${limit}
  `;
}
