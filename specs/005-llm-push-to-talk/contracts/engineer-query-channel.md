# Contract: `engineer:query` Channel + STT (Tauri → hub)

## STT (Tauri client, in-process)
- Engine: `whisper-rs` 0.14, model `ggml-base.en.bin`, feature `metal` (macOS) / `vulkan` (Windows AMD).
- Input: PTT-gated mono f32 PCM buffer from `AudioCapture` (accumulated while PTT held).
- Output: transcript `String`.
- **Empty/non-speech guard**: if transcript is empty, whitespace-only, or below a minimal token/char threshold ⇒ **do not publish**; emit structured log `{ reason: "empty-transcription", queryId, capturedAtMs }`. (FR-004)
- **STT failure**: init/transcription error ⇒ drop; log `{ reason: "stt-failure", detail }`; no publish. Rule path unaffected. (FR-005)

## Channel: `engineer:query` (Redis pub/sub)
- **Publisher**: Tauri client, on PTT release after a successful non-empty transcription.
- **Subscriber**: hub `RacingEngineerService`.
- **Payload** (`EngineerQuery`, JSON):
```json
{ "queryId": "uuid", "transcript": "Do we pit this lap?", "sessionId": "…", "capturedAtMs": 1751000000000 }
```
- **Delivery**: fire-and-forget pub/sub (no ack), symmetric with `voice:audio`.

## Concurrency (hub side)
- Single in-flight query. Additional `EngineerQuery` messages queue FIFO up to `queueDepthCap`.
- Overflow ⇒ drop oldest-excess with log `{ reason: "queue-cap-drop", queryId }`. (Q4 / FR edge case)

## LLM-outage behavior
- If LLM unreachable when a driver-query is dequeued ⇒ synthesize a **canned** TTS line ("Reasoning engine unavailable") via `TtsClient` (no LLM), publish as a single `AudioClipRef`, and write an `EngineerEvent` with `outcome: "skipped-llm-unreachable"`. (Q5 / FR-023)
