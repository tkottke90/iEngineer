import { Hono } from "hono";

export const configRoutes = new Hono()
  .get("/", (c) => {
    return c.json({
      llmMode: process.env.LLM_MODE ?? "frontier",
      llmModel: process.env.LLM_MODEL ?? "claude-sonnet-4-6",
      obsConnected: false, // TODO: read from OBSClient singleton
      redisConnected: true, // TODO: ping check
    });
  })
  .post("/personality", async (c) => {
    const body = await c.req.json();
    // TODO: update runtime PersonalityConfig, persist to SQLite or env
    return c.json({ ok: true });
  })
  .post("/blackout-zones", async (c) => {
    const body = await c.req.json();
    // TODO: update SafeWindowMonitor + CutWindowMonitor zones
    return c.json({ ok: true });
  });
