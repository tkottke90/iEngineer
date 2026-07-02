# Contract: Chatterbox TTS API

**Direction**: hub-server → Chatterbox (outbound call)  
**Base URL**: `http://10.0.0.12:8004` (homelab server — configurable via `engineer-config.json`)

---

## Generate Audio Clip

```
POST /tts
Content-Type: application/json
```

**Request body**:

```json
{
  "text": "Fuel critical — two laps remaining",
  "voice_mode": "clone",
  "reference_audio_filename": "voice2.wav",
  "output_format": "mp3",
  "stream": false,
  "split_text": true,
  "chunk_size": 240
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `text` | string | yes | The alert message to synthesize |
| `voice_mode` | `"clone"` | yes | Use a pre-uploaded reference voice (POC-0001: `"predefined"` returns 404) |
| `reference_audio_filename` | string | yes | Filename of pre-uploaded voice WAV — configured in `engineer-config.json` (POC used `voice2.wav`) |
| `output_format` | `"mp3"` | yes | MP3 per POC-0001 server defaults; rodio decodes MP3 via its `mp3` feature flag |
| `stream` | `false` | yes | Return complete file; streaming adds complexity for short alert phrases |
| `split_text` | `true` | yes | Server-recommended default for clone mode |
| `chunk_size` | `240` | yes | Server-recommended default |

**Success response**:

```
HTTP 200 OK
Content-Type: audio/wav
Body: <binary WAV data>
```

**Failure response**:

```
HTTP 4xx / 5xx
```

On any non-200 response, the hub emits an `EngineerFailureLog` and drops the alert.

---

## Failure Handling

```json
{
  "msg": "[engineer] TTS failure",
  "alertType": "hero:fuel_critical",
  "tier": 1,
  "lapNumber": 14,
  "failureReason": "Chatterbox returned 503",
  "timestamp": 1751234567890
}
```

No retry. Drop the alert. Log and continue.
