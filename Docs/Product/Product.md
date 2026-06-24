# Product Brief: iRacing Engineer

## The Core Problem

Sim racing demands 100% cognitive focus, but the driver-who-streams is simultaneously expected to race, manage a broadcast, make live strategy decisions, and learn from their data. Every tool that pulls the driver's eyes off the track or hands off the wheel is a liability.

**The product's job is to return the driver's attention to the task of racing.**

---

## Target User

**The driver-who-streams** — a sim racer who broadcasts their sessions live. They are both the subject of the broadcast and its producer. They may race solo or as part of a team endurance effort.

---

## Problems We Are Solving

### Problem A — No Real-Time Race Engineer
A real race driver has an engineer on the radio synthesizing telemetry into actionable decisions: tire life, fuel window, competitor gaps, pit strategy. iRacing drivers make these calls alone, monitoring dashboards that pull their attention away from driving. There is no one processing the data for them.

### Problem B — Post-Session Learning Is Shallow
The data to understand *why* your pace dropped, where lap time is being lost, or how a competitor's strategy beat yours all exists — but it is inaccessible without engineering expertise. Drivers get a lap time and a delta bar. The deeper analysis never happens.

### Problem C — Car Setup Is Opaque
Car setup is arcane. Most drivers start from a baseline with no idea whether it is appropriate for conditions, and have no in-context guidance on what to change or why.

### Problem D — Stream Management Is a Manual Distractor
Switching OBS scenes, cycling iRacing cameras, capturing replays — these are tasks that pull the driver's hands and eyes away from racing. A driver managing their own stream is context-switching at the worst possible moments.

### Problem E — Rich Data Goes Underused on Stream
iRacing produces a continuous stream of telemetry and session data that could drive dynamic, engaging broadcast overlays and widgets. Most drivers display basic static elements. The data that viewers would find compelling — gap charts, tire strategy, competitor positions — is available but rarely surfaced effectively.

### Problem F — Endurance Team Racing Has No Coordination Layer
In a team endurance race, the driver in the car has full telemetry. Everyone else has degraded visibility — the same competitor-level data available for any other car on track. There is no purpose-built tooling for the pit wall role: coordinating driver swaps, modeling fuel on limited data, tracking competitor strategies across long stints, and communicating decisions to the team.

---

## Two Users

These may be the same person in different roles, or two separate individuals.

**The Driver**
- Primary user during a session
- Voice-first interaction model while racing
- Uses the UI for pre-session planning and post-session debrief
- Never asked to manage the stream while driving

**The Stream Operator**
- May be the driver between stints (Team Observer Mode) or a dedicated co-pilot
- UI-first interaction model
- Monitors the autonomous stream output and can make deliberate overrides
- Manages the broadcast plan before and during the session (when not driving)

---

## Core Design Principle

**Voice commands are for reactive, in-the-moment decisions. The UI is for deliberate, pre-planned configuration.**

The driver should never be asked to make editorial broadcast decisions while racing. The stream runs autonomously against a pre-authored broadcast plan. Adjustments are made through the UI — either before the session or by a Stream Operator who is not currently driving.

---

## Interaction Models

### Voice (Driver, in-race)
The Racing Engineer speaks proactively when something matters — fuel window, competitor pit stop, gap change — and responds to short commands on demand. Hotkeys and Stream Deck bindings allow the driver to trigger common queries (e.g. "what's my gap to P3?") without speaking. All keybindings are user-defined, following patterns already familiar from sim racing and streaming tooling.

### Broadcast Plan (Stream Operator, pre-session)
A structured configuration that governs the autonomous Stream Engineer during a session. Defines:
- Expected scene transitions and triggers (e.g. enter/exit pits, gap closes to under 1 second)
- Camera cycling behavior and frequency
- Overlay display rules (what data to show, how often, under what conditions)
- Whether the broadcast follows a single driver or a team

### UI (Both users, pre/post-session and during gaps)
A visual interface for planning, monitoring, and reviewing. Used to build the broadcast plan, configure the Racing Engineer, review post-session analysis, and monitor the live stream output. Also serves as the Stream Control Center for the Stream Operator during a session.

### Discord (Team, endurance races)
The Racing Engineer posts to a team Discord channel during endurance events: stint summaries, competitor pit alerts, swap window recommendations, next driver readiness prompts. Operates from the data available in Team Observer Mode — competitor-visible lap times and pit entry/exit events, not full telemetry.

---

## Team Observer Mode (Problem F)

When a teammate is driving, the connected user transitions from Driver to Team Observer. Telemetry degrades to competitor-level visibility: position, lap times, pit road entry/exit. The Racing Engineer shifts from personal coaching to team strategy: modeling fuel on observable lap counts, tracking competitor pit cycles, and coordinating via Discord.

If multiple team members run the client simultaneously, the system aggregates their telemetry into a more complete picture. The application degrades gracefully when not all team members are connected — it functions at reduced capacity rather than failing.

---

## What This Is Not

- A replacement for dedicated broadcast software (OBS remains the stream engine; this coordinates it)
- A real-time telemetry dashboard for the driver to watch while racing (that is the problem we are solving against)
- A tool that asks the driver to manage their stream mid-race
