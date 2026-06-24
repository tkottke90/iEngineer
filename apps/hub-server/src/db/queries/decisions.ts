import { db } from "../client.js";

export async function logDecision(data: {
  sessionId: string;
  decisionType: string;
  messageText: string;
  tier: 0 | 1 | 2;
  lapNumber: number;
  sessionTime: number;
}): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO engineer_decisions
      (session_id, decision_type, message_text, tier, lap_number, session_time)
    VALUES
      (${data.sessionId}, ${data.decisionType}, ${data.messageText}, ${data.tier},
       ${data.lapNumber}, ${data.sessionTime})
    RETURNING id
  `;
  return row.id;
}

export async function recordDriverResponse(
  decisionId: string,
  response: string,
  outcome: string,
): Promise<void> {
  await db`
    UPDATE engineer_decisions
    SET driver_responded = TRUE, driver_response = ${response}, outcome = ${outcome}
    WHERE id = ${decisionId}
  `;
}

export async function getDecisions(sessionId: string): Promise<unknown[]> {
  return db`
    SELECT * FROM engineer_decisions WHERE session_id = ${sessionId} ORDER BY session_time ASC
  `;
}
