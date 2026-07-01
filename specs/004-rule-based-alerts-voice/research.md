# Research: Rule-Based Alerts + Voice

**Feature**: 004-rule-based-alerts-voice  
**Date**: 2026-06-30

---

## Decision 1: Audio Delivery Architecture

**Decision**: Hub stores generated audio clips in a short-lived in-process `Map<audioId, Buffer>` (or temp disk file), exposes `GET /api/audio/:audioId` on the Hono server, and publishes the URL to the Tauri client over Redis pub/sub channel `voice:audio`.

**Rationale**: The Tauri `AudioPlayback::play_url(url)` method already exists and uses `reqwest` — passing an HTTP URL is zero additional Rust code. Redis pub/sub is already wired in Rust (`PubSubListener`). Storing audio bytes in Redis requires binary serialization on both ends and introduces a TTL race condition (pub/sub notification arrives before Redis SETEX commits, or key expires before GET). HTTP delivery sidesteps both issues cleanly.

**Alternatives considered**:
- Redis binary storage (SETEX + GET): Race-condition prone, binary serialization friction, Redis not intended for binary blobs in this codebase.
- WebSocket/SSE streaming: No existing WebSocket on hub; adds more infrastructure than the problem warrants.
- In-memory Map only (no disk): Acceptable for M4; audio clips are <300KB, session lifetime is bounded. If memory becomes a concern, swap to disk without changing the HTTP interface.

---

## Decision 2: Chatterbox TTS API Contract

**Decision**: Call `POST /tts` on the Chatterbox server with `{ text, voice_mode: "clone", reference_audio_filename: "voice2.wav", output_format: "mp3", stream: false, split_text: true, chunk_size: 240 }`. Receive a complete MP3 binary response.

**Rationale**: POC-0001 confirmed `voice_mode: "predefined"` returns 404 — clone mode with a pre-uploaded reference voice file is the correct API. MP3 is the server-recommended output format; rodio supports it via the `mp3` feature flag in `Cargo.toml`. Non-streaming is simpler for short alert phrases (~3–8 words). No authentication required for self-hosted instance. POC-0001 measured TTS first-byte latency at ~1.58 seconds — within the 3-second SLA when combined with ~0.1s hub processing + ~0.1s pub/sub + fetch.

**Alternatives considered**:
- `stream: true`: Useful for long narration; adds chunked-transfer complexity for 5-word alerts.
- `/v1/audio/speech` (OpenAI-compatible): Not correctly implemented on this server version (POC finding).
- WAV output: Not the server default in clone mode; MP3 file size is smaller for network transfer.

**Cargo.toml note**: Ensure `rodio` is enabled with the `mp3` feature (`rodio = { features = ["mp3"] }`) in `apps/tauri-client/src-tauri/Cargo.toml`.

**Latency estimate**: 0.5–2 seconds on GPU, 2–6 seconds on CPU-only. This is within the 3-second end-to-end SLA on GPU-equipped machines. The constitution (Principle I) requires voice feedback within 3 seconds — GPU deployment is assumed for M4.

---

## Decision 3: Priority Queue Implementation

**Decision**: Implement an in-process async queue in Node.js (hub-server) using a simple array with two segments: Tier 1 head and Tier 2 tail. The queue dispatcher serializes clip generation and publish — no clip is dispatched until the previous pub/sub notification has been sent.

**Rationale**: No clip ever interrupts another (clarified in spec). Serializing at the hub (before TTS call) is simpler than serializing in Rust after playback. The Tauri side just plays clips sequentially as they arrive. Hub queue is in-process (no Redis queue needed) since Racing Engineer is single-instance.

**Alternatives considered**:
- Redis List as queue: Adds Redis dependency for in-process logic; unnecessary.
- Rust-side playback queue: Would require shared state between the pub/sub listener and the audio playback task; more complex than hub-side serialization.

---

## Decision 4: Deduplication Storage

**Decision**: Use an in-process `Map<string, { lapNumber: number; cleared: boolean }>` in the hub `RacingEngineerService`. Key is `alertType`. On each alert evaluation, skip if `currentLap === lastFiredLap && !cleared`. On condition clear (flag drops, fuel refueled, pit exit), mark `cleared = true`. On next trigger, fire and reset.

**Rationale**: Dedup state is ephemeral (session-scoped) and small. Redis persistence not needed. The simple Map survives for the session lifetime and resets on process restart (which resets the race session anyway).

**Pit window special case**: Dedup for `hero:pit_window_open` resets on `hero:pit_exit` event (clarified in spec).

---

## Decision 5: Radio Blackout Zone Config Format

**Decision**: Static JSON file at `apps/hub-server/config/radio-blackout-zones.json`. Schema: `{ zones: Array<{ label: string, lapDistPctStart: number, lapDistPctEnd: number }> }`. Loaded at hub startup; no hot-reload needed for M4.

**Rationale**: Simple, version-controlled, no UI needed in M4. `lapDistPct` (0.0–1.0) is the natural coordinate in iRacing telemetry. Zones can overlap. If the hero's current `lapDistPct` falls within any zone, the safe window is considered closed for Tier 2 gating.

---

## Decision 6: Personality Config Storage

**Decision**: Store `chattiness` ("Low" | "Default") in the existing `AppConfig` struct in Tauri (`state.rs`), serialized via `ts-rs` to TypeScript bindings. The hub reads the driver's personality preference from a new field in the session/connection handshake.

**Rationale**: `AppConfig` is already the source of truth for driver preferences (audio device, PTT key, Redis URL). Adding `chattiness` here is consistent. The hub receives it via the existing connection/config channel.

**Alternatives considered**:
- Hub-side config file: Splits personality across two places; harder to surface in Tauri settings UI.

---

## Decision 7: Failure Log Structure

**Decision**: Emit structured JSON log lines for all TTS failures with fields: `msg`, `alertType`, `tier`, `lapNumber`, `failureReason`, `timestamp`. Use the existing `console.log(JSON.stringify({...}))` pattern already established across `hub-server`.

**Rationale**: Consistent with the hub's existing logging pattern (observed in `event-bus.ts`, `server-init.ts`). Structured JSON enables grep/jq filtering for post-session forensics. No additional logging infrastructure needed.
