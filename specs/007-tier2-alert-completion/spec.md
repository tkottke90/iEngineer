# Feature Specification: Tier 2 Alert Completion — Competitor Pit, Gap, and Pace Alerts (+ Weather Telemetry Passthrough)

**Feature Branch**: `007-tier2-alert-completion`

**Created**: 2026-07-10

**Status**: Draft

**Input**: User description: "Create a spec for the Tier 2 alert gap identified in the roadmap review: the five Tier 2 alert rules deferred from M4 to M5 (competitor pit entry/exit, gap closing/pulling away, pace degradation) were never implemented — they are still null stubs."

## Context

M4 (spec 004) delivered the Racing Engineer's rule-based alert system with four Tier 1 rules and one active Tier 2 rule (pit window open). Five additional Tier 2 rules were specified in M4's alert-rules contract but explicitly deferred: competitor pit entry, competitor pit exit, gap closing, gap pulling away, and pace degradation. M5 never picked them up; they remain stubs that produce no alerts. This feature activates the alerts built on the race state engine (M3): competitor pit and pace degradation alerts consume events it already publishes, and gap alerts are computed from the live race state it maintains. It completes the Tier 2 catalog the roadmap describes for M4 and is the last rule-based Racing Engineer work before the Stream Engineer milestones. (Terminology: this spec says "driver"; the code and design artifacts call the same car the "hero" — they are the same concept.)

## Clarifications

### Session 2026-07-10

- Q: Which session phases should the new Tier 2 alerts be active in? → A: No phase gating — alerts fire in any phase where the triggering events occur (caution suppression for gap alerts still applies).
- Q: How should alternating closing/pulling-away chatter be prevented when a gap oscillates around the threshold? → A: Hysteresis margin — closing fires below the threshold; widening fires only above threshold + margin (default 0.5s); each re-arms on crossing the opposite boundary.
- Q: When multiple relevant rivals pit on the same lap, how should the burst be handled? → A: Coalesce into a single summary announcement rather than queueing per-car alerts.
- Q (analysis remediation, same day): Should gap alerts fire for a position-adjacent car of a different class in multiclass sessions? → A: Same class only — a cross-class adjacent car is not a battle candidate and that direction is not evaluated.
- **Scope addition (project owner, same day)**: live weather telemetry passthrough for the stream overlay, added as User Story 4 (design in plan.md §Weather telemetry passthrough). Q: Current conditions or forecast? → A: Current conditions only — iRacing's session forecast lives behind the authenticated web Data API (a cloud dependency, Principle IV tension); forecast is explicitly out of scope for this feature.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Competitor Pit Stop Awareness (Priority: P1)

While racing, the driver hears an announcement when a strategy-relevant rival — a car near the driver's position in the same class — enters or exits the pits, including which car it is and its position. The driver uses this to time their own stop (undercut/overcut) without taking their eyes off the track.

**Why this priority**: Pit timing relative to direct rivals is the single highest-value strategy input a race engineer provides during a stint. It is also the alert drivers most obviously miss today — a rival can pit and gain track position with the driver none the wiser until the pit cycle completes.

**Independent Test**: Can be fully tested by replaying or simulating a session in which a car within the relevance window pits and a car outside the window pits — the first produces an announcement, the second does not.

**Acceptance Scenarios**:

1. **Given** a race session with the driver in P8 and the relevance window at ±3 class positions, **When** the car in P6 (same class) enters the pits, **Then** the engineer announces the pit entry with that car's number and position within the Tier 2 delivery budget.
2. **Given** the same session, **When** the car in P2 (same class, outside the window) enters the pits, **Then** no announcement is made and the suppression is recorded with a reason.
3. **Given** a rival within the window has just been announced entering the pits, **When** that rival exits the pits, **Then** the engineer announces the pit exit with the car's number and its position after the stop.
4. **Given** a rival's pit entry has been announced, **When** no new pit entry occurs for that car, **Then** the announcement is not repeated — one announcement per car per pit visit.
5. **Given** three rivals within the window enter the pits on the same lap, **When** the alerts are pending together, **Then** the engineer delivers a single combined announcement covering all three (e.g., naming the cars, or the count when more than two) instead of three separate messages.

---

### User Story 2 - Battle Proximity Awareness (Priority: P2)

The driver hears when a gap in one of their own battles crosses the attention threshold: a car behind closing in, the driver closing on the car ahead, or the driver breaking away from / losing touch with a battle. Announcements state the gap and the direction so the driver knows whether to defend, attack, or manage pace.

**Why this priority**: Gap awareness changes how the driver spends their tires and fuel lap by lap. It is second to pit awareness only because the driver has partial awareness of nearby cars from mirrors and relative screens; pit stops behind them are fully invisible.

**Independent Test**: Can be tested by simulating gap trajectories around the configured threshold for pairs involving the driver and pairs not involving the driver — only driver-involved crossings produce announcements.

**Acceptance Scenarios**:

1. **Given** a car behind the driver closing steadily, **When** the gap first drops below the configured threshold, **Then** the engineer announces the closing gap and that it is the car behind.
2. **Given** the driver closing on the car ahead, **When** the gap first drops below the threshold, **Then** the engineer announces the gap to the car ahead.
3. **Given** a battle in which a closing alert has previously fired and the driver is now pulling away, **When** the gap first grows beyond the threshold plus the hysteresis margin (default 2.0s + 0.5s), **Then** the engineer confirms the driver is breaking away.
4. **Given** a closing alert has fired, **When** the gap oscillates between the threshold and the threshold-plus-margin boundary (the dead band) for several laps, **Then** no further gap announcement of either direction is made.
5. **Given** the gap opens beyond the threshold-plus-margin boundary and later drops below the threshold again, **When** the second closing crossing occurs, **Then** a new closing announcement is made (each direction re-arms when the gap crosses the opposite boundary).
6. **Given** two other cars battling elsewhere in the field, **When** their gap crosses the threshold, **Then** no announcement is made.
7. **Given** a caution / safety car period is active, **When** gaps compress below the threshold, **Then** no gap announcements are made and the suppression is recorded with a reason.

---

### User Story 3 - Tire Pace Degradation Warning (Priority: P3)

The driver hears a warning when their own pace degradation signal worsens — first when tires move into the "watch" state, and again if they reach "critical" — so they can adjust driving style or bring their pit stop forward.

**Why this priority**: Valuable, but the degradation signal builds over several laps and the driver often feels the car going off before the model confirms it. It is a confirmation-and-quantification alert rather than new information, so it ranks below the two alerts that reveal invisible information.

**Independent Test**: Can be tested by driving (or replaying) a long stint until the tire model's classification transitions from nominal to watch and then to critical — each transition produces exactly one announcement.

**Acceptance Scenarios**:

1. **Given** the driver's tire degradation classification is nominal, **When** it transitions to "watch", **Then** the engineer announces that pace is starting to drop.
2. **Given** the classification is "watch", **When** it transitions to "critical", **Then** the engineer announces the critical pace loss.
3. **Given** a "watch" announcement has been made, **When** the classification remains "watch" on subsequent laps, **Then** no repeat announcement is made.
4. **Given** a degradation warning has fired, **When** the driver pits for fresh tires and the classification returns to nominal, **Then** the alert re-arms and a later degradation in the new stint is announced again.

---

### User Story 4 - Live Weather for the Stream Overlay (Priority: P4)

A stream viewer sees the session's actual weather — air and track temperature, wind, sky state, precipitation, fog — on a broadcast overlay. The overlay (an OBS browser source outside this repo) polls the hub's race-state endpoint; the hub reports the sim's current conditions in both driver and observer sessions.

**Why this priority**: Display-only passthrough with no alert or strategy value, so it ranks below the three alert stories in product terms — but it serves a dated external commitment (an upcoming live stream) and is fully independent of the alert work, so it may be *scheduled* first (tasks.md "Live-Stream Fast Path").

**Independent Test**: Unit tests for the telemetry→state mapping pass standalone; end to end, `GET /api/race-state` during any session (observer mode suffices) shows live, non-placeholder weather values that track the in-sim conditions display.

**Acceptance Scenarios**:

1. **Given** a session in progress with the collector publishing session telemetry, **When** the race-state endpoint is polled, **Then** `session.weather` carries the sim's current air temperature, track temperature, humidity, wind speed and direction, sky state, precipitation, and fog level — not the pre-session placeholder.
2. **Given** the sim's sky state changes, **When** the next session-telemetry frame is processed, **Then** the reported sky state maps to exactly one of `Clear`, `PartlyCloudy`, `MostlyCloudy`, `Overcast` (an out-of-range raw value reports `Clear`).
3. **Given** a session-telemetry frame that carries no weather fields (an older collector build), **When** it is processed, **Then** the previously reported weather values are preserved unchanged — never regressing to the placeholder mid-session.
4. **Given** an observer (spectator) session with no hero car, **When** session telemetry flows, **Then** weather populates identically — the weather variables are global sim state, not driver-gated.

---

### Edge Cases

- **Pit cycle burst**: several relevant rivals pit on the same lap. Pending pit announcements of the same kind (entries, or exits) are coalesced into a single combined announcement rather than delivered as separate messages; the existing 30-second no-safe-window drop remains the delivery backstop, and any alert it discards is logged with a reason.
- **Driver in the pits**: gap alerts are suppressed while the driver is on pit road — and likewise while the position-adjacent car is on pit road (FR-007) — gaps involving a pitting car are not meaningful battle information.
- **Missing car identity**: if the car number or position for a competitor cannot be resolved at announcement time, the alert is skipped with a logged reason — the engineer never announces a placeholder ("Car unknown").
- **Single-class session**: when class information is unavailable or the session is single-class, the relevance window falls back to overall running position.
- **Gap direction**: the same boundary crossing means different things depending on whether the driver is the leading or trailing car in the pair; the announcement wording must make the direction unambiguous.
- **Gap oscillation**: a gap hovering between the closing threshold and the widening boundary (threshold + margin) sits in the dead band and produces no announcements in either direction until it exits the band.
- **Lapped-scale gaps**: a running-order gap on the scale of a full lap (the adjacent car is effectively lapping or being lapped) is not a battle and produces no gap alerts — the design treats it like an absent adjacent car (cutoff quantified in data-model.md: gap > 0.8 × the driver's estimated lap time, 72s fallback).
- **Already close at first sight**: at the green flag, or immediately after an overtake changes who the adjacent car is, the gap may already be under the threshold. No closing alert fires until that gap has first been observed at or above the threshold (prevents green-flag and post-pass noise; see FR-004). The same applies in the widening direction: if that already-close gap simply opens past the widening boundary, no breaking-away announcement is made either — widening arms only after a closing alert has fired (FR-005).
- **Stale trigger**: if an alert is still queued when its condition is no longer current (e.g., gap alert held through a long blackout zone), it is delivered at the next safe window per existing Tier 2 behavior; delivery values reflect the state at trigger time and the delay is bounded by the existing queue behavior.
- **Session phase**: no phase gating — all five alerts are active in any session phase where their triggering events occur (confirmed decision, session 2026-07-10); the only phase-related suppression is the caution-period rule for gap alerts.
- **Weather-less telemetry frame**: a frame from an older collector build carries no weather fields; the previously reported weather is preserved (FR-016) rather than resetting to the placeholder.
- **Observer session weather**: with no hero car present, weather still populates — the source variables are global sim state (FR-015).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The engineer MUST announce a competitor's pit entry when that competitor is within the configured relevance window: within N positions of the driver's current position **in the driver's class** (default N = 3). The announcement MUST identify the car (car number) and its position, except when delivered as part of a coalesced announcement per FR-014.
- **FR-002**: The engineer MUST announce a competitor's pit exit under the same relevance window, identifying the car and its position after the stop, except when delivered as part of a coalesced announcement per FR-014.
- **FR-003**: Competitor pit announcements MUST be deduplicated per competitor per pit visit — one entry announcement and one exit announcement per visit, re-arming on the next visit. (Dedup keys gain a per-car dimension, as anticipated by the M4 contract.)
- **FR-004**: The engineer MUST announce a closing gap when a gap in a battle **involving the driver** first drops below the configured gap threshold (existing config, default 2.0 seconds). "First drops below" means a crossing: a gap that is already below the threshold when tracking begins (session start, or a new adjacent car after an overtake) MUST first be observed at or above the threshold before a closing alert may fire. The announcement MUST state the gap and whether it is the car ahead or the car behind.
- **FR-005**: The engineer MUST announce a widening gap when a battle involving the driver first opens beyond the threshold **plus a configurable hysteresis margin** (default 0.5 seconds), with wording that distinguishes pulling away (driver ahead) from losing touch (driver behind). Like FR-004, this is a crossing requirement: the widening alert arms only after a closing alert has fired for that pair and direction — a battle never observed crossing below the threshold (e.g., a gap already under it at the green flag that simply opens up) produces no breaking-away confirmation.
- **FR-006**: Gap alerts MUST use a hysteresis dead band: the closing alert fires on crossing below the threshold and re-arms only when the gap crosses above the threshold-plus-margin boundary; the widening alert fires on crossing above the threshold-plus-margin boundary and arms only via a closing fire (per FR-005 — the arming rule is normative there, not restated here). A gap moving within the dead band produces no announcements.
- **FR-007**: Gap alerts MUST NOT fire for battles not involving the driver, for an adjacent car of a different class (multiclass sessions — clarified 2026-07-10), during caution / safety car periods, while the driver is on pit road, or while the adjacent car is on pit road. Caution and pit-road suppressions MUST be logged with a reason at the point an announcement would otherwise have fired (gap tracking continues during the suppression so that point is detectable; never logged per tick), and gap tracking restarts fresh — crossing semantics per FR-004 — when the suppression ends. A cross-class or absent adjacent car is a standing non-battle condition, not a per-event decision, and is not logged per tick.
- **FR-008**: The engineer MUST announce pace degradation when the driver's tire degradation classification transitions from nominal to "watch" and again on transition to "critical". Each classification level announces at most once per stint; the alert re-arms at the stint boundary (pit exit, where fresh tires reset the classification). A mid-stint recovery to nominal does NOT re-arm — that would permit a second same-level announcement within the stint.
- **FR-009**: All five alerts MUST be delivered as Tier 2: gated by the safe-window / radio-blackout-zone logic, subject to the existing Tier 2 delivery rules (the 30-second no-safe-window drop) and personality-based suppression, and never preempting Tier 1 alerts.
- **FR-010**: Each alert MUST be delivered within the Tier 2 latency budget — within 3 seconds of the triggering event when a safe window is open, otherwise at the next safe window.
- **FR-011**: The relevance window size and the gap hysteresis margin MUST be configurable in the engineer configuration alongside the existing gap threshold. Defaults (window ±3, margin 0.5s) MUST work without any configuration change.
- **FR-012**: Every rule decision that does not produce a delivered announcement — as well as every fired one — MUST emit a structured log entry stating the outcome and reason (no silent failures). The canonical outcome vocabulary and log-event names are defined in the design contract (contracts/alert-rules.md §Structured logging contract): skipped (relevance, unresolvable identity, no hero), suppressed (caution, pit road, personality), deduplicated, coalesced, and dropped (no safe window within 30 seconds) — the contract's event names govern where this spec's prose and the log vocabulary differ.
- **FR-013**: Announcement wording MUST follow canonical spoken-text templates (defined at design time, consistent with the M4 contract style) so acceptance testing can validate exact output; wording for gap alerts MUST encode direction per FR-004/FR-005.
- **FR-014**: When multiple relevant competitors' pit announcements of the same kind (entries, or exits) are pending at the same time, the engineer MUST deliver them as one combined announcement — naming the cars, or the count when more than two — rather than as separate messages. A coalesced announcement satisfies the per-visit deduplication (FR-003) for every car it covers and counts as a single dequeued item. Before the merge, each pending alert's own 30-second no-safe-window timeout still governs it individually — an alert that times out is discarded (and logged) rather than resurrected by a later merge.
- **FR-015**: The hub MUST populate the race state's session weather from live sim weather telemetry — air temperature, track temperature, relative humidity, wind speed and direction, sky state, precipitation, and fog level — at the session-telemetry cadence, exposed through the existing race-state endpoint (no new endpoint). The raw sky-state value MUST map to the typed set `Clear` / `PartlyCloudy` / `MostlyCloudy` / `Overcast`, with out-of-range values reporting `Clear`. Weather MUST populate in both driver and observer sessions (the source variables are global sim state, not driver-gated).
- **FR-016**: A session-telemetry frame that carries no weather fields (e.g., an older collector build) MUST leave the previously reported weather unchanged — the placeholder default may only ever be visible before the first weather-bearing frame of a session, never as a mid-session regression. The guard is per field: a frame carrying only some weather fields updates exactly those and preserves the previous value of each absent one.

### Key Entities

- **Alert Rule**: A mapping from a race event type to an announcement decision — condition, relevance filter, spoken text, tier. This feature activates five existing rule definitions that currently produce nothing.
- **Relevance Window**: The configurable band of class positions around the driver (default ±3) that determines which competitors' pit activity is announced.
- **Battle (car pair)**: The driver and the position-adjacent car in the running order (one ahead, one behind), evaluated only when that car is the driver's class — a cross-class adjacent car is not a battle candidate, and the design does not look past it to the nearest same-class rival. Only these driver-involved pairs produce announcements. Direction (driver ahead vs. behind) is an attribute of the announcement. (The gap model's internal pair tracking is not the model of record for alerts — the design evaluates the driver-adjacent gaps directly from live race state.)
- **Degradation Classification**: The driver's tire state as classified by the existing tire model (nominal / watch / critical); classification *transitions* are the alert trigger, not the underlying values.
- **Deduplication Key**: Identity for "has this been announced" — extended in this feature with a per-car dimension (competitor alerts), a per-pair-and-direction dimension (gap alerts), and a per-stint-per-level dimension (degradation).
- **Session Weather**: The current sim conditions carried on the race state — air/track temperature, humidity, wind speed and direction, typed sky state, precipitation, fog level. A display passthrough (US4): updated from telemetry, exposed on the existing race-state endpoint, consumed by an out-of-repo stream overlay; feeds no alert rule.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a race session containing a pit cycle, 100% of pit entries and exits by cars inside the relevance window are announced (individually or within a coalesced announcement) — excluding alerts legitimately dropped by the 30-second no-safe-window backstop, skipped for unresolvable identity, or suppressed by personality settings (Energy = 1), each of which must appear in the decision log (SC-005) — and 0 announcements occur for cars outside the window.
- **SC-002**: Alerts triggered while a safe window is open are audible within 3 seconds of the triggering condition; alerts triggered inside a blackout zone are delivered at the next safe window.
- **SC-003**: Zero repeated announcements for the same condition: one per competitor pit visit, one per gap boundary crossing (until re-armed via the dead band), one per degradation level per stint.
- **SC-004**: Zero gap announcements for battles not involving the driver, for a cross-class position-adjacent car, during caution periods, or while the driver or the position-adjacent car is on pit road (all FR-007 suppression conditions).
- **SC-005**: A post-session review of the decision log can account for every triggering event: each one maps to exactly one outcome (delivered, skipped, suppressed, deduplicated, or dropped) with a stated reason. A coalesced delivery counts as delivered for every car it covers, evidenced by the single `alerts_coalesced` entry naming them.
- **SC-006**: With this feature merged, all six Tier 2 rules in the M4 alert catalog are active — the roadmap's M4 Tier 2 description becomes accurate with no stubbed rules remaining.
- **SC-007**: During any live session, the weather reported by the race-state endpoint matches the sim's own conditions display, updates at session-telemetry cadence, and never regresses to placeholder values mid-session; a browser overlay on another LAN host (or opened via `file://`) can read it cross-origin without errors.

## Assumptions

- All five triggering events are already published by the race state engine with sufficient underlying data (car index, lap, gap seconds, degradation classification); where an announcement needs data not present in the event itself (car number, class, current position), it is available from the live race state at trigger time. No new telemetry or event types are required.
- **Relevance scope decision (project owner, 2026-07-10)**: competitor pit relevance is *relative to the driver's class position* (±N, default 3), not the absolute top-N pinned in the M4 contract's reference rows. Those rows were marked "future reference only"; this spec supersedes them.
- **Pace degradation trigger**: the M4 contract sketched a percentage threshold, but the shipped tire model produces a 3-state classification (nominal/watch/critical). This spec uses classification transitions as the trigger — no new percentage configuration is introduced (YAGNI). The M4-reserved config fields for a percentage threshold are not added.
- The existing Tier 2 machinery (safe-window gate with its 30-second no-safe-window drop, personality/energy-based suppression, TTS and playback path) is reused unchanged; this feature only activates rules that feed it.
- These are rule-based alerts with no LLM inference in the decision path; the existing structured decision logging satisfies the observability principle, consistent with how M4/M5 alert decisions are logged today.
- Gap announcements always carry a numeric gap: gaps are computed from the live race state at evaluation time (not read from gap-model event payloads), so a current gap value is available whenever an alert fires.
- Caution-period suppression of gap alerts is a deliberate product choice (gaps compress artificially under caution); competitor pit alerts remain active under caution because pitting under caution is precisely when strategy divergence happens.
- **Weather scope (US4)**: current conditions only. iRacing's per-session *forecast* is served by the authenticated members web Data API — a cloud dependency in tension with Principle IV — and is explicitly out of scope; if wanted later it is its own feature. The overlay document itself (`weather.html`, on the streaming-assets volume) is outside this repo: its fetch-and-poll change is not part of this feature's deliverable. The hub-side contract is fresh, truthful `session.weather` on the existing endpoint (CORS for cross-origin reads landed 2026-07-10).
