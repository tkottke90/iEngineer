# Contract: POST /api/voice-profile — Voice Profile Upload

**Purpose**: Define the hub server endpoint that receives an MP3 voice profile from the Tauri client, validates it, writes it to the Chatterbox reference audio directory, and returns a test clip URL.

---

## Endpoint

```
POST /api/voice-profile
Content-Type: multipart/form-data
```

**Body fields**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `audio` | file | Yes | MP3 file (≤ 10 MB, 3–60 seconds duration) |

---

## Processing Flow

1. **Receive**: Read multipart field `audio`.
2. **Format check**: Verify MIME type is `audio/mpeg` (or detect by magic bytes). If wrong format → 422.
3. **Duration check**: Use `music-metadata` to extract duration. If < 3s or > 60s → 422 with specific message.
4. **Write**: Save file to `{chatterboxReferenceAudioDir}/{filename}` where:
   - `chatterboxReferenceAudioDir` is configured in `engineer-config.json` (new field, default: `/data/chatterbox/reference`).
   - `filename` = `profile-{YYYYMMDD-HHmmss}.mp3`
5. **Config update**: Set `chatterboxVoiceFile = filename` in the hub's runtime TTS config (in-memory; write to `hub:config:voice-profile` Redis KV for persistence across restarts).
6. **Test clip**: Synthesize a short test phrase ("Racing engineer online. Voice profile active.") using the new reference file. Store via `AudioStore`. Return the clip URL.
7. **Respond**: 200 with JSON body.

---

## Response

**200 OK**:
```json
{
  "filename": "profile-2026-07-07T143022.mp3",
  "uploadedAt": "2026-07-07T14:30:22.000Z",
  "durationSeconds": 18.4,
  "testClipUrl": "/api/audio/abc123"
}
```

**422 Unprocessable Entity** (validation failure):
```json
{
  "error": "invalid-format",
  "message": "File must be an MP3 (audio/mpeg)"
}
```
```json
{
  "error": "duration-out-of-range",
  "message": "Audio must be between 3 and 60 seconds (got 1.2s)"
}
```

**500 Internal Server Error** (write or TTS failure):
```json
{
  "error": "write-failed",
  "message": "Could not write reference audio file: [reason]"
}
```

---

## Redis Persistence

After successful upload, hub writes:
```
hub:config:voice-profile = { "filename": "profile-...", "uploadedAt": "..." }
```

On hub restart, if `hub:config:voice-profile` exists and the file exists on disk, the hub resumes using that profile. If the file is missing (e.g., volume not mounted), hub falls back to `engineer-config.json`'s `chatterboxVoiceFile` and emits a warn log.

---

## Infrastructure Requirement

`chatterboxReferenceAudioDir` must be a directory that:
1. Is writable by the hub server process.
2. Is the same directory mounted into the Chatterbox container as its reference audio source.

In `infra/docker-compose.yml`, this is the volume shared between `hub-server` and `chatterbox` services. If not already a shared volume, one must be added. **This must be wired in `infra/` before the hub endpoint code references it (Constitution IV).**

---

## music-metadata Dependency

New hub dependency: `music-metadata` (npm, ESM-compatible). Already in common use for audio metadata extraction. Add to `apps/hub-server/package.json` before implementing the endpoint.
