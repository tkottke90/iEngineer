import { Hono } from "hono";
import { listRecentSessions, getSession } from "../../db/queries/sessions.js";
import { getEvents } from "../../db/queries/events.js";
import { getDecisions } from "../../db/queries/decisions.js";

export const sessionRoutes = new Hono()
  .get("/", async (c) => {
    const sessions = await listRecentSessions(20);
    return c.json(sessions);
  })
  .get("/:id", async (c) => {
    const session = await getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    const [events, decisions] = await Promise.all([
      getEvents(session.session_id),
      getDecisions(session.session_id),
    ]);
    return c.json({ session, events, decisions });
  });
