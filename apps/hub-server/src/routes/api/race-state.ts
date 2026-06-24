import { Hono } from "hono";

// RaceStateManager injected via middleware/context in full implementation
export const raceStateRoutes = new Hono()
  .get("/", (c) => {
    // TODO: return c.json(raceState.getState())
    return c.json({ error: "not implemented" }, 501);
  })
  .get("/fuel", (c) => {
    // TODO: return fuel model from state
    return c.json({ error: "not implemented" }, 501);
  })
  .get("/field", (c) => {
    // TODO: return sorted field array
    return c.json({ error: "not implemented" }, 501);
  });
