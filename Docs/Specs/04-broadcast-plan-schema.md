# Broadcast Plan Schema

## Purpose

The Broadcast Plan is the core authoring surface for Stream Operators. It defines the intent and context of a broadcast — who matters, what the fallback strategy is, and what the Engineer should communicate to viewers — without scripting the Engineer's real-time decisions.

The plan is authored before the race begins and remains largely static. It is distinct from Live Operator Signals, which are pushed during the race to update the Engineer's understanding of ground truth.

---

## Core Design Principle

**The plan and Operator inputs raise the ceiling — they don't define the floor.**

The Stream Engineer always has enough to function without a plan. Additional configuration improves the quality and specificity of its decisions; it does not gate them. This means the schema should express intent and preference, not exhaustive rules.

---

## Two Data Models

### 1. Broadcast Plan

Authored before the race. Expresses the Operator's intent, editorial priorities, and contingency choices. Static for the duration of the session unless explicitly updated.

### 2. Live Operator Signals

Pushed during the race. Updates the Engineer's understanding of current state — what's happening right now that it cannot fully infer from telemetry. Also serves as a source of content for viewer-facing graphics.

These are distinct schemas. Conflating them leads to plans that are either too rigid (trying to anticipate live state) or live signals that carry too much structural weight. The plan sets disposition; signals update reality.

---

## Field Taxonomy

Some fields in both schemas serve different functions, and that distinction should be explicit:

- **Directive fields** — inform the Engineer's decisions. The Engineer reads them and acts accordingly.
- **Content fields** — become part of the broadcast itself, surfaced as graphics or overlays to viewers.
- **Dual-purpose fields** — do both simultaneously.

The repair timer is a canonical example of a dual-purpose field: it tells the Engineer to enter roaming mode, and it drives a viewer-facing graphic showing the expected return window.

---

## Broadcast Plan Schema

### Broadcast Type

The top-level disposition of the stream. Sets the Engineer's default behavior and determines which other fields are required or available.

| Type      | Description                                                                            |
| --------- | -------------------------------------------------------------------------------------- |
| `hero`    | Focused on one or more primary subjects. Engineer prioritizes coverage of those cars.  |
| `general` | No primary subject. Engineer selects the most compelling action across the full field. |

Additional types should be anticipated. The schema should be extensible here — a rivalry stream (two competing subjects with equal weight), a team stream, or a class-specific broadcast are natural evolutions.

---

### Primary Subjects

Required for `hero` broadcasts. A prioritized list of cars the Engineer should follow.

Each subject includes:

- **Car identifier** — the car number or driver used to look up telemetry
- **Priority** — relative weight when multiple subjects are in conflict (e.g., two hero cars both doing something interesting simultaneously)
- **Storyline annotation** — optional editorial context the Engineer uses for framing and that can be surfaced as graphic copy (e.g., "Fighting back from a lap-1 incident")

Modeling subjects as a list rather than a single car is intentional. Even a "hero stream" may have a secondary subject — a rival, a teammate — and the schema should accommodate that from the start without requiring a type change.

---

### Watchability Hints

Optional fields that help the Engineer make better decisions about when to leave or return to a primary subject. These supplement inference — the Engineer acts on its own judgment regardless, but accurate hints improve the quality of that judgment.

- **Expected pit stop duration** — the Operator's estimate of a normal pit stop for this series or team. Used to calibrate how long to stay in roaming mode before checking whether the hero car has returned.
- **Pre-race notes** — any context the Operator has that the Engineer cannot infer from telemetry. Starting position, known mechanical concerns, strategy differences from the field.

---

### Contingency Behaviors

Explicit Operator choices for scenarios the Engineer cannot resolve on its own. These are decisions, not inferences — the schema captures them so the Engineer doesn't have to guess.

- **On hero car DNF** — what the Engineer should do if the primary subject is out of the race permanently. Options: end the broadcast, convert to a general broadcast, or continue on a secondary subject.

This field is required for `hero` broadcasts. The Engineer should never have to infer Operator intent for a DNF — it is too consequential a decision.

---

## Live Operator Signal Schema

Live signals are the Operator's channel to update the Engineer's understanding of current state during the race. They are time-stamped, ephemeral, and processed in order.

### Hero Car Status

Used when the primary subject is unavailable and the Operator has information the Engineer cannot infer.

- **Status** — current state of the hero car: `active`, `in_repair`, `dnf`
- **Repair timer** — estimated time remaining until the car returns to track. Dual-purpose: triggers roaming mode and drives a viewer-facing graphic. Accepted as manual Operator input because iRacing repair timer telemetry is only available when the driver is in the cockpit.
- **Return condition** — the Engineer exits roaming mode when the timer expires OR the car is detected back on track, whichever comes first. Manual timer is a ceiling, not a guarantee.

### Storyline Update

Allows the Operator to update or add editorial context mid-race. Dual-purpose: informs the Engineer's framing and can be surfaced as graphic copy.

- **Subject** — which car or situation the storyline applies to
- **Text** — the updated annotation

### Incident Flag

Allows the Operator to manually flag an event the Engineer may have missed or deprioritized. Directive only.

- **Subject** — the car or location involved
- **Priority** — how urgently the Engineer should redirect attention

---

## Open Questions

1. **Broadcast type extensibility** — rivalry streams, team streams, and class-specific broadcasts are natural evolutions. How are new types defined and what fields do they introduce? This should be resolved before the UI is designed, as broadcast type selection is likely the first authoring decision an Operator makes.

2. **Subject list upper bound** — is there a practical limit to how many primary subjects a hero broadcast can have before it functionally becomes a general broadcast? Worth defining a soft ceiling for authoring UX purposes.

3. **Live signal history** — does the Engineer retain a log of live signals for post-race review, or are they ephemeral? Has implications for replay and coaching use cases downstream.

4. **Plan versioning** — can an Operator update the static plan mid-race (not just push signals), and if so, how does the Engineer reconcile an updated plan with decisions already made?
