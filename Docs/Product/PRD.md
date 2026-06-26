# Product Requirements Document: iRacing Engineer

**Status:** Living document — updated as scope is refined  
**Last updated:** 2026-06

---

## 1. Product Vision

iRacing Engineer is an AI-powered race engineer and stream director for sim racers who broadcast their sessions live. It eliminates the cognitive split between racing and producing by offloading two distinct roles to autonomous AI agents: a **Racing Engineer** that synthesizes telemetry into actionable spoken advice, and a **Stream Engineer** that manages the broadcast against a pre-authored plan.

The product's north star is simple: **return the driver's attention to the task of racing.**

---

## 2. Target Users

### The Driver

The primary user during a session. Racing demands 100% cognitive focus; the Driver must never be asked to manage the stream mid-race. The Driver interacts primarily through voice (push-to-talk queries and commands) and pre-session configuration. Post-session, the Driver uses the UI for debrief and analysis.

### The Stream Operator

May be the Driver between stints (in a team endurance context) or a dedicated co-pilot. The Operator interacts through a visual Race Control Center UI — authoring the broadcast plan before the session, monitoring autonomous stream output during the session, and making deliberate overrides when needed.

These roles may be occupied by the same person in different moments, or by two separate individuals. The product accommodates both.

---

## 3. Problem Statements

**Problem A — No Real-Time Race Engineer**
A real race driver has an engineer on the radio synthesizing telemetry into actionable decisions: tire life, fuel window, competitor gaps, pit strategy. iRacing drivers make these calls alone, monitoring dashboards that pull their eyes off the track. There is no one processing data for them.

**Problem B — Post-Session Learning Is Shallow**
The data to understand why pace dropped, where lap time is being lost, or how a competitor's strategy beat yours all exists — but is inaccessible without engineering expertise. Drivers get a lap time and a delta bar. The deeper analysis never happens.

**Problem C — Car Setup Is Opaque**
Car setup is arcane. Most drivers start from a baseline with no idea whether it is appropriate for conditions, and have no in-context guidance on what to change or why.

**Problem D — Stream Management Is a Manual Distractor**
Switching OBS scenes, cycling cameras, capturing replays — these are tasks that pull the driver's hands and eyes away from racing at the worst possible moments.

**Problem E — Rich Data Goes Underused on Stream**
iRacing produces a continuous stream of telemetry and session data that could drive dynamic, engaging broadcast overlays. Most drivers display basic static elements. The data that viewers would find compelling — gap charts, tire strategy, competitor positions — is available but rarely surfaced.

**Problem F — Endurance Team Racing Has No Coordination Layer**
In a team endurance race, the driver in the car has full telemetry. Everyone else has degraded visibility. There is no purpose-built tooling for the pit wall role: coordinating driver swaps, modeling fuel on limited data, tracking competitor strategies, and communicating decisions to the team.

---

## 4. Design Principles

**Voice is for the moment; UI is for intent.** The Driver should never be asked to make editorial or strategic decisions through the UI while racing. Voice commands handle reactive, in-the-moment queries. The UI handles deliberate, pre-planned configuration.

**The engineer speaks when something matters.** The Racing Engineer is not an alert system. It is a trusted co-pilot — present, aware, and capable of conversation. It speaks proactively when the situation warrants it and responds concisely on demand. It does not narrate the race.

**The stream runs itself.** The Stream Engineer executes a pre-authored plan autonomously. The Operator monitors and can override, but is never required to intervene.

**Degrade gracefully, never crash.** If Redis is unavailable, the session continues normally and the engineering layer goes quiet. If OBS is unreachable, telemetry processing and data capture continue. If the inference service is down, rule-based fallbacks handle critical alerts.

**Collect data from day one.** Features like cross-session learning and community track zones require historical data. Data collection begins at v1 even when the features that consume it are deferred.

---

## 5. Interaction Models

### Voice (Driver, in-race)

Push-to-talk activation. The Racing Engineer speaks proactively when conditions warrant it (Tier 1 and Tier 2 alerts) and responds to driver queries on demand (Tier 3). Hotkeys and Stream Deck bindings allow common queries without speaking. All keybindings are user-defined.

### Broadcast Plan (Stream Operator, pre-session)

A structured configuration that governs the autonomous Stream Engineer for the duration of the session. Defines primary subjects, editorial style dimensions, contingency behaviors, and story annotations. Authored before the race begins; updated mid-session only through deliberate Operator action.

### Race Control Center (Stream Operator, during session)

A visual web UI served by the hub server, accessible from any device on the LAN — the Operator's laptop, a tablet, or a second monitor. Shows the live stream preview (via HLS), current race state, Stream Engineer activity log, and override controls.

### Post-Session Debrief (Driver, after session)

A UI-driven analysis interface built from session data stored in Postgres and supplemented by post-session data from the iRacing REST API. Lap comparison, sector analysis, engineer decision review, and fuel/tire model calibration.

### Discord (Team, endurance races)

The hub server posts to a team Discord channel during endurance events: stint summaries, competitor pit alerts, swap window recommendations, and next driver readiness prompts. Send-only via webhook. Operates from competitor-visible data when a team observer is the connected client.

---

## 6. Feature Areas

### 6.1 Racing Engineer — v1

The Racing Engineer is the voice of the application during a live session.

**Message delivery system**
A priority queue with a safe window gate governs when messages are delivered. Three tiers:

- _Tier 1 (immediate, gate-override):_ Fuel critical, blue flag, safety car deployed, pit limiter reminder. Template-based. Fires regardless of what the driver is doing.
- _Tier 2 (computed alerts, next safe window):_ Pit window opens, competitor pit entry/exit, gap threshold crossings, pace degradation trend. Template-generated from computed values.
- _Tier 3 (LLM-synthesized briefings, natural pauses):_ Pit lane entry briefing, safety car period briefing, on-demand driver queries, post-sector commentary.

A safe window is open when: lateral G is below threshold, throttle is open, and no significant brake input in the last 150 meters. Radio Blackout Zones (driver-configured per-track sections) suppress Tier 2/3 delivery regardless of the live signal.

**Fuel strategy**
The Fuel Model runs deterministically in the hub server. It operates at three fidelity levels depending on data availability: live driver data (rolling 5-lap burn rate average), blended with historical stint data (used during early-stint accumulation), or estimated from lap count and car class defaults (observer mode). The model is exposed to the LLM as a callable tool — the LLM does not perform fuel arithmetic.

**Tire monitoring**
The Tire Model tracks compound, lap age, sets remaining, and a pace degradation signal derived from each lap time versus the stint median. Three degradation states: nominal, watch, critical. Exposed to the LLM as a callable tool.

**Gap and battle tracking**
The Gap Model tracks relative gaps and closure rates between adjacent cars. Four battle states: open, closing, battle, resolved. Used by both the Racing Engineer (competitor alerts) and Stream Engineer (action scoring).

**Personality system**
Three configurable dimensions govern the engineer's character: Chattiness (message volume and length), Familiarity (tone and register), and Aggression (strategy philosophy). Adjustments around a calm, precise, slightly friendly default — not replacements for it.

**Driver override handling**
When a driver ignores a recommendation, the engineer records the override, stops advocating for the original recommendation, and optimizes for the driver's actual decision. Adaptive deference: if a driver consistently overrides across a session, the engineer shifts from recommendations to information presentation. Tier 1 safety alerts are never subject to adaptive deference.

**Session memory**
The engineer maintains context across the session: all recommendations made and whether the driver acted, override outcomes, and fuel model calibration updates. Cross-session learning is deferred to a future version (see Section 7).

---

### 6.2 Stream Engineer — v1

The Stream Engineer is the runtime execution layer for the Broadcast Plan.

**Cut model**
A shot queue with a hold gate governs when cuts are executed. Three tiers mirror the Racing Engineer structure:

- _Tier 1 (immediate):_ Red flag, safety car, hero car incident, hero car pit entry, race start.
- _Tier 2 (next cut window):_ Hero car pit exit, on-track battle emerging, position change, competitor pit event, dwell timeout, overlay trigger.
- _Tier 3 (ambient):_ Camera variety rotation, storyline graphic surfacing, between-action field coverage.

A cut window is open when: minimum dwell time has elapsed, no active overtake is in progress in the current shot, no unresolved incident is in frame, and the subject car is not in a configured cut-blackout zone.

**Camera selection**
Hero mode follows a primary subject list in priority order, maintaining camera variety by tracking the type of each recent cut (onboard, TV pod, trackside, blimp). General mode scores all active situations across the field by a defined rubric (active position change, closing gap, lead fight, final-lap weighting) and covers the highest-scoring action continuously.

**Production style dimensions**
Three configurable dimensions: Cut Rate (conservative / default / dynamic), Coverage Style (hero-focused / default / narrative), Editorial Aggression (reactive / default / anticipatory).

**Broadcast Plan**
Authored pre-session. Defines: broadcast type (hero or general), primary subjects with storyline annotations, watchability hints (expected pit stop duration, pre-race notes), and contingency behaviors (on hero car DNF: end broadcast, convert to general, or continue on secondary subject).

**Live Operator Signals**
Pushed mid-race to update the engineer's understanding of current state: hero car status (`active`, `in_repair`, `dnf`) with manual repair timer, storyline updates, and manual incident flags.

**Operator override handling**
On detecting an uninitiiated scene change in OBS, the Stream Engineer enters manual hold — it stops autonomous cuts and defers to the Operator. Manual hold expires after a configurable duration (default: 60 seconds) or on explicit Operator release. Tier 1 events override manual hold.

**OBS resilience**
Temporary OBS disconnects trigger exponential backoff reconnection. Sustained disconnects (30+ seconds) emit a UI alert. On reconnect, the engineer resyncs to current desired state rather than replaying the command history.

---

### 6.3 Broadcast Plan Editor — v1

A visual web UI for authoring the Broadcast Plan before a session. Covers:

- Broadcast type selection (hero / general)
- Primary subject configuration (car number, priority, storyline annotation)
- Production style dimension settings
- Contingency behavior selection
- Watchability hints (expected pit stop duration, pre-race notes)
- Saved plan management (create, copy, edit, delete)

---

### 6.4 Race Control Center — v1

The Operator's view during a live session. Accessible from any LAN device.

- Live stream preview via HLS embed
- Current race state panel (positions, gaps, flags, session phase)
- Stream Engineer activity log (cuts made, queue, manual hold status)
- Override controls (manual hold, resume autonomous operation)
- Live Operator Signal inputs (hero car status, storyline updates, incident flags)
- Racing Engineer activity log (messages delivered, queue, driver queries)

---

### 6.5 Post-Session Debrief — v1

Available after the session ends, built from Postgres session data and the iRacing REST API.

- Lap time chart with sector breakdown
- Fuel model vs. actual comparison
- Tire model degradation signal vs. pace chart
- Engineer decision log (all recommendations, driver responses, outcomes)
- Radio Blackout Zone editor (track map with message delivery markers, zone creation UI)

---

### 6.6 Team Observer Mode — v1

When a teammate is driving, connected clients transition from Driver to Team Observer. The Racing Engineer shifts from personal coaching to team strategy.

- Competitor-visible data: all cars' positions, lap times, pit entry/exit, tire compound
- Fuel strategy runs at Level 3 fidelity (estimated from lap count and car class defaults)
- Discord posting: stint summaries, competitor pit alerts, swap window recommendations
- Multi-client merging: if multiple team members are connected, the hub aggregates their data with driver-priority rules

---

### 6.7 Tauri Client Configuration — v1

Minimal UI for local settings:

- Audio device selection (input and output)
- Connection configuration (Redis URL, Whisper endpoint, hub server URL)
- Hotkey bindings (PTT, common query shortcuts)
- Telemetry logging opt-in toggle
- Live telemetry debug readout (variable values, connection status)
- Voice profile upload (reference audio clip for Chatterbox voice cloning)

---

## 7. Future Capabilities

These features are explicitly out of scope for v1. Data collection to support many of them begins at v1.

### Racing Engineer

**Cross-session learned preferences**
The engineer tracks override patterns and outcomes within a session. Extending this across sessions allows it to learn persistent driver tendencies — "this driver always extends stints 3 laps past the model" — and factor them into future recommendations. Requires a persistent driver profile store. Session-level data collection starts at v1.

**Community radio blackout zones**
Drivers configure blackout zones per track via the post-session UI. Aggregating zones across many drivers on the same track produces a community-generated default map for new drivers. Zones could be exported and imported as JSON.

**Adaptive deference score as a visible metric**
The engineer's adaptive deference behavior (shifting from recommendations to questions when the driver consistently overrides) currently happens automatically. Surfacing this as a visible, resettable metric gives drivers visibility into the relationship dynamic and control over it.

**Car setup awareness**
If setup parameter values can be read from iRacing setup XML files on disk, the engineer could reference setup context in strategy and coaching advice. Requires POC validation (see POCs.md).

**IBT-based racing line analysis**
`Lat`/`Lon`/`Alt` variables are available in `.ibt` disk files (not the live SDK stream). A near-real-time post-stint analysis pipeline reading IBT files could quantify lateral distance from the ideal line and identify corner-by-corner improvement opportunities. Requires POC validation of pipeline viability and coordinate accuracy.

### Stream Engineer

**Full Stream Deck plugin**
A proper Stream Deck plugin with dynamic button labels showing live race data (current fuel level, gap to position, session phase). Deferred pending validation that the current hotkey-based approach is insufficient.

**Extended broadcast type library**
Rivalry streams (two competing subjects with equal weight), team streams (driver rotation coverage across a team's full entry list), class-specific broadcasts (ignoring cars outside a target class). Natural evolutions of the current hero/general dichotomy.

**Live plan versioning**
The ability for an Operator to update the static broadcast plan mid-race and have the Stream Engineer reconcile the updated plan with decisions already made. Currently, mid-race plan changes require pushing Live Operator Signals; the plan itself is static once the session begins.

**Live signal history and replay**
Retaining a log of all Live Operator Signals for post-race review. Has implications for coaching use cases — understanding what the Operator knew and when.

### Post-Session Debrief

**Sector-by-sector coaching**
Lap time analysis broken down to individual sectors, with AI-generated commentary identifying where time is being lost or gained relative to personal best and competitor times.

**Multi-session trend analysis**
Pace, fuel burn, and tire degradation trends compared across sessions at the same track with the same car. Requires sufficient historical data accumulation.

**Setup correlation analysis**
If setup parameter data is accessible (see car setup POC), correlate setup changes with pace trends across sessions. Requires structured setup data storage alongside session records.

### Team & Endurance

**Discord bot integration**
A bidirectional Discord bot allowing team members to query the app via Discord commands (e.g., `!fuel`, `!gap P3`, `!stint`). Extends the current send-only webhook integration. Deferred because webhooks cover all stated v1 use cases.

**Pit wall coordination screen**
A dedicated UI view for the non-driving team observer during endurance events: driver swap countdown, stint history, cross-stint fuel model, competitor strategy tracker. Currently these are surfaced through Discord posting and the standard Race Control Center.

**Team stint planning pre-session tool**
A pre-race fuel and driver stint planner: input total race time, tank capacity, driver roster, and target pit windows; output a stint plan with swap windows and fuel targets per stint. Could seed the Fuel Model's observer-mode estimates before a race begins.

---

## 8. Out of Scope

- **Replacing OBS.** OBS remains the stream engine. This application coordinates it, not replaces it.
- **Producing a real-time telemetry dashboard for the driver to watch while racing.** That is the problem being solved against.
- **Starting or stopping the stream.** Stream lifecycle is always an explicit Operator action.
- **Audio routing or mixing.** No OBS audio sources are modified by the Stream Engineer.
- **Viewer engagement data.** No Twitch, YouTube, or chat API is queried during a session. Coverage decisions are based on race state only.
- **Real money or competitive integrity tools.** No integration with iRacing's penalty system, protest system, or official league infrastructure.

---

## 9. Open Questions

These questions are unresolved and have downstream implications for design or implementation.

**Broadcast type extensibility** — rivalry streams, team streams, and class-specific broadcasts are natural evolutions of the current hero/general dichotomy. How are new types defined and what fields do they introduce? Should be resolved before the Broadcast Plan Editor UI is designed, as broadcast type selection is likely the first authoring decision an Operator makes.

**Subject list upper bound** — is there a practical limit to how many primary subjects a hero broadcast can have before it functionally becomes a general broadcast? Worth defining a soft ceiling for authoring UX purposes.

**Live Operator Signal history** — does the engineer retain a log of live signals for post-race review, or are they ephemeral? Has implications for the debrief coaching use case.

**Personality knob effectiveness** — the three-dimension personality system (Chattiness, Familiarity, Aggression) requires POC validation. Does a parameterized prompt template produce meaningfully different and consistent behavior across the knob range, or do edge values produce degenerate outputs? Does "Aggression" (strategy philosophy) produce measurably different pit recommendations?

**Safe window detection accuracy** — the three-signal heuristic (lateral G + throttle + brake history) requires real-session testing across a range of track types. False positives in sweeping high-speed sections and false negatives in low-speed technical sections need to be characterized before the thresholds are considered stable.

**Tier 3 latency budget** — LLM-synthesized Tier 3 briefings require a round-trip to the inference service. The end-to-end target for the voice pipeline is under 5 seconds from PTT release. For proactive Tier 3 briefings (pit lane entry, safety car), latency is acceptable because the trigger point arrives before the message is needed. For on-demand driver queries, the full inference round-trip must fit within the driver's patience window. This needs to be characterized in a POC before the interaction model is finalized.

**Car setup data accessibility** — the iRacing SDK exposes the setup name and modification state but not setup values. Whether values can be read from XML files in `Documents/iRacing/setups/` and what their format looks like needs POC validation before any setup-aware features are designed.
