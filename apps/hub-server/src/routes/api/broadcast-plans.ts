import { Hono } from "hono";
import { savePlan, getPlan, getLatestPlanForSession } from "../../db/queries/broadcast-plans.js";
import type { BroadcastPlan } from "@iracing-engineer/types";

export const broadcastPlanRoutes = new Hono()
  .get("/:id", async (c) => {
    const plan = await getPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "not found" }, 404);
    return c.json(plan);
  })
  .get("/session/:sessionId", async (c) => {
    const plan = await getLatestPlanForSession(c.req.param("sessionId"));
    if (!plan) return c.json({ error: "not found" }, 404);
    return c.json(plan);
  })
  .post("/", async (c) => {
    const body = await c.req.json<BroadcastPlan>();
    await savePlan(body);
    return c.json({ ok: true });
  });
