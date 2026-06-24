import { Hono } from "hono";

export const wsRoutes = new Hono()
  .get("/telemetry", (c) => {
    // TODO: upgrade to WebSocket and push RaceState at ~2 Hz
    return c.text("WebSocket endpoint — use ws://");
  })
  .get("/race-control", (c) => {
    // TODO: upgrade to WebSocket, receive LiveOperatorSignal, forward to StreamEngineerAgent
    return c.text("WebSocket endpoint — use ws://");
  });
