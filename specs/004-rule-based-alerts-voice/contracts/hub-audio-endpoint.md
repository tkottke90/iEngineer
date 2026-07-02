# Contract: Hub Audio Endpoint

**Direction**: Tauri client → hub-server (inbound request)  
**Base URL**: the Tauri client's configured `hub_url` (`AppConfig.hub_url`) — the `clipUrl` in the pub/sub message is a relative path that the subscriber resolves against this base. Routes are registered in the hub Hono app `src/api.ts` (alongside `/api/race-state`, `/api/fuel-model`), NOT the hono-preact `routes.ts` page table.

---

## Fetch Audio Clip

```
GET /api/audio/:audioId
```

| Param | Type | Notes |
|-------|------|-------|
| `audioId` | UUID string | Received from `voice:audio` pub/sub message |

**Success response**:

```
HTTP 200 OK
Content-Type: audio/mpeg
Body: <binary MP3 data>
```

Clip is NOT deleted on fetch (no GETDEL) — it remains retrievable so the client can re-fetch after a brief disconnect and deep queues still resolve. Eviction is TTL-only: removed once `Date.now() - storedAt > 60_000` (`AUDIO_CLIP_TTL_MS`).

**Not found (clip expired or already cleaned)**:

```
HTTP 404 Not Found
```

On 404 or any error, Tauri logs and silently skips the clip. No retry.

---

## Pub/Sub Message: `voice:audio`

**Channel**: `voice:audio` (Redis pub/sub)  
**Publisher**: hub-server `RacingEngineerService`  
**Subscriber**: Tauri `engineer::subscriber`

**Message schema** (`AudioClipRef`):

```json
{
  "audioId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "clipUrl": "/api/audio/f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "tier": 1,
  "eventType": "hero:fuel_critical",
  "generatedAt": 1751234567890
}
```

| Field | Type | Notes |
|-------|------|-------|
| `audioId` | string (UUID) | Unique clip identifier |
| `clipUrl` | string (relative path) | `/api/audio/:audioId` — subscriber prepends `hub_url` before calling `play_url()` |
| `tier` | `1 \| 2` | Alert tier (for future Tauri-side filtering if needed) |
| `eventType` | `AlertEventType` | Which alert triggered this clip |
| `generatedAt` | number (epoch ms) | For stale-clip detection (skip if > 60s old) |

**Tauri handling**:

1. Receive message on `voice:audio`
2. Parse `AudioClipRef`
3. If `Date.now() - generatedAt > 60000` → log and discard (clip likely expired)
4. Resolve the relative `clipUrl` against the configured `hub_url` → absolute URL
5. Enqueue the absolute URL in `playback_queue`
6. Queue dispatcher calls `AudioPlayback::play_url(url)` sequentially (no interruption)
