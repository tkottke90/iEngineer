import { Hono } from "hono";
import { apiRoutes } from "./routes/api/index.js";
import { wsRoutes } from "./routes/ws/index.js";

export const app = new Hono();

// Stub auth middleware — replace with Authentik OAuth2/OIDC
app.use("/ui/*", async (c, next) => {
  // TODO: validate session cookie via Authentik
  await next();
});

app.route("/api", apiRoutes);
app.route("/ws", wsRoutes);

// Overlay endpoints (no auth — OBS browser source)
app.get("/overlay/telemetry", (c) => c.html("<html><body><!-- telemetry overlay --></body></html>"));
app.get("/overlay/ticker", (c) => c.html("<html><body><!-- ticker overlay --></body></html>"));

// Audio clip delivery
app.get("/audio/:clipId", async (c) => {
  // TODO: look up clip from TTSCache and stream MP3
  return c.notFound();
});

export type AppType = typeof app;
