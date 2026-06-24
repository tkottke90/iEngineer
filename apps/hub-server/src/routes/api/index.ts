import { Hono } from "hono";
import { raceStateRoutes } from "./race-state.js";
import { sessionRoutes } from "./sessions.js";
import { broadcastPlanRoutes } from "./broadcast-plans.js";
import { configRoutes } from "./config.js";

export const apiRoutes = new Hono()
  .route("/race-state", raceStateRoutes)
  .route("/sessions", sessionRoutes)
  .route("/broadcast-plans", broadcastPlanRoutes)
  .route("/config", configRoutes);
