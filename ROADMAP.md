# iRacing Engineer — Implementation Roadmap

**Status:** Living document  
**Last updated:** 2026-06-29

Each milestone is self-contained and deployable. A milestone gate is: the feature can be used in a real iRacing session (or meaningfully tested without one) without depending on an unbuilt milestone.

---

## What's Done

| Spec | What it delivered |
|------|-------------------|
| **001 — iRacing SDK Diagnostics** | Tauri client connects to the iRacing shared memory API, reads telemetry variables and session YAML, diagnostic UI confirms data flow |
| **002 — Redis Telemetry Publishing** | Tauri publishes `telemetry:live` (60 Hz) and `telemetry:session` (15 Hz) to Redis Streams; `session:yaml` on change to Pub/Sub; message envelope with source/sessionId tags |

The data tap is live. Every milestone below reads from Redis — nothing touches the SDK directly from here on.

---

## POC Gate

Three proof-of-concepts exist in `pocs/` and must produce pass/fail findings **before M4 is specced**. They de-risk the voice pipeline, which is on the critical path.

| POC | Question | Blocks |
|-----|----------|--------|
| `0001-audio-pipeline-latency` | Can audio playback from the hub server reach the Tauri client with < 300ms added latency? | M4 |
| `0002-local-stt-latency` | Does Whisper `small.en` transcribe a short voice command in < 1s on the racing PC? | M5 |
| `0003-streaming-llm-tts` | Can a streaming LLM → chunked TTS pipeline deliver the first audio chunk in < 2s end-to-end? | M5 |

POCs are run, results documented in `pocs/<name>/results/`, and findings folded into the affected milestone specs before implementation begins.

---

## M3 — Race State Engine

**Theme:** The data backbone. Hub server reads the Redis telemetry streams and produces a live Race State that every downstream consumer depends on.

**What it delivers:**
- Hub server consumes `telemetry:live`, `telemetry:session`, and `session:yaml`
- In-memory Race State: `SessionState`, `FieldState` (all CarIdx), `HeroState` (player-only)
- `SessionPhase` state machine with transitions
- **Fuel Model** (Level 1–3 fidelity, rolling burn rate, laps-to-finish)
- **Tire Model** (lap age, pace degradation signal, 3-state classification)
- **Gap Model** (per-pair gap tracking, closure rate, battle status transitions)
- **Safe Window signal** computed at 60 Hz from Live stream (LatAccel + Throttle + brake history)
- Event Bus: Redis Pub/Sub event emission for the full event catalog (session, hero, competitor, gap events)
- Race State KV snapshot written to Redis (`race_state:{sessionId}`) at 15 Hz
- Observability: structured logging, event emission latency metrics

**Deploy test:** Run a mock telemetry replay into Redis; verify that correct events fire at correct moments, race state reflects telemetry, and the safe window signal toggles believably through a corner sequence.

**Does not include:** Any consumer of the Event Bus (Racing Engineer, Stream Engineer). Those are M4+.

---

## M4 — Racing Engineer: Rule-Based Alerts + Voice

**Theme:** First feature the driver can use. The engineer speaks during a live race without requiring LLM inference.

**Prerequisites:** M3 complete; POC 0001 results in hand.

**What it delivers:**
- Hub server Racing Engineer service subscribes to the Event Bus
- **Tier 1 alerts** (immediate, gate-override): fuel critical, blue flag, safety car, pit limiter
- **Tier 2 alerts** (safe window gate): pit window opens, competitor pit entry/exit, gap threshold crossings, pace degradation
- Priority message queue with safe window gating (Radio Blackout Zones as static config, full editor deferred to M9)
- Message deduplication: no repeat of the same alert on the next lap
- **TTS integration** — Chatterbox/Speaches server: text → audio clip → stored in Redis
- **Tauri audio playback** — hub pushes audio clip reference; Tauri fetches and plays
- Basic Personality stubs: Chattiness (Low/Default — suppresses Tier 2 or not); Familiarity and Aggression are default-only placeholders until M5

**Deploy test:** Drive a full practice lap at a real iRacing track. Engineer delivers a pit window alert through speakers at the correct lap. Fuel critical fires at the right threshold.

**Does not include:** LLM calls, STT, PTT, Tier 3 messages, driver override tracking.

---

## M5 — Racing Engineer: LLM + Push-to-Talk

**Theme:** Completes the voice loop. The engineer reasons, the driver can ask questions.

**Prerequisites:** M4 complete; POCs 0002 and 0003 results in hand.

**What it delivers:**
- **Whisper STT** — local endpoint, transcribes push-to-talk audio from Tauri mic
- **PTT activation** — configurable hotkey in Tauri client (hardware and Stream Deck passthrough)
- **LLM integration** — OpenAI-compatible API, LLM tool calling for `get_fuel_status()` and `get_tire_status()`
- **Context assembly** — structured race state summary with field truncation rules, token budget ceiling
- **Tier 3 messages** — LLM-synthesized: pit lane entry briefing, safety car briefing, on-demand driver queries, post-sector commentary
- **Personality system** — all three dimensions active (Chattiness, Familiarity, Aggression), system prompt construction with POC validation findings
- **Driver override tracking** — detects when a recommendation window passes without action; engineer stops advocating, pivots to the driver's decision
- **Adaptive deference** — shifts from recommendations to information presentation after repeated overrides in a session
- **Session memory** — recommendation log, override outcomes, fuel model calibration updates; context included in LLM context assembly
- Graceful degradation: if LLM is unreachable, Tier 3 messages are skipped; Tier 1/2 continue unaffected

**Deploy test:** Drive a race stint. Ask "do we pit this lap?" verbally and receive a synthesized briefing under 5 seconds. Override a pit recommendation, then confirm the engineer stops repeating it.

---

## M6 — Stream Engineer: OBS Control + Broadcast Plan

**Theme:** The stream runs itself. Autonomous camera direction based on a pre-authored plan.

**Prerequisites:** M3 complete. (Independent of M4/M5 — can be developed in parallel.)

**What it delivers:**
- **Postgres schema** — `broadcast_plans`, `sessions` (stub, full session record in M9)
- **Broadcast Plan schema** — hero/general type, primary subjects with priority + storyline annotations, watchability hints, contingency behaviors; stored in and loaded from Postgres
- **OBS WebSocket client** — connect/disconnect lifecycle, exponential backoff reconnection, sustained outage detection + logging
- **Cut Model** — Tier 1 (immediate) and Tier 2 (hold gate) cuts executing against OBS scenes
- **Cut Window detection** — minimum dwell, no active overtake, no unresolved incident in frame
- **Hero mode** — follows primary subject list in priority order, camera type variety tracking, pit stop coverage, brief competitor cuts
- **General mode** — action scoring rubric (position changes, gap states, lead fight, final laps), continuous re-scoring, tie-breaking by field position
- **Operator override detection** — monitors OBS scene changes not initiated by the engineer; enters manual hold
- **Manual hold** — autonomous cuts suspended for configurable duration; Tier 1 overrides hold
- **OBS reconnect resync** — on reconnect, sets current desired scene rather than replaying command history

**Deploy test:** Author a hero broadcast plan, start a race, start OBS. Engineer makes scene cuts over 10 minutes without operator interaction. Manually change the scene in OBS; confirm engineer enters manual hold.

---

## M7 — Operator UI: Race Control Center + Broadcast Plan Editor

**Theme:** The operator has a window into the session and a surface to author the broadcast plan.

**Prerequisites:** M6 complete.

**What it delivers:**
- **Broadcast Plan Editor** — web UI (hub server served) for authoring plans: type selection, subject configuration, production style dimensions, contingency behaviors, watchability hints, saved plan CRUD
- **Race Control Center** — live session monitoring UI, accessible from any LAN device:
  - Live stream preview via HLS embed
  - Current race state panel (positions, gaps, flags, session phase)
  - Stream Engineer activity log (cuts made, queue, manual hold status)
  - Override controls (enter/exit manual hold; resume autonomous)
  - **Live Operator Signals** — hero car status (active / in\_repair / dnf + repair timer), storyline updates, incident flags
  - Racing Engineer activity log (messages delivered, queue)

**Deploy test:** Author a plan from a laptop on the same LAN as the racing PC. During a session, push a hero-car-in-repair signal from the laptop and confirm the stream engineer enters roaming mode and the repair timer graphic queues.

---

## M8 — Overlay Server

**Theme:** Data-driven broadcast graphics. OBS browser sources display live race state.

**Prerequisites:** M3 (race state), M6 (OBS integration).

**What it delivers:**
- **Overlay HTTP server** — hub server exposes local endpoints; OBS browser sources pull from them
- **Stream delay offset** — configurable delay parameter; overlays render state at `now − stream_delay` from a rolling state history buffer
- Initial overlay set (extensible):
  - Gap bar — hero car to car ahead and behind
  - Lap time ticker — current lap delta to personal best
  - Fuel remaining — laps remaining from Fuel Model
  - Position graphic — hero car position and total field
  - Pit strategy card — competitor pit history, open window status
- OBS Controller sets browser source URLs via `SetInputSettings` at session start

**Deploy test:** Add a gap bar browser source in OBS. Verify the displayed gap matches the live race gap with the configured stream delay offset.

---

## M9 — Post-Session Debrief + Blackout Zone Editor

**Theme:** The session lives on. Drivers analyze what happened and improve the engineer for next time.

**Prerequisites:** M3 (session record), M5 (engineer decisions), M6 (Postgres).

**What it delivers:**
- **Session persistence** — at `PostRace`, hub server writes: `sessions`, `stint_fuel_data`, `tire_stint_data`, `event_log`, `engineer_decisions` to Postgres
- **Crash recovery** — on hub restart after unclean shutdown, writes session record from Redis ring buffer before TTL expires
- **iRacing REST API integration** — OAuth2 auth, post-session lap-by-lap data fetch, stored in Postgres for debrief
- **Debrief web UI** (served from hub server):
  - Lap time chart with sector breakdown
  - Fuel model vs. actual comparison chart
  - Tire degradation signal vs. pace chart
  - Engineer decision log (all recommendations, driver responses, outcomes)
  - **Radio Blackout Zone editor** — track map overlaid with message delivery markers (lap pct × session time); two-point slider to define zones by lap distance %; zones persisted per track, applied on next session

**Deploy test:** Complete a race session, open the debrief UI. All laps appear in the lap chart. Create a blackout zone on the track map; confirm the next session on the same track suppresses Tier 2 messages in that zone.

---

## M10 — Tauri Client Configuration UI

**Theme:** The driver can configure the app without editing config files.

**Prerequisites:** M4 (audio), M5 (PTT/STT).

**What it delivers:**
- **Audio device selection** — input (mic for PTT) and output (engineer voice)
- **Connection configuration** — Redis URL, hub server URL, Whisper STT endpoint, LLM API base URL + model name
- **Hotkey bindings** — PTT key, common query shortcuts; Stream Deck passthrough via global hotkey
- **Telemetry debug readout** — live variable values, connection status, Redis stream lag
- **Telemetry logging opt-in** — toggle for raw session logging (future IBT analysis)
- **Voice profile upload** — reference audio clip for Chatterbox voice cloning
- **Engineer personality sliders** — Chattiness, Familiarity, Aggression (writes to hub server config)

**Deploy test:** Change the LLM model name in the UI. Restart the racing engineer service. Confirm the next Tier 3 message uses the new model.

---

## M11 — Team Observer Mode + Discord

**Theme:** The pit wall is connected.

**Prerequisites:** M3, M5.

**What it delivers:**
- **Observer mode in Tauri** — when user is spectating (not driving), `source: "observer"` tag on all messages; player-only variables omitted from publish
- **Multi-client hub merging** — hub identifies driving client from `DriverInfo`; driver data takes priority for player-only vars; `source:degraded` event on driving client disconnect
- **Safe window fallback** — without live LatAccel/throttle/brake, falls back to static track section model (lap distance % zones)
- **Team fuel strategy at Level 3** — estimated from lap count + car class tank capacity defaults + historical Postgres data if available
- **Discord webhook integration** — configurable webhook URL; hub posts on: stint summary (on pit entry/driver swap), competitor pit alerts (relevant to hero strategy), swap window recommendations, next driver readiness prompts
- **Fuel model calibration seeding** — `stint_fuel_data` from Postgres used as Level 2 prior at session start

**Deploy test:** Run a two-client session: one driving, one spectating from a second machine. Both connected to hub. Discord receives a stint summary at the end of the first stint.

---

## Milestone Summary

| # | Milestone | Delivers |
|---|-----------|----------|
| ✅ 001 | SDK Diagnostics | SDK connection, diagnostic UI |
| ✅ 002 | Redis Telemetry Publish | Live + session telemetry on Redis Streams |
| 🔲 POC Gate | Audio pipeline, STT latency, streaming LLM+TTS | De-risks voice pipeline |
| 🔲 M3 | Race State Engine | Fuel/Tire/Gap models, event bus, safe window signal |
| 🔲 M4 | RE: Rule-Based Alerts + Voice | Tier 1/2 messages, TTS, audio playback — drivable |
| 🔲 M5 | RE: LLM + PTT | Whisper STT, Tier 3, personality, override tracking |
| 🔲 M6 | SE: OBS Control + Broadcast Plan | Autonomous camera direction, Postgres schema |
| 🔲 M7 | Operator UI | Race Control Center, Broadcast Plan Editor |
| 🔲 M8 | Overlay Server | Browser source graphics, stream delay sync |
| 🔲 M9 | Post-Session Debrief | Postgres persistence, iRacing REST API, debrief + zone editor |
| 🔲 M10 | Tauri Config UI | Audio, connection, hotkeys, debug readout |
| 🔲 M11 | Team Observer + Discord | Multi-client, Discord webhook, observer mode |

M3 → M4 → M5 is the critical path. M6 can start in parallel with M4/M5 once M3 is complete. M7 follows M6. M8 can start once M3 and M6 are both done. M9, M10, and M11 are independent of each other and can run in parallel once their prerequisites are met.
