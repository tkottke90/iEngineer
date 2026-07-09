import { Hono } from 'hono';
import { writeFile, unlink } from 'node:fs/promises';
import { parseBuffer } from 'music-metadata';
import { getSnapshot } from './state/race-state.js';
import { createCommandConnection } from './redis/client.js';
import { getAudioStore } from './engineer/audio-store.js';
import { generateClip } from './engineer/tts-client.js';
import { loadEngineerConfig } from './engineer/personality-config.js';
import { handleVoiceProfileUpload } from './engineer/voice-profile.js';

// Your custom HTTP routes and Hono middleware go here. The framework
// mounts this app ahead of its reserved /__loaders path
// and the SSR catch-all. See https://framework.sbesh.com/docs/hono-middleware
const app = new Hono();

app.get('/healthz', (c) => c.text('ok'));

// Serve a generated TTS clip by id. The AudioStore is an in-process singleton
// owned by RacingEngineerService (set during server-init).
app.get('/api/audio/:audioId', (c) => {
  const store = getAudioStore();
  const buffer = store?.get(c.req.param('audioId')) ?? null;
  if (!buffer) return c.body(null, 404);
  return c.body(buffer as unknown as ArrayBuffer, 200, { 'Content-Type': 'audio/mpeg' });
});

// Test-only shortcut for the audio device test panel (T039). Synthesizes a
// fixed phrase and stores it; does NOT use the voice:audio pub/sub channel.
app.post('/api/audio/test', async (c) => {
  const store = getAudioStore();
  if (!store) return c.json({ error: 'engineer not initialized' }, 503);
  try {
    const config = loadEngineerConfig();
    const buffer = await generateClip('Racing engineer online. Audio check.', config);
    const { clipUrl } = store.store(buffer);
    return c.json({ clipUrl });
  } catch (err) {
    return c.json({ error: String(err) }, 502);
  }
});

// M10 US6 (T034, FR-021/FR-022): voice profile upload. Validation + writes in
// handleVoiceProfileUpload (contracts/hub-voice-profile.md); hub budget ≤50s
// (C4b — SC-006's 60s is user-side).
app.post('/api/voice-profile', async (c) => {
  const store = getAudioStore();
  if (!store) return c.json({ error: 'engineer not initialized' }, 503);
  const body = await c.req.parseBody();
  const file = body['audio'];
  if (!(file instanceof File)) {
    return c.json({ error: 'invalid-format', message: 'multipart field "audio" is required' }, 422);
  }
  const config = loadEngineerConfig();
  const data = Buffer.from(await file.arrayBuffer());
  const conn = createCommandConnection();
  const outcome = await handleVoiceProfileUpload(
    {
      config,
      parseDurationSecs: async (buf) => {
        const meta = await parseBuffer(new Uint8Array(buf), { mimeType: 'audio/mpeg' });
        const duration = meta.format.duration;
        if (duration === undefined) throw new Error('duration not present in MP3 metadata');
        return duration;
      },
      writeFile: (path, buf) => writeFile(path, buf),
      unlink: (path) => unlink(path),
      redisSet: async (key, value) => {
        await conn.set(key, value);
      },
      // The in-memory voice file was already switched — this clip confirms it.
      synthesizeTestClip: () =>
        generateClip('Racing engineer online. Voice profile active.', config),
      storeClip: (buffer) => store.store(buffer),
      now: () => new Date(),
    },
    file.type,
    data,
  );
  return c.json(outcome.body, outcome.status as 200);
});

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
