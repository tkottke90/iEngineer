# Research: Tier 2 Alert Completion

**Feature**: 007-tier2-alert-completion | **Date**: 2026-07-10

All Technical Context items were resolvable from the existing codebase; no external research was required. The decisions below resolve every design fork encountered while mapping the spec onto the shipped M3–M5 machinery.

## R1 — Gap alerts are evaluated from RaceState polling, not from gap-model events

**Decision**: Implement T2-04/T2-05 in a new `GapAlertMonitor` that reads `RaceState` on the dispatch tick and detects threshold crossings itself. Do NOT trigger from `gap:closing` / `gap:pulling_away` events.

**Rationale**: Inspection of `apps/hub-server/src/models/gap-model.ts` shows its events cannot express the spec's semantics:

- `gap:closing` fires on a **battle-status transition** governed by hard-coded constants (`BATTLE_GAP = 1.0`, `RESOLVE_GAP = 1.5`), not on crossings of the configurable `gapThresholdSeconds` (2.0). A gap that transitions to `closing` status at 6s and then shrinks through 2.0s emits **no further event** at the threshold — the alert would fire at the wrong moment or never.
- `gap:pulling_away` is emitted **every processor tick** once `closingRate > 0.3` for 2+ ticks (no one-shot latch), and it fires while the gap is *closing* fast (`closingRate` positive = shrinking) — the name and the condition disagree. Consuming it would spam and mislead.
- The M4 contract's condition sketch (`payload.gapSeconds <= config.gapThresholdSeconds`) filters event *payloads*, which only works if events arrive continuously — they don't.

Polling `RaceState` gives exact, configurable boundary detection with the clarified dead band (threshold / threshold + margin), hero-scoping for free, and zero pipeline changes. Cost: two gap computations per 100ms tick — negligible.

**Alternatives considered**:
- *Consume gap-model events + payload filter* (M4 sketch) — rejected: wrong/missing trigger points as above.
- *Rework the gap model to emit threshold-crossing events with hysteresis* — rejected: touches the M3 pipeline consumed by other components (race-state KV, future Stream Engineer), couples model constants to engineer config, and is strictly more code for the same behavior.

**Out-of-scope observation (flagged, not fixed here)**: the `gap:pulling_away` emission in `gap-model.ts:114-118` re-fires every tick and triggers on *closing* rate — likely an M3 bug. It becomes harmless to the engineer (unconsumed after this feature) but still reaches the event bus/ring buffer. Recommend a follow-up ticket; fixing it in 007 would violate the feature boundary (Constitution VII).

## R2 — Coalescing happens at dequeue time in the PriorityMessageQueue

**Decision**: Merge same-kind competitor pit alerts when the dispatcher dequeues, not at enqueue and not via an aggregation timer.

**Rationale**: FR-014's trigger is alerts "pending at the same time". Dequeue-time merge implements exactly that: bursts that pile up behind the TTS pipeline, a blackout zone, or an earlier message merge naturally; a lone alert dispatches immediately with zero added latency (a timer-based window would spend up to its window length against the 3s budget, which TTS already eats into). Per-car dedup is recorded at enqueue, so merging later never double-fires.

**Alternatives considered**:
- *Aggregation window at enqueue (e.g., 2s)* — rejected: adds fixed latency to the common single-car case.
- *Enqueue-time merge into an existing queued alert* — rejected: equivalent outcome but splits queue-mutation logic across two modules; the queue owning it keeps `racing-engineer.ts` untouched for this concern.

## R3 — Dedup strategy per new rule

**Decision**:

| Rule | Key | Cleared by |
|---|---|---|
| `competitor:pit_entry` | `competitor:pit_entry:{carIdx}` | that car's `competitor:pit_exit` event |
| `competitor:pit_exit` | `competitor:pit_exit:{carIdx}` | that car's `competitor:pit_entry` event |
| `hero:pace_degradation` | `hero:pace_degradation:{level}` (level = watch \| critical) | `hero:pit_exit` (stint boundary) |
| `gap:closing` / `gap:pulling_away` | none (DedupTracker not used) | monitor arm/disarm state machine IS the dedup |

`dedupKeyFor` gains an optional `scope` parameter and a third strategy set (scoped-event-cleared) alongside the existing per-lap and event-cleared sets; `recordCleared` accepts an optional scope to clear one car/level without nuking the type. This is the extension the M4 contract anticipated ("carIdx dimension added to dedup key at that point").

**Rationale**: entry/exit clearing each other per car gives exact once-per-visit semantics with no timers. Gap alerts already need a state machine for the dead band — routing them through the DedupTracker as well would be two sources of truth.

**Alternatives considered**: per-lap keys for competitor alerts (`{carIdx}:{lapNumber}`) — rejected: a pit visit spanning a lap boundary could announce twice; visit-scoped clearing is exact.

## R4 — Relevance window resolution (class position + fallback)

**Decision**: A competitor is relevant iff it has the hero's `carClassId` and `|competitor.classPosition − hero.classPosition| ≤ relevantPositionRange`. If class data is degenerate (either car's `carClassId` ≤ 0 or `classPosition` ≤ 0 — single-class sessions or incomplete session YAML), fall back to overall `position` for both the class test (skip it) and the distance test. Announced position uses the same field the relevance test used (class position when class data is valid, else overall).

**Rationale**: implements the clarified "near hero in class" decision (spec, session 2026-07-10) using fields already maintained on every `CarState` by the M3 session processor; the fallback covers the spec's single-class edge case without new data.

**Alternatives considered**: absolute top-N (the M4 contract sketch) — superseded by the owner's clarification decision, recorded in the spec.

## R5 — Pace degradation trigger and re-arm

**Decision**: Consume the existing `hero:pace_degradation` event as-is; dedup per level; clear both level keys on `hero:pit_exit`.

**Rationale**: `session-processor.ts:341-346` already emits this event **only on transition** into `watch` or `critical` (`signal !== prevSignal` guard), with payload `{ signal, trend }` — the event bus does the transition detection the spec asks for. There is no "recovered to nominal" event, and none is needed: FR-008's bound is "at most once per level per stint", and stints end at pit exit, which the engineer already consumes as a clear signal for the pit-window key — the pace keys clear in the same handler. A mid-stint recovery to nominal followed by re-degradation stays suppressed, which is what "once per stint" requires.

**Alternatives considered**: adding a nominal-recovery event to the pipeline for mid-stint re-arm — rejected: violates the once-per-stint bound and touches the pipeline for no spec-required behavior.

## R6 — Announcement values, wording direction, and event lapNumber quirks

**Decision**:
- Competitor pit alerts resolve `carNumber` and position from `state.field[carIdx]` at rule-evaluation time (trigger time), satisfying the spec's "values reflect state at trigger time". The events themselves carry only `{ lapNumber, carIdx }`.
- Gap announcements render the gap to one decimal place; direction-specific canonical templates are pinned in `contracts/alert-rules.md` (four variants: closing-ahead, closing-behind, pulling-away, losing-touch).
- Gap-model and degradation events are published with `lapNumber: 0` (session-processor passes 0 for non-lap-scoped events); the new rules never key dedup on `event.lapNumber` except via `QueuedAlert.lapNumber` metadata, so this quirk is harmless — noted so tests don't assert real lap numbers on these paths.

**Rationale**: keeps events lean (no pipeline payload enrichment), uses data every rule already has access to via `getRaceState()`, and preserves M4's exact-template testability (FR-013).

**Alternatives considered**: enriching `competitor:pit_entry`/`pit_exit` payloads with carNumber/position in the session processor — rejected: pipeline change for data the engineer can read locally; would also duplicate state that can drift within a cycle.
