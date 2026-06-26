# Integration & Data Availability Map

This document maps every external system the iRacing Engineer app must integrate with, what data or control surface each provides, and where known constraints will shape product decisions.

---

## 1. iRacing SDK (Shared Memory)

The primary real-time data source. iRacing exposes a memory-mapped file (`Local\IRSDKMemMapFileName`) that any process on the same machine can read. No authentication. No network. Low latency.

**Update rate:** Telemetry variables at 60 Hz. Session YAML string updated periodically (on session changes, driver swaps, etc.).

### Two data streams

**Telemetry variables (60 Hz)**
Numerical values read from shared memory. Two categories matter for this product:

_Player-only variables_ — available only when the user is driving their own car:

| Variable                                  | Description                |
| ----------------------------------------- | -------------------------- |
| FuelLevel / FuelLevelPct                  | Actual fuel remaining      |
| FuelUsePerHour                            | Live consumption rate      |
| Brake / Throttle / Clutch                 | Pedal inputs               |
| RPM, Gear, Speed                          | Powertrain state           |
| LapCurrentLapTime                         | Running lap time           |
| LapDeltaToBestLap                         | Real-time delta            |
| WaterTemp, OilTemp, OilPress              | Engine health              |
| SteeringWheelAngle, LatAccel/LongAccel    | Dynamic driving data       |
| PitRepairLeft, PitOptRepairLeft           | Time remaining in pit stop |
| PlayerCarPosition, PlayerCarClassPosition | Race position              |
| PlayerCarDriverIncidentCount              | Incident points            |
| TireSetsUsed / Available                  | Tire inventory             |

_All-car variables (CarIdx arrays)_ — indexed by car slot, available for every car on track regardless of whether you are driving or spectating:

| Variable                              | Description                  |
| ------------------------------------- | ---------------------------- |
| CarIdxPosition / CarIdxClassPosition  | Race position per car        |
| CarIdxLap / CarIdxLapCompleted        | Current lap number           |
| CarIdxLapDistPct                      | Track position (0–1)         |
| CarIdxLastLapTime / CarIdxBestLapTime | Lap time history             |
| CarIdxEstTime                         | Estimated current lap time   |
| CarIdxF2Time                          | Gap to leader / relative gap |
| CarIdxOnPitRoad                       | Boolean: car on pit road     |
| CarIdxTireCompound                    | Tire compound in use         |
| CarIdxFastRepairsUsed                 | Repair count                 |
| CarIdxGear, CarIdxRPM, CarIdxSteer    | Live car state (limited use) |
| CarIdxTrackSurface                    | On track / pit / garage      |

**Session YAML (semi-static)**
A YAML string covering session metadata, updated on events:

- `WeekendInfo` — track, event type, rules, weather config
- `SessionInfo` — session list (practice, qualify, race), session time/laps
- `DriverInfo` — full driver/car roster, team assignments, car class
- `SplitTimeInfo` — sector definitions
- `CameraInfo` — available camera groups and positions
- `RadioInfo` — radio frequency definitions

### Spectator / Observer behavior

Spectators connect to a session as non-scoring clients. Per SDK documentation, **spectators receive the full SDK feed including all CarIdx variables** — they appear in DriverInfo but not standings. This means a team observer client running on a separate machine gets positions, lap times, gap data, pit road entry/exit, and tire compound for every car on track.

**What is NOT available to observers:**

- The player-only variables (fuel level, exact fuel burn rate, pedal inputs, tire temps/wear by corner, engine temps) — these only populate for the car being actively driven by that client
- Sector-by-sector splits for competitors (only full-lap times via CarIdxLastLapTime)

**Implication for Team Observer Mode:** Fuel strategy in observer mode must be inferred from observable lap counts and known tank capacity, not from a live FuelLevel read. This is the core constraint the product brief acknowledges.

### Camera control

The SDK exposes camera state read/write. `CamCarIdx`, `CamGroupNumber`, `CamCameraNumber` can be set via SDK broadcast messages to switch the in-game camera to any car and any camera group. This is how the Stream Engineer can cycle cameras without user interaction.

---

## 2. iRacing Data REST API

A separate HTTP API requiring OAuth authentication. Used for **historical and reference data**, not live race data.

**Authentication:** OAuth2 (legacy auth removed December 2025). Requires iRacing member credentials.

**What it provides:**

- Session results by subsession ID (lap-by-lap data, finishing order, incidents)
- Driver/car lookup by customer ID
- Track and car catalog metadata
- Series and season standings
- Member career stats and lap records

**What it does NOT provide:**

- Anything real-time — this is a post-session or pre-session API
- Live telemetry (that is the SDK)

**Relevance to the product:** The REST API is the right source for post-session debrief data — pulling full lap-by-lap comparisons, sector times, and historical pace trends after a session ends. It is not involved in the real-time race engineer or stream engineer paths.

---

## 3. OBS WebSocket (v5)

OBS 28 and later ships with a built-in WebSocket server (default port 4455, password-protected). The protocol is a fully documented request/response system over standard WebSocket.

**Key capabilities:**

| Capability                      | Request/Event                                          |
| ------------------------------- | ------------------------------------------------------ |
| Switch live scene               | `SetCurrentProgramScene`                               |
| Set preview scene (Studio Mode) | `SetCurrentPreviewScene`                               |
| Show/hide a source              | `SetSceneItemEnabled`                                  |
| Update browser source settings  | `SetInputSettings`                                     |
| Start / stop streaming          | `StartStream` / `StopStream`                           |
| Start / stop recording          | `StartRecord` / `StopRecord`                           |
| Save replay buffer              | `SaveReplayBuffer`                                     |
| Subscribe to scene changes      | `SceneTransitionStarted`, `CurrentProgramSceneChanged` |
| Subscribe to stream status      | `StreamStateChanged`                                   |

A JavaScript library (`obs-websocket-js`) provides a typed client. The protocol uses unique message IDs so every request gets a confirmed response.

### Critical architecture note: Overlay model

The architecture diagram shows `Overlay Engine → OBS`. In practice, OBS browser sources work in reverse — OBS polls a local URL, it does not receive a push. The correct data flow is:

**App exposes a local HTTP server (or WebSocket endpoint) → OBS browser source loads that URL → browser source requests updated data on a timer or via WebSocket from the app.**

This means the Overlay Engine is really a local web server hosting the overlay pages. The OBS Controller uses `SetInputSettings` to point browser sources at the correct local URLs, but does not push data frames into OBS directly.

---

## 4. Discord

Two integration options exist, with very different complexity profiles.

### Option A: Webhooks (recommended for this product)

A Discord webhook is a static URL created per-channel. The app POSTs JSON to that URL — no bot, no OAuth, no SDK.

**Capabilities:**

- Post text messages and rich embeds (cards with fields, colors, titles)
- Override display name and avatar per message
- Target a specific thread within a channel

**Limitations:**

- Send-only — cannot receive messages or commands via webhook
- No @mentions of specific users (use bot for that)
- Rate limited: 5 requests per 2 seconds per webhook URL

For the product's use case — posting stint summaries, competitor pit alerts, swap window recommendations — webhooks are sufficient and require minimal setup from the user (just paste a URL into the app config).

### Option B: Discord Bot

A proper bot with application credentials. Can read and respond to messages, use slash commands, send DMs, and mention users. Significantly more setup complexity for both the developer and the end user.

**Verdict:** Webhooks cover the stated use cases from the product brief. A bot would only be needed if the team wants to query the app via Discord (e.g. "!fuel" to get a fuel estimate). That is a potential future feature, not MVP.

---

## 5. Elgato Stream Deck SDK

The Stream Deck app communicates with plugins via a local WebSocket. Plugins are Node.js processes (SDK v2 requires Node 24+, Stream Deck 7.1+).

**How it works:**

1. The plugin process connects to the Stream Deck app WebSocket on startup
2. Stream Deck sends `keyDown` / `keyUp` events when buttons are pressed
3. The plugin can update button appearance (text, image, color) in response to app state
4. A property inspector (HTML/JS page) provides per-button configuration UI

**Key capabilities for this product:**

- Receive button press events and translate them to app commands (e.g. trigger a voice query, force a scene switch)
- Update button labels dynamically (e.g. show current fuel level or gap on a button face)
- Multi-action support (one button triggers a sequence)

**Deployment consideration:** The Stream Deck plugin and the iRacing Engineer main app are separate processes. They need an IPC channel — options are a local WebSocket server in the main app, or named pipes. The plugin translates Stream Deck button events into commands for the main app.

**Alternative — no plugin:** Stream Deck natively supports sending keyboard shortcuts and system hotkeys without any SDK work. If the main app listens for configurable global hotkeys, Stream Deck can trigger them with zero plugin development. This is the lower-effort path and may be sufficient for v1.

---

## Summary: Data Availability by Session Context

| Data                         | Driving       | Spectating / Observer |
| ---------------------------- | ------------- | --------------------- |
| Own fuel level (exact)       | ✅            | ❌                    |
| Own fuel burn rate           | ✅            | ❌                    |
| Own tire temp/wear           | ✅            | ❌                    |
| Own lap time (live)          | ✅            | ❌                    |
| Own delta to best            | ✅            | ❌                    |
| All cars: position           | ✅            | ✅                    |
| All cars: lap count          | ✅            | ✅                    |
| All cars: last lap time      | ✅            | ✅                    |
| All cars: estimated gap      | ✅            | ✅                    |
| All cars: on pit road        | ✅            | ✅                    |
| All cars: tire compound      | ✅            | ✅                    |
| Session flags (yellow, etc.) | ✅            | ✅                    |
| Weather / track conditions   | ✅            | ✅                    |
| Camera control               | ✅            | ✅                    |
| Post-session lap data        | ✅ (REST API) | ✅ (REST API)         |

---

## Architecture Decisions

The following questions were evaluated and resolved. Each decision has downstream implications for the system architecture.

---

**1. Speech Services — Local, self-hosted**

Both STT and TTS will run locally on the racing PC. STT via Whisper (locally hosted). TTS via a self-hosted service (to be selected). This eliminates cloud dependency and network latency from the voice loop — critical given the sub-second response time requirement mid-race.

_Implications:_

- Whisper model size is a tuning decision: `base` or `small` for low latency vs. `medium` for accuracy. A `small.en` model is a reasonable starting point for English-only voice commands.
- TTS service needs evaluation. Options include Piper TTS (fast, local, open-source), Coqui TTS, or a lightweight ONNX-based model. Latency from text to audible output should target under 300ms.
- Both services must run as persistent background processes on the PC, not loaded on demand per query.
- The speech pipeline (mic → Whisper → LLM → TTS → speaker) needs an end-to-end latency budget defined before model selection is finalized.

---

**2. AI Inference — Dedicated local hardware, OpenAI-compatible API**

A dedicated hardware machine on the local network runs the inference server. The app calls it via an OpenAI or Anthropic-compatible API endpoint (e.g., Ollama, LM Studio, vLLM, or similar). No cloud dependency.

_Implications:_

- The app is API-agnostic by design — it targets the OpenAI chat completions interface, which is supported by all major self-hosted LLM servers. This also allows a cloud fallback (swap the base URL) without code changes.
- The inference server is a network dependency, not a local process. The app must handle inference server unavailability gracefully — degrading to rule-based strategy responses rather than failing entirely.
- The dedicated hardware is not the racing PC, so the inference server is accessed over LAN. Network latency within a local network is negligible (<1ms), but the call is still async and should be treated as such.
- Model selection (size, quantization) is outside the scope of this document but directly affects response quality and latency. The inference server should expose a configurable model name so the operator can tune it without app changes.

---

**3. Multi-client team sync — Push to central server, Redis queue, driver priority**

Multiple team clients (each running the iRacing Engineer app) push telemetry to a central coordination server. The server processes data from all clients, with the active driver's telemetry taking priority over observers. Redis is used as the queue to buffer incoming telemetry volume and decouple ingestion from processing.

_Implications:_

- A **Team Coordination Server** is a new architectural component not shown in the current diagram. One team member's machine runs this server (likely the primary driver's PC or a dedicated machine). All team clients connect to it.
- Redis is now a required infrastructure dependency for team sessions. For solo use, this coordination layer is not needed — the app runs without it.
- **Driver priority rule:** When the same CarIdx data arrives from both the active driver client and an observer client, the driver's data is used. For player-only variables (fuel, tire temps), only the driving client can provide them; the server should tag the source on ingest.
- The queue approach decouples high-frequency telemetry ingestion (60 Hz × N clients) from the lower-frequency strategy processing. This is the right pattern — processing every tick from every client is unnecessary for strategy decisions.
- The server also becomes the single source of truth for team state: who is currently driving, swap history, total laps, fuel burn across stints.

---

**4. iRacing camera API stability — Accepted risk**

Camera switching via SDK broadcast messages is community-documented and may break across iRacing updates. This instability is accepted. The Stream Engineer will implement camera control and treat any iRacing-side breakage as a maintenance task, not a design constraint.

---

**5. OBS browser source latency — Accepted, stream delay already in place**

Display lag in the overlay pipeline is acceptable. The operator already applies an artificial stream delay (cheater protection), so overlay data needs to be synchronized with that delay rather than minimized. The requirement is **sync between data and video**, not minimum latency.

_Implications:_

- The overlay system should expose a configurable "stream delay offset" so displayed data (gaps, positions, fuel estimates) reflects the state of the race at the moment being broadcast, not the current moment. This is a deliberate design parameter, not a bug to fix.
- This actually simplifies the overlay design — a small buffer of state history (e.g., rolling 60-second window) can be maintained, and overlays render the state at `now - stream_delay` rather than `now`.
