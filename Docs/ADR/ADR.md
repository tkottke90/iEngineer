# Architecture Decision Records

This document consolidates all significant architectural decisions made for the iRacing Engineer project. Each entry captures the context that drove the decision, the decision itself, its current status, and the consequences accepted by making it.

---

## Index

1. [Monorepo Structure — npm Workspaces](#1-monorepo-structure--npm-workspaces)
2. [Client Runtime — Tauri 2 (Rust + Preact)](#2-client-runtime--tauri-2-rust--preact)
3. [Hub Server Framework — hono-preact](#3-hub-server-framework--hono-preact)
4. [Cross-Language Type Safety — ts-rs and tauri-specta](#4-cross-language-type-safety--ts-rs-and-tauri-specta)
5. [Shared Data Bus — Redis](#5-shared-data-bus--redis)
6. [Server-Side Persistence — PostgreSQL](#6-server-side-persistence--postgresql)
7. [Local Client Persistence — SQLite](#7-local-client-persistence--sqlite)
8. [Speech-to-Text — Self-Hosted Whisper via Speaches](#8-speech-to-text--self-hosted-whisper-via-speaches)
9. [Text-to-Speech — Self-Hosted Chatterbox via chatterbox-tts-api](#9-text-to-speech--self-hosted-chatterbox-via-chatterbox-tts-api)
10. [Voice Activation — Push-to-Talk](#10-voice-activation--push-to-talk)
11. [Audio I/O — Rust via cpal and rodio](#11-audio-io--rust-via-cpal-and-rodio)
12. [LLM Inference — Switchable Local/Frontier via OpenAI-Compatible API](#12-llm-inference--switchable-localfrontier-via-openai-compatible-api)
13. [iRacing Telemetry — Custom Rust SDK Integration](#13-iracing-telemetry--custom-rust-sdk-integration)
14. [Telemetry Pipeline — Two-Speed Processing](#14-telemetry-pipeline--two-speed-processing)
15. [Multi-Client Team Sync — Redis with Driver Priority](#15-multi-client-team-sync--redis-with-driver-priority)
16. [Overlay Architecture — Hub-Served HTTP, OBS Browser Sources Pull](#16-overlay-architecture--hub-served-http-obs-browser-sources-pull)
17. [Video Feed in Race Control Center — HLS, Not OBS WebSocket](#17-video-feed-in-race-control-center--hls-not-obs-websocket)
18. [OBS Browser Source Latency — Accepted, Sync with Stream Delay](#18-obs-browser-source-latency--accepted-sync-with-stream-delay)
19. [Discord Integration — Webhooks, Not a Bot](#19-discord-integration--webhooks-not-a-bot)
20. [Stream Deck Integration — Global Hotkeys for v1, No Plugin](#20-stream-deck-integration--global-hotkeys-for-v1-no-plugin)
21. [iRacing Camera Control — Accepted Instability Risk](#21-iracing-camera-control--accepted-instability-risk)
22. [Authentication — Authentik via OAuth2/OIDC](#22-authentication--authentik-via-oauth2oidc)
23. [Observability — OpenTelemetry with Grafana Stack](#23-observability--opentelemetry-with-grafana-stack)
24. [Fuel Strategy Math — Deterministic Code, Not LLM Reasoning](#24-fuel-strategy-math--deterministic-code-not-llm-reasoning)

---

## 1. Monorepo Structure — npm Workspaces

**Status:** Accepted

**Context:**
The project has four distinct runtime artifacts (Tauri client, hub server, shared UI library, shared types package) that share code and must be developed and versioned together. A polyrepo approach would create friction around shared type consumption and coordinated changes.

**Decision:**
Use a single monorepo managed with npm Workspaces. No additional build orchestration layer (Turborepo, Nx) at this time. Four top-level packages: `apps/tauri-client`, `apps/hub-server`, `packages/ui`, `packages/types`.

**Consequences:**
- Single repository for all first-party code; coordinated changes across packages are a single commit
- npm Workspaces handles inter-package linking without additional tooling
- `packages/types` is the single source of truth for shared TypeScript types, consumed by hub server and web UI
- Build orchestration may need to be revisited if inter-package dependency graph becomes complex; accepted as a future maintenance task

---

## 2. Client Runtime — Tauri 2 (Rust + Preact)

**Status:** Accepted

**Context:**
The racing PC client needs to read from iRacing shared memory (a low-level OS operation), capture and resample audio, listen for global hotkeys, and send iRacing camera control commands via SDK broadcast messages. A web or Electron-based approach would require native Node addons or workarounds for each of these. The client UI surface is minimal — settings and a diagnostics view — so framework overhead is not justified.

**Decision:**
Use Tauri 2 with a Rust backend and a Preact-based webview for the minimal client UI. All system-level operations (memory-mapped file reading, audio I/O, hotkey listening, camera control) are implemented in Rust. The webview handles only settings screens and debug output.

**Consequences:**
- Rust is the implementation language for all performance-critical and OS-adjacent logic on the racing PC
- The client is intentionally lightweight to avoid competing with iRacing and OBS for CPU and GPU resources
- Preact is shared with the web UI via `packages/ui`, enabling a shared component library
- Tauri 2 is the stable release of Tauri; its API surface is stable and documented
- Team members contributing to the Tauri client must be comfortable with Rust

---

## 3. Hub Server Framework — hono-preact

**Status:** Accepted (with noted risk)

**Context:**
The hub server needs to serve a full-stack web UI (SSR with hydration, streaming loaders), expose webhook and API routes, support WebSocket connections, and be deployable as a Docker container. A bare Node.js/Express setup would require assembling these capabilities manually. Next.js was considered but its deployment model and server architecture impose more constraint than is needed here.

**Decision:**
Use [hono-preact](https://github.com/sbesh91/hono-preact) — a lightweight pairing of Hono (server) with Preact (browser). It provides SSR with client-side hydration, typed server loaders and actions, streaming, and WebSocket support. Deployed via `nodeAdapter` as a Docker container.

**Consequences:**
- Hono's existing route system (`src/api.ts`) composes cleanly alongside the UI routes
- WebSocket infrastructure from hono-preact aligns with the OBS WebSocket integration pattern already used elsewhere
- Preact is used on both the Tauri client webview and the hub server UI, enabling shared components in `packages/ui`
- **Risk accepted:** hono-preact is pre-1.0 (v0.6.0 at time of decision). Breaking changes between minor versions are possible. The framework author is aware this project is using it and is available for direct feedback. Breaking changes are treated as maintenance tasks, not blockers.

---

## 4. Cross-Language Type Safety — ts-rs and tauri-specta

**Status:** Accepted

**Context:**
The system has two type boundaries where Rust and TypeScript must agree on message shapes: the Redis message boundary (telemetry ticks, race state events published by Tauri and consumed by the hub server) and the Tauri IPC boundary (commands exposed to the Tauri webview). Manual maintenance of these contracts across a language boundary is error-prone and does not scale.

**Decision:**
Use two code generation tools that operate on separate boundaries without conflict:

- **ts-rs** for the Redis message boundary: Rust structs annotated with `#[derive(TS)]` export `.ts` declaration files into `packages/types` on `cargo test`. Rust is the source of truth; TypeScript consumes the export.
- **tauri-specta** for the Tauri IPC boundary: `#[command]` functions exposed to the Preact webview get typed wrappers generated at build time.

**Consequences:**
- Type contracts across the Rust/TypeScript boundary are enforced by codegen, not convention
- `packages/types` contains generated types from Rust; the hub server and web UI treat these as authoritative
- Running `cargo test` in `apps/tauri-client` is required to regenerate types after Rust struct changes — this step must be part of the development workflow
- Both tools coexist without conflict and are the standard pattern in the Tauri v2 community

---

## 5. Shared Data Bus — Redis

**Status:** Accepted

**Context:**
The Tauri client on the racing PC and the hub server on the homelab server are separate processes on separate machines. They need a reliable, low-latency channel for high-frequency telemetry data (60 Hz), event notifications (pub/sub), and shared state snapshots. Direct HTTP polling from hub to Tauri was rejected due to the reversed connection direction (hub cannot initiate to a racing PC behind NAT). A message queue (RabbitMQ, Kafka) was considered but is operationally heavier than warranted for a single-producer, single-consumer data stream.

**Decision:**
Use Redis as the shared data bus, running as a Docker container on the homelab server. Three Redis primitives are used for distinct purposes:
- **Redis Streams** (`telemetry:live`, `telemetry:session`) for high-frequency telemetry ingestion
- **Pub/Sub** for event broadcasting (camera commands, voice triggers, flag changes, audio URLs)
- **Key/Value** for current race state snapshot and configuration

Redis is used even in solo (single-driver) sessions to maintain a single consistent architecture rather than a conditional solo-vs-team code path.

**Consequences:**
- Redis is a required network dependency for all features; the Tauri client must be able to reach the homelab Redis instance
- Resilience: Tauri handles Redis unavailability gracefully — if the homelab goes down mid-race, the session continues normally and the engineering layer goes quiet without crashing
- Stream trimming (`MAXLEN ~600`) prevents unbounded growth; 600 entries at 60 Hz = ~10 seconds of history
- In team sessions, multiple Tauri clients publish to the same Redis instance; the hub server merges their data
- Access control is handled at the network level (firewall, Redis `AUTH` password, or VPN); no app-level account system is needed for v1

---

## 6. Server-Side Persistence — PostgreSQL

**Status:** Accepted

**Context:**
The hub server needs durable storage for data that must survive server restarts and be available across sessions: broadcast plans, team configuration, post-session summaries, engineer decision history, and stint fuel/tire calibration data used as priors for future sessions.

**Decision:**
Use PostgreSQL, running as a Docker container co-located with the hub server in the same Docker Compose stack on the homelab server.

**Consequences:**
- PostgreSQL is the system of record for all data that must persist across sessions
- Raw 60 Hz telemetry ticks are explicitly not written to Postgres — too large and not needed for any current use case
- The post-session record is written on `session:flag_checkered` or graceful hub shutdown; on unclean shutdown, the session record is reconstructed from the Redis ring buffer before keys expire
- Co-location with the hub server and Redis simplifies networking and eliminates cross-host database connections

---

## 7. Local Client Persistence — SQLite

**Status:** Accepted

**Context:**
The Tauri client on the racing PC needs to persist local configuration: audio device selection, connection settings (Redis URL, Whisper endpoint, hub server URL), hotkey bindings, and telemetry logging opt-in. This data is small, structured, local to a single machine, and has no network dependency requirement.

**Decision:**
Use SQLite via Tauri's built-in SQLite plugin for all local configuration storage on the racing PC.

**Consequences:**
- No server or network dependency for local configuration
- Configuration is persistent across app restarts without Redis being available
- SQLite is appropriate for the data volume and access pattern (single process, small structured data); no migration to a networked database is anticipated

---

## 8. Speech-to-Text — Self-Hosted Whisper via Speaches

**Status:** Accepted

**Context:**
Voice input (driver queries and commands) must be transcribed with low latency during a live race session. Cloud STT services (Google, AWS, Azure, OpenAI Whisper API) introduce network round-trips to external endpoints and a dependency on internet availability during a race. Running Whisper on the racing PC itself would load an ML model and compete for CPU with iRacing and OBS.

**Decision:**
Run Whisper via [Speaches](https://github.com/speaches-ai/speaches) as a Docker container on the homelab server, co-located with the hub server. The Tauri client sends buffered audio via HTTP POST to the Speaches `/v1/audio/transcriptions` endpoint on PTT key-release. Starting model: `base.en` (74M parameters, ~200ms inference time on CPU for a 3-second clip). An `initial_prompt` covering racing vocabulary (fuel level, pit window, gap, tire compound) improves domain-specific recognition. Upgrade to `small.en` only if recognition failures are observed.

**Consequences:**
- No cloud dependency or internet requirement for voice input
- ML inference load is offloaded from the racing PC to the homelab server
- LAN audio transfer adds ~1–10ms — negligible against ~200ms inference time
- The Tauri client resamples audio to 16kHz mono 16-bit PCM in Rust (via `rubato`) before sending — Speaches receives Whisper's native format with no server-side resampling
- A 3-second clip at 16kHz mono 16-bit PCM is ~100KB; upload over LAN completes in under 10ms
- Speaches must be running before voice input is available; service availability is a homelab operational concern

---

## 9. Text-to-Speech — Self-Hosted Chatterbox via chatterbox-tts-api

**Status:** Accepted

**Context:**
The Racing Engineer's voice output must sound natural and expressive — a robotic or flat TTS voice degrades the "trusted co-pilot" character intended by the behavior spec. Piper TTS and Coqui TTS were evaluated; both produce acceptable quality but lack the paralinguistic expression and voice cloning capabilities that Chatterbox provides. Cloud TTS introduces network dependency and latency that the audio pipeline cannot absorb.

**Decision:**
Use [travisvn/chatterbox-tts-api](https://github.com/travisvn/chatterbox-tts-api) — a FastAPI wrapper exposing an OpenAI-compatible `/v1/audio/speech` endpoint with named voice profile management. Runs as a Docker container on the homelab server alongside the hub server. Two model variants are supported per use case:

- **Turbo** (350M parameters, 1-step decoder): default for all real-time voice output. Supports 9 paralinguistic expression tags (`[cough]`, `[sigh]`, `[chuckle]`, etc.) that the LLM can embed in generated text.
- **Original** (500M parameters, 10-step decoder): available for non-real-time contexts (post-session narration, audio file generation) where `exaggeration` and `cfg_weight` controls are useful.

Voice cloning: users supply a pre-recorded reference audio clip (~10 seconds) via the web UI settings screen. The hub server forwards it to the Chatterbox API for storage; subsequent TTS calls reference the voice by name string only.

MP3 conversion via FFmpeg (separate Docker Compose service) adds ~10–30ms, producing a smaller delivery format than raw WAV.

**Consequences:**
- Natural, expressive voice output with personality consistent with the Racing Engineer character
- No cloud dependency for TTS
- Both model variants cannot run simultaneously without loading both into VRAM; active variant is selected per request
- The Resemble AI PerTh watermark embedded in all Chatterbox output survives MP3 compression
- Voice cloning requires a clean, single-speaker audio clip from the user — the web UI provides quality guidance alongside the upload control
- Target output latency under 300ms

---

## 10. Voice Activation — Push-to-Talk

**Status:** Accepted

**Context:**
Always-on voice activation requires reliable voice activity detection (VAD) to distinguish driver speech from cockpit noise, engine sound, and sim audio bleed. VAD failure modes (spurious triggers, clipped audio) are difficult to detect and disruptive mid-race. Push-to-talk is predictable, requires no VAD, and matches real-world radio discipline.

**Decision:**
Use Push-to-Talk (PTT) as the voice activation model. The driver holds a configured hotkey while speaking. The Tauri client starts buffering audio on key-down and sends the buffered clip via HTTP POST to Speaches on key-release. Streaming upload during the PTT hold offers no meaningful latency improvement at the clip sizes involved (~100KB) and is not used.

**Consequences:**
- No VAD required; the PTT key-down/key-up pair cleanly bounds the utterance
- Requires a hand movement or foot pedal to activate — acceptable for the sim racing context where a button press is a familiar interaction
- Hotkey bindings are user-configurable; Stream Deck can trigger the same keybind without custom plugin development
- Always-on activation deferred to a future iteration pending driver feedback on PTT ergonomics

---

## 11. Audio I/O — Rust via cpal and rodio

**Status:** Accepted

**Context:**
Microphone capture and speaker playback must happen at the system level, outside the browser rendering context. Web Audio API is not appropriate for a real-time racing context — it runs in the Tauri webview and is subject to tab throttling, GC pauses, and is less predictable than native system audio APIs.

**Decision:**
All audio I/O is owned by the Rust layer in the Tauri client:
- **Capture:** `cpal` crate (cross-platform audio I/O) for microphone input
- **Resampling:** `rubato` crate for converting captured audio (44.1kHz or 48kHz stereo) to 16kHz mono 16-bit PCM before network transfer
- **Playback:** `rodio` crate (wraps `cpal`) for MP3 decoding and audio output from fetched TTS clips

The Tauri webview is not involved in either capture or playback.

**Consequences:**
- Audio pipeline is deterministic and not subject to browser-context throttling
- `cpal` provides cross-platform audio device enumeration; selected device is persisted in SQLite config
- Playback queue is maintained in-process in Rust; the Redis Pub/Sub channel delivers audio URLs, not audio bytes — Tauri fetches and streams audio from the hub server's HTTP endpoint
- Priority audio events can preempt the current playback clip by clearing the queue and stopping the active `rodio` sink

---

## 12. LLM Inference — Switchable Local/Frontier via OpenAI-Compatible API

**Status:** Accepted

**Context:**
Inference quality and availability requirements differ between deployment contexts. During development and for users with capable homelab hardware, a locally-hosted model is preferable for latency and cost. For users without local inference hardware, a cloud API provides a fallback. Hard-coding either approach would require code changes to switch.

**Decision:**
The hub server targets the OpenAI chat completions API shape for all LLM calls. Two deployment modes are supported via configuration with no code changes required to switch:

- **Frontier:** Anthropic Claude API (claude-3.5-sonnet or later), using Anthropic's SDK for API shape translation
- **Local:** GLM family models via an OpenAI-compatible local inference server (Ollama, LM Studio, vLLM)

Model name, base URL, and API key are all runtime configuration. The hub server degrades gracefully if the inference service is unreachable.

**Consequences:**
- Model selection, quantization level, and hardware sizing for the local path are operational tuning decisions, not application architecture decisions
- The inference server is a network dependency (LAN or internet); the app must handle unavailability gracefully rather than failing
- Using Anthropic's SDK for the frontier path (rather than the raw HTTP API) means both paths are abstracted behind the same call site

---

## 13. iRacing Telemetry — Custom Rust SDK Integration

**Status:** Accepted

**Context:**
iRacing exposes telemetry via a memory-mapped shared memory file. Several community Rust crates exist that wrap this interface. Using a community crate introduces a dependency on its maintenance cadence and its interpretation of the SDK specification.

**Decision:**
Implement a custom Rust integration written directly against the official `irsdk_defines.h` specification. No community SDK crate is used for the live telemetry path.

**Consequences:**
- Full ownership of the telemetry reading implementation — no dependency on community crate maintenance or version compatibility
- Changes to the iRacing SDK specification require updates to this implementation; this is accepted as a maintenance task rather than a dependency management problem
- The implementation effort is non-trivial; this is a deliberate investment in long-term reliability over short-term convenience

---

## 14. Telemetry Pipeline — Two-Speed Processing

**Status:** Accepted

**Context:**
The iRacing SDK produces a single 60 Hz data dump. Not all variables change meaningfully at 60 Hz. Processing every variable at full rate in the hub server would create unnecessary load and complicate consumer logic (most consumers do not need per-tick updates for strategic data).

**Decision:**
Classify all telemetry variables into two tracks processed at different rates:

- **Live (60 Hz):** Driving dynamics variables that change within a corner sequence — brake, throttle, lateral G, longitudinal G, speed, steering, and per-car track position (`CarIdxLapDistPct`). Required for safe window detection and incident classification.
- **Session (15 Hz):** Strategic data — lap times, positions, flags, fuel, competitor states. Every 4th SDK tick. Sufficient for strategy decisions; keeps hub-side processing load proportionate.

Tauri downsamples internally before publishing to Redis. The hub server runs two processors (Live Processor at 60 Hz, Session Processor at 15 Hz) consuming from their respective Redis Streams.

**Consequences:**
- Hub server CPU load is proportionate to actual decision-making needs
- Safe window signal and incident detection operate at full fidelity (60 Hz) without requiring all strategy data to process at the same rate
- Session Processor triggers derived model updates (Fuel Model, Tire Model, Gap Model) and event detection on each tick
- Two Redis Streams (`telemetry:live`, `telemetry:session`) replace what could have been a single high-volume stream

---

## 15. Multi-Client Team Sync — Redis with Driver Priority

**Status:** Accepted

**Context:**
In team endurance events, multiple team members run the Tauri client simultaneously. The hub server needs to aggregate data from all connected clients while applying appropriate priority rules — the active driver's telemetry is authoritative for their car; observer clients provide complementary competitor coverage.

**Decision:**
All Tauri clients publish to the same Redis instance. Each message envelope includes a `source` field (`"driver"` or `"observer"`) and a `sessionId` for routing. The hub server identifies the active driving client by matching `carIdx` to the current driver in `DriverInfo`. Driver priority rules:

- For per-car variables (`CarIdx` arrays): the driving client's data is used for the active driver's car; observer clients cover all other cars
- For player-only variables (`FuelLevel`, pedal inputs, sensor data): exclusively sourced from the driving client — absent from observer payloads

On driver swap, the `DriverInfo` YAML update triggers re-evaluation of which connected client is the driving client.

**Consequences:**
- Architecture is identical for solo and team sessions — no conditional code paths
- If the driving client disconnects mid-stint, the hub emits `source:degraded`, drops to observer-mode estimates for that car, and notifies the race control UI
- Redis access model (network-level controls) means teammates connect by configuring the homelab Redis URL in their Tauri client — no app-level account system needed for v1
- The hub server becomes the single source of truth for team state: active driver, swap history, total laps, cross-stint fuel burn

---

## 16. Overlay Architecture — Hub-Served HTTP, OBS Browser Sources Pull

**Status:** Accepted

**Context:**
OBS browser sources require a URL to load. The intuitive architecture — "push data from the app into OBS" — is not how OBS browser sources work. OBS polls the URL; the page's JavaScript handles data refresh. An architecture that tries to push rendered data frames or DOM updates directly into OBS would require workarounds with no official support.

**Decision:**
The hub server hosts overlay HTML pages at stable local URLs. OBS browser sources load those URLs directly. The overlays' own JavaScript pulls live race state from the hub server's HTTP or WebSocket endpoint on a configurable refresh timer. The hub server uses `SetInputSettings` via the OBS WebSocket to point browser sources at the correct local URLs, but does not push data frames into OBS.

The app ships default overlay templates. Advanced users can fork and customize them as long as they use the hub server's data API.

**Consequences:**
- Decouples the overlay rendering engine from the application core
- OBS manages its own browser source refresh lifecycle; the hub server does not need to track which overlays are currently visible
- Data latency in overlays is governed by the browser source refresh interval, not by the hub server's push cadence
- A stream delay offset configuration (see ADR 18) allows overlays to render state at `now - stream_delay` rather than current state

---

## 17. Video Feed in Race Control Center — HLS, Not OBS WebSocket

**Status:** Accepted

**Context:**
The Race Control Center web UI includes a video panel showing the live stream output. The OBS WebSocket protocol includes a video feed capability, but it is limited to approximately 1 FPS — insufficient for a usable stream preview.

**Decision:**
The Race Control Center video panel consumes an HLS stream served independently of the hub server. The HLS stream URL is operator-configured. How the HLS stream is produced is outside the application's scope — common sources include OBS's built-in HLS output, a media relay receiving an RTMP ingest, or a streaming helper application. The page embeds the URL in a standard `<video>` element with HLS.js for cross-browser support. No video data passes through the hub server.

**Consequences:**
- Video preview quality is not constrained by the OBS WebSocket protocol
- The hub server is not in the video path; no video buffering or transcoding load on the homelab server
- The operator must configure and maintain their own HLS output alongside the application; this is accepted as an operator setup step
- HLS.js handles cross-browser HLS playback without requiring native browser HLS support

---

## 18. OBS Browser Source Latency — Accepted, Sync with Stream Delay

**Status:** Accepted

**Context:**
Display lag exists in the overlay pipeline: the hub server writes race state, the browser source polls the hub, the data updates, OBS composites the browser source into the stream output, and the stream is delayed by the operator's configured artificial stream delay (used to prevent stream sniping). The initial instinct might be to minimize this lag, but the actual requirement is different.

**Decision:**
Browser source display latency is accepted. The requirement is not minimum latency but synchronization: overlay data should reflect the state of the race at the moment being broadcast, not the current moment. The hub server exposes a configurable "stream delay offset" parameter. Overlays render state at `now - stream_delay` using a rolling buffer of recent state history maintained by the hub server.

**Consequences:**
- The overlay system requires a rolling history buffer (targeting ~60-second window) rather than a single current-state snapshot
- Operators configure the stream delay offset to match their OBS stream delay setting
- Data/video desync is a misconfiguration problem, not an architectural problem
- This approach actually simplifies real-time pressure on the overlay pipeline

---

## 19. Discord Integration — Webhooks, Not a Bot

**Status:** Accepted

**Context:**
The product brief calls for the hub server to post stint summaries, competitor pit alerts, and swap window recommendations to a team Discord channel during endurance events. Discord offers two integration options: webhooks (send-only, zero setup complexity) and a full bot (bidirectional, significant setup complexity for both developer and end user).

**Decision:**
Use Discord webhooks for v1. A webhook is a static URL created per-channel. The hub server POSTs JSON to that URL — no bot, no OAuth, no SDK. The operator pastes the webhook URL into the app configuration.

A Discord bot is deferred. It would only be needed if the team wants to query the app via Discord (e.g., "!fuel" to get a fuel estimate), which is a future feature, not MVP.

**Consequences:**
- Integration is send-only — the app cannot receive messages or commands via webhook
- No @mentions of specific users (would require a bot)
- Rate limit: 5 requests per 2 seconds per webhook URL — sufficient for the posting cadence anticipated
- Operator setup is minimal: generate a webhook URL in Discord, paste it into the app

---

## 20. Stream Deck Integration — Global Hotkeys for v1, No Plugin

**Status:** Accepted

**Context:**
Stream Deck integration could be implemented two ways: a full Stream Deck plugin (Node.js process connecting to the Stream Deck app via WebSocket, enabling dynamic button labels and per-button configuration) or by relying on Stream Deck's native support for sending keyboard shortcuts. Building a plugin requires maintaining a separate process, an IPC channel between the plugin and the main app, and publishing to the Stream Deck marketplace or handling local plugin installation.

**Decision:**
For v1, no Stream Deck plugin is built. The Tauri client listens for configurable global hotkeys. Stream Deck's native "Hotkey" action type can trigger these same hotkeys without any plugin. This is the zero-maintenance path.

A proper Stream Deck plugin (with dynamic button labels showing live race data) is deferred to a future iteration pending validation that Stream Deck users want this beyond what hotkeys provide.

**Consequences:**
- Stream Deck button labels are static for v1 — no dynamic fuel level or gap display on button faces
- No plugin development, no plugin distribution or installation process
- Any hotkey-capable hardware (foot pedals, button boxes, MIDI controllers) works identically to Stream Deck without additional integration work

---

## 21. iRacing Camera Control — Accepted Instability Risk

**Status:** Accepted (with noted risk)

**Context:**
The Stream Engineer requires the ability to switch the in-game camera to any car and camera group programmatically. iRacing exposes this via SDK broadcast messages (`CamCarIdx`, `CamGroupNumber`, `CamCameraNumber`). This camera control API is community-documented — it is not part of the official iRacing SDK documentation and may break across iRacing updates without notice.

**Decision:**
Implement camera switching via SDK broadcast messages and accept the instability risk. Any iRacing-side breakage is treated as a maintenance task, not a design constraint. The Stream Engineer continues to function in all other respects (telemetry processing, overlay data, Discord posting) if camera control breaks.

**Consequences:**
- Camera control is a best-effort feature — it can break without the developer having made a mistake
- The camera control failure mode is graceful: the stream continues unchanged, the Operator receives an alert, and manual camera control remains available
- No alternative to this approach exists without iRacing providing an official camera API

---

## 22. Authentication — Authentik via OAuth2/OIDC

**Status:** Accepted

**Context:**
The hub server's web UI must be protected from unauthenticated access. Options include building app-level credential management (username/password, session tokens), using a third-party auth service (Auth0, Clerk), or delegating to the homelab's existing identity provider. Building app-level auth introduces credential storage, hashing, and session management that is out of scope for a project of this scale. Third-party auth services introduce a cloud dependency.

**Decision:**
Use Authentik — the homelab's existing identity provider — via OAuth2 authorization code flow. Users authenticate through Authentik, which is already running as a homelab service. The hub server is registered as an OIDC client.

The Tauri client uses a pre-shared connection token (configured per-installation) to authenticate with the hub server API and Redis — no full OAuth flow in the native app.

**Consequences:**
- No app-level credential management — no passwords stored in Postgres
- Requires the homelab operator to register the hub server as an Authentik application; this is a one-time setup step
- Users without access to the homelab Authentik instance cannot use the web UI — team members must be provisioned in Authentik
- If Authentik is unavailable, the web UI is inaccessible; this is acceptable for a homelab-hosted tool

---

## 23. Observability — OpenTelemetry with Grafana Stack

**Status:** Accepted

**Context:**
The audio pipeline latency waterfall (PTT capture through audio playback) spans multiple processes across two machines. Correlating log output from the Tauri client, hub server, Whisper, and Chatterbox requires a distributed tracing system. The homelab already runs Grafana; aligning the observability stack with existing infrastructure reduces operational overhead.

**Decision:**
Use OpenTelemetry (OTel) across all components. Grafana Alloy runs on the homelab server as the OTel collector, routing signals to Grafana-native backends:

- **Logs → Grafana Loki** (structured application logs, searchable by service and session)
- **Traces/Spans → Grafana Tempo** (distributed traces, including the full audio pipeline latency waterfall)
- **Metrics → Grafana Prometheus** (optional; throughput and error rate dashboards)

The hub server uses the [tkottke90/js-libraries logger package](https://github.com/tkottke90/js-libraries/tree/main/packages/logger) as the logging foundation, emitting to both stdout and the OTel OTLP exporter.

Tauri client logs are shipped to the hub server's log ingestion endpoint (subject to the user's opt-in toggle in SQLite config) and forwarded to Alloy.

**Consequences:**
- Each voice interaction generates a trace ID that correlates all pipeline stages into a single Tempo flamegraph
- All session-scoped events are tagged with `session_id` for log correlation in Loki
- Debug-level telemetry logging is off by default to avoid volume at 60 Hz
- Tauri client telemetry shipping is opt-in; users who opt out retain local logs only

---

## 24. Fuel Strategy Math — Deterministic Code, Not LLM Reasoning

**Status:** Accepted

**Context:**
The Racing Engineer LLM will be asked questions that require numerical fuel calculations: laps remaining on current load, fuel to finish, deficit or surplus. LLMs are capable of arithmetic but produce inconsistent results — the same calculation may return different values across calls, and the model may hallucinate race state details when constructing the math.

**Decision:**
All fuel arithmetic is performed by the deterministic Fuel Model in the hub server. The model is exposed to the Racing Engineer LLM as a callable tool (`get_fuel_status()`) that returns a structured `FuelModel` object and a pre-formatted `summary` string ready for use in a Tier 3 briefing. The LLM uses the tool output directly rather than performing fuel arithmetic itself. The same pattern applies to the Tire Model.

**Consequences:**
- Fuel and tire calculations are deterministic and consistent across LLM calls
- The LLM's role is reasoning and communication, not arithmetic
- Expanding strategy logic (more sophisticated pit window modeling, multi-stint planning) is a code change to the Fuel Model, not a prompt engineering problem
- The tool interface (`get_fuel_status()`, `get_tire_status()`) must remain stable as the LLM is updated; breaking changes to the tool schema require prompt updates
