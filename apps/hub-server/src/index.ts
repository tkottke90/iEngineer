import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { redis, redisSub } from "./redis/client.js";
import { db } from "./db/client.js";

const port = parseInt(process.env.HUB_PORT ?? "3000");

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`hub-server listening on :${port}`);
});

async function shutdown() {
  console.log("shutting down...");
  server.close();
  redis.disconnect();
  redisSub.disconnect();
  await db.end();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
