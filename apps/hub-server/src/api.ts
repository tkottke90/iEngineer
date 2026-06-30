import { Hono } from 'hono';
import { getSnapshot } from './state/race-state.js';
import { createCommandConnection } from './redis/client.js';

// Your custom HTTP routes and Hono middleware go here. The framework
// mounts this app ahead of its reserved /__loaders path
// and the SSR catch-all. See https://framework.sbesh.com/docs/hono-middleware
const app = new Hono();

app.get('/healthz', (c) => c.text('ok'));

app.get('/api/race-state', async (c) => {
  const conn = createCommandConnection();
  const raw = await conn.get('hub:race-state:latest');
  if (!raw) return c.json(getSnapshot()); // fallback to in-memory if no KV yet
  return c.json(JSON.parse(raw));
});

app.get('/api/fuel-model', async (c) => {
  const state = getSnapshot();
  const sessionId = state.session?.sessionId;
  if (!sessionId) return c.json(null, 404);
  const conn = createCommandConnection();
  const raw = await conn.get(`hub:fuel-model:${sessionId}`);
  if (!raw) return c.json(null, 404);
  return c.json(JSON.parse(raw));
});

app.get('/api/tire-model', async (c) => {
  const state = getSnapshot();
  const sessionId = state.session?.sessionId;
  if (!sessionId) return c.json(null, 404);
  const conn = createCommandConnection();
  const raw = await conn.get(`hub:tire-model:${sessionId}`);
  if (!raw) return c.json(null, 404);
  return c.json(JSON.parse(raw));
});

app.get('/api/events/recent', async (c) => {
  const state = getSnapshot();
  const sessionId = state.session?.sessionId;
  if (!sessionId) return c.json([]);
  const conn = createCommandConnection();
  const entries = await conn.lrange(`hub:events:ring:${sessionId}`, 0, 19);
  return c.json(entries.map((e: string) => JSON.parse(e)));
});

export default app;
