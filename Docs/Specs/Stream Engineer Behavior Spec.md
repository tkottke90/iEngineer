# Stream Engineer Behavior Spec

## Purpose

This document defines how the Stream Engineer behaves during a live session — when it cuts, what it covers, how it responds to race events, and how its behavior adapts to the Operator's configuration. It is the authoritative reference for the Stream Engineer's decision-making model.

The Stream Engineer is the runtime execution layer for the Broadcast Plan. This document describes _how_ it reasons and acts; what it has to work with is defined in the Broadcast Plan Schema.

---

## Mental Model: The Director with a Plan

The Stream Engineer is not a camera operator. A camera operator reacts to what is visible in front of them. The Stream Engineer reads a broadcast plan, understands the editorial intent, and executes decisions that serve the audience — not just the race.

This distinction has practical consequences:

- It makes cuts when they serve the viewer, not just when something is happening
- It maintains shot variety across a session, not just during exciting moments
- It follows a pre-authored story with known priorities, and only departs from it when the race demands it
- It treats dull periods of racing as an opportunity to surface data, not as gaps to fill with random camera changes

The Stream Engineer's default disposition is **deliberate, varied, and story-aware**. It does not cut frantically. It does not hold a single shot so long that the broadcast becomes static. When it makes an editorial decision, it makes it cleanly and commits to it.

---

## The Cut Model

### Core Concept: Shot Queue with a Hold Gate

Potential cuts accumulate in a priority queue as race events unfold. A hold gate governs when a cut is executed. Cuts in the queue wait until the gate opens — except Tier 1 cuts, which override the gate immediately.

This means the Stream Engineer is not purely reactive. A Tier 2 event (a competitor pitting) does not interrupt a clean shot of the hero car's best lap of the race. It waits. If the event is still relevant when the gate opens, the cut happens. If it has resolved in the meantime, the queued cut is discarded.

### Priority Tiers

**Tier 1 — Immediate, hold-gate override**

These cuts fire the moment the condition is confirmed, regardless of the current shot. No delay.

- Red flag declared
- Safety car deployed
- Hero car incident (confirmed spin, crash, or car stopped on track)
- Hero car pit entry (cut to pit lane as the hero car crosses the pit road entry line)
- Race start (formation lap begins)

**Tier 2 — Event-driven, executed at next cut window**

These fire as soon as the hold gate opens after the condition is detected. They represent things worth showing that do not justify breaking the current shot.

- Hero car pit exit (car rejoining from pit lane)
- On-track battle emerging — any two cars within a closing gap threshold, ordered by relevance to the hero or field position
- Hero car position change (gaining or losing a place)
- Competitor pit entry or exit relevant to hero car strategy
- Camera dwell timeout — current shot has exceeded its maximum configured hold time
- Overlay display trigger — a data graphic is queued to appear on screen

**Tier 3 — Ambient, executed at natural editorial breaks**

These have no specific event trigger. They represent the default editorial work of maintaining a watchable broadcast between action moments.

- Camera variety rotation (switching between onboard, TV pod, blimp, trackside during normal racing)
- Storyline graphic surfacing (displaying a pre-authored annotation when an appropriate moment arrives)
- Between-action field coverage (showing competitors, track conditions, or background action)

---

## Cut Window Detection

A cut window is the moment when making a cut serves the audience rather than disrupting them. The hold gate opens when **all** of the following are true:

1. **Minimum dwell time has elapsed.** The current shot has been held for at least the configured minimum. Default: 8 seconds for standard shots; 4 seconds for reactive post-incident cuts. Prevents visual churn.

2. **No active overtake is in progress in the current shot.** Two cars occupying positions close enough that a pass is in progress or imminent — defined by relative track position delta decreasing below a threshold — lock the current shot until the position change resolves or the gap stabilizes.

3. **No unresolved incident is in frame.** A car that has spun, gone off, or stopped holds the camera until the situation resolves: the car returns to racing, retires, or is obscured by field position.

4. **Current subject is not at a critical track section.** Optionally gated by the subject car's telemetry: if the subject car is in a hard braking zone or complex corner sequence, delay the cut until they are clear. This is the broadcast equivalent of the Racing Engineer's safe window. Authoring: per-track blackout zones can suppress cuts during specific lap completion ranges, configured post-session in the same track map UI used for Radio Blackout Zones.

When a Tier 2 event is queued and the gate does not open within a configurable maximum wait time (default: 30 seconds), the queued cut is executed anyway, gate condition overridden. Staleness beats continuity.

---

## Camera Selection Logic

### Hero Mode

In a hero broadcast, coverage follows the primary subject list. The Stream Engineer always knows where the hero car is and routes coverage accordingly.

**Hero car racing actively:**

Select from the available camera groups for the subject car. Maintain camera variety by tracking the type of each cut made in the last N minutes and weighting against recently used types. Camera type target durations:

| Camera type              | Target dwell          |
| ------------------------ | --------------------- |
| Onboard (in-car)         | 15–30 seconds         |
| TV pod (exterior follow) | 20–40 seconds         |
| Trackside (fixed angle)  | 10–20 seconds         |
| Blimp / overhead         | 30–60 seconds         |
| Pit lane overhead        | Hold through pit stop |

These are targets, not enforcements. A particularly clean lap or an active battle overrides the dwell timer.

**Hero car pitting:**

On Tier 1 pit entry trigger, cut immediately to the pit lane camera assigned to the hero car's box. Hold through the entire stop. On pit exit, wait for the hero car to clear pit road before resuming normal coverage — this is the expected Tier 2 pit exit cut. Do not cut away to field coverage during the pit stop unless the stop is confirmed complete and the car is being serviced without incident.

**Hero car temporarily off-camera (garage, extended repair, retirement):**

Enter roaming mode. In roaming mode, select coverage based on general mode logic (see below). The Broadcast Plan's contingency behavior governs what happens on a confirmed DNF — roaming is for ambiguous unavailability, not permanent retirement.

**Multiple hero subjects:**

When two or more primary subjects are active simultaneously, cover them in priority order. Give the lower-priority subject a minimum periodic coverage window (configurable, default: 20% of total coverage time), rather than abandoning it entirely for extended periods.

**Brief competitor cuts:**

The Stream Engineer may cut to a relevant competitor for up to one camera hold if the hero car is in a low-drama section (long straight, no battle) and the competitor moment is time-limited (pit exit, a fast lap, a position change). On cut window, return to hero coverage. This is editorial variety, not mode change — it does not trigger roaming mode.

---

### General Mode

In a general broadcast, there is no primary subject. The Stream Engineer scores active situations across the field and covers the highest-value action continuously.

**Action scoring (higher score = higher priority):**

| Situation                                           | Score                        |
| --------------------------------------------------- | ---------------------------- |
| Active position change in progress                  | 100                          |
| Gap between adjacent cars < 1.0s and closing        | 80                           |
| Gap between adjacent cars < 1.0s, stable            | 50                           |
| Car on new outlap after pit (strategy play visible) | 40                           |
| Lead fight (P1 and P2 within 3 seconds)             | 70 (additive)                |
| Final 5 laps of the race                            | +30 to all active situations |
| Car involved in recent incident, now recovering     | 30                           |

When multiple situations are active simultaneously, the highest-scoring situation is covered. Re-score on each telemetry tick. If the top-scored situation changes while the hold gate is closed, queue the new situation as a Tier 2 cut for the next window.

**Tie-breaking:** When two situations have equal scores, prefer the one involving higher championship position (P1 fight over P4 fight). If position is equal, prefer the situation involving more cars.

---

## Simultaneous Event Handling

When multiple events fire in the same telemetry tick or within a short window of each other, resolve them in the following order:

1. **Higher tier wins unconditionally.** A Tier 1 event overrides any queued Tier 2 or Tier 3 cuts.

2. **Within Tier 1:** Safety car and red flag override hero car incidents. Both are session-level events that redirect the entire broadcast. Hero car incidents fire before unrelated field events.

3. **Within Tier 2 in hero mode:** Hero car events beat competitor events. A hero car pit exit queued simultaneously with a competitor battle covers the hero car first.

4. **Within Tier 2 in general mode:** Use action score. Higher score is queued first. Ties broken by field position (higher position preferred).

5. **Tier 2 and Tier 3 conflict:** Tier 2 always wins. Tier 3 ambient cuts are discarded when a Tier 2 event is queued.

6. **Dwell timeout vs. event:** A queued event takes priority over a camera variety rotation triggered by dwell timeout. The variety rotation is discarded; the event cut happens instead.

When more than two Tier 2 events pile up in the queue (e.g., multiple cars pit simultaneously), execute the highest-priority cut first, then reassess. Some events will be stale by the time their turn arrives — discard any queued cut whose triggering condition has already resolved.

---

## Production Style

The Stream Engineer's behavior is governed by three configurable dimensions. These are editorial preferences set by the Operator before the session, not in-race adjustments.

### Dimensions

**Cut Rate** — controls how frequently the Stream Engineer changes shots

- Conservative: Longer minimum and target dwell times. Fewer total cuts per hour. Appropriate for relaxed commentary or solo-driver audiences who prefer a stable feed.
- Default: Standard dwell ranges as documented above. Balances variety with continuity.
- Dynamic: Shorter minimum dwell times. More frequent cuts between camera types. More aggressive use of Tier 3 rotations during quiet periods. Appropriate for highlight-style or esports-adjacent broadcasts.

**Coverage Style** — controls how tightly the broadcast follows the primary subject in hero mode

- Hero-focused: Stays on the primary subject except for Tier 1 forced cuts and explicit competitor pit events. Minimal brief competitor cuts. Roaming only when hero car is genuinely unavailable.
- Default: Follows the primary subject as the anchor but weaves in brief competitor cuts during low-drama hero sections. Surfaces relevant field context without losing the thread.
- Narrative: Treats the broadcast as a story with multiple characters. More time on competitors and rival storylines. Returns to hero regularly but is willing to let a compelling competitor moment run longer before cutting back.

**Editorial Aggression** — controls how the Stream Engineer responds to anticipated vs. confirmed events

- Reactive: Cuts only to confirmed events (position change complete, car confirmed on pit road). No speculative coverage.
- Default: Cuts to developing situations (gap closing, car approaching pit entry zone). Acts on high-probability signals before the event is fully resolved.
- Anticipatory: Positions coverage for expected events based on pit window predictions and strategy inference. May cut to a competitor car expected to pit before they enter pit road, holding for the confirmation.

---

## Operator Override Handling

### Detecting an Override

The Stream Engineer monitors OBS scene and source state via WebSocket subscriptions. If the active scene changes in a way that was not initiated by the Stream Engineer, it detects an Operator override.

### Manual Hold

On detecting an override, the Stream Engineer enters a **manual hold**: it stops queuing and executing autonomous cuts. The Operator has taken the wheel; the Stream Engineer moves aside.

Manual hold duration:

- Default: 60 seconds from the last detected Operator action
- Configurable per session in the broadcast plan
- Can be explicitly ended by the Operator via UI ("Resume Engineer control")

During manual hold, the Stream Engineer continues processing telemetry and maintaining its internal state. It is not idle — it is watching and ready to resume.

### Tier 1 Override of Manual Hold

A Tier 1 event — safety car, red flag, hero car incident — overrides the manual hold and executes an immediate cut. After the Tier 1 condition resolves, the Stream Engineer returns to manual hold if the hold period has not expired. The Operator remains in control of routine coverage.

### Resuming Autonomous Operation

When manual hold expires or the Operator explicitly hands back control, the Stream Engineer resumes from its current internal state. It reassesses the queue, discards stale cuts, and picks up from the highest-priority active situation.

---

## OBS Unreachable

### Connection States

**Connected** — normal operation. All cuts execute immediately.

**Temporarily unreachable** — the WebSocket ping has timed out but the connection has not been down long enough to classify as sustained. The Stream Engineer:

- Continues processing telemetry and maintaining its shot queue
- Attempts reconnection on exponential backoff (starting at 1 second, capped at 15 seconds)
- Logs each reconnection attempt
- Does not emit a UI alert unless the condition persists past the sustained threshold

**Sustained unreachable** (default: more than 30 seconds without a connection) — the Stream Engineer:

- Emits an alert to the web UI
- Continues processing telemetry and tracking race state
- Stops queuing intended OBS actions (stale commands issued to OBS after reconnect would disrupt whatever the Operator has set manually in the meantime)
- Logs the gap

**On reconnect** — the Stream Engineer:

- Resyncs OBS to the current desired state (correct scene for current race situation) rather than replaying the command history
- Resumes normal operation
- Clears the UI alert

### What the Stream Engineer Does Not Do During OBS Outage

It does not stop. Telemetry processing, race state tracking, overlay data computation, and Discord bridge operation all continue normally during an OBS outage. The Stream Engineer's inability to reach OBS is a presentation failure, not a data failure.

---

## Session Memory

The Stream Engineer tracks state across the session to improve the quality of its decisions:

**Camera variety tracking** — a rolling window of the camera types used in the last 10 cuts, used to weight against repetition in camera selection. Prevents a broadcast that alternates between the same two camera types for 90 minutes.

**Storyline graphic history** — which pre-authored storyline annotations have been surfaced as overlays during the session, and when. Prevents the same graphic from reappearing too frequently. A storyline that has already been shown once is eligible for a second display only after a configurable cooldown (default: 20 minutes).

**Competitor coverage log** — which competitor cars have received coverage cuts in the current session and when. Used to ensure that roaming and general mode coverage does not fixate on one secondary car to the exclusion of the field.

**Operator override history** — timestamps and duration of manual holds, used to understand how much of the session the Operator has managed manually. This data is available for post-session review.

**Active situation cooldown** — a situation (e.g., a specific two-car battle) that has already been featured and resolved is deprioritized in the action score for a configurable period (default: 5 minutes). Prevents the broadcast from repeatedly returning to the same moment.

---

## What the Stream Engineer Does Not Do

- **Start or stop the stream.** Stream lifecycle is always an explicit Operator action. The Stream Engineer never calls `StartStream` or `StopStream` on the OBS WebSocket.

- **Manage OBS recording.** Recording is outside the Stream Engineer's scope. It does not start, stop, or segment recordings.

- **Control audio routing or mixing.** No OBS audio sources are modified by the Stream Engineer. It does not mute, unmute, or adjust levels on any source.

- **Render graphics.** The Stream Engineer hosts HTTP endpoints that OBS browser sources pull from. It does not push rendered frames into OBS. Overlay content is rendered by the browser source from data the Stream Engineer exposes, not produced by the Stream Engineer directly.

- **Modify the broadcast plan mid-session.** The static broadcast plan is authored before the race begins. Changing it during a session requires an explicit Operator action in the UI — the Stream Engineer does not rewrite its own configuration.

- **Make coverage decisions based on viewer engagement data.** No Twitch or YouTube API is queried during a session. The Stream Engineer has no awareness of viewer count, chat activity, or audience response. Its editorial decisions are based on race state only.

- **Predict or speculate on race outcomes.** The Stream Engineer acts on confirmed telemetry and computed strategy signals. It does not editorialize on who will win or make coverage decisions based on championship standings outside of the configured action scoring weights.

- **Attempt to restart OBS.** If OBS is unreachable, the Stream Engineer logs the failure, alerts the Operator, and waits. It does not attempt to launch or recover OBS processes.

- **Override Operator manual holds for anything below Tier 1.** An Operator who has taken manual control of the broadcast retains it until the hold expires or they release it. The Stream Engineer does not reassert autonomous control during a Tier 2 or Tier 3 situation regardless of how compelling the action is.

- **Speak or produce audio.** The Stream Engineer controls scenes, cameras, and overlays. Voice output is owned by the Racing Engineer. The Stream Engineer has no voice interface and does not call the TTS service.
