# Data Model: Tier 2 Alert Completion

**Feature**: 007-tier2-alert-completion | **Date**: 2026-07-10

No persistent storage changes. All additions are in-process state and configuration.

## Configuration (`EngineerConfig` — packages/types/src/engineer.ts)

| Field | Type | Default | Consumer | Notes |
|---|---|---|---|---|
| `gapThresholdSeconds` | number | 2.0 | GapAlertMonitor | **existing** M4 placeholder — gains its first consumer (FR-004) |
| `relevantPositionRange` | number | 3 | competitor pit rules | NEW — ± class positions around hero (FR-001/FR-011) |
| `gapHysteresisMarginSeconds` | number | 0.5 | GapAlertMonitor | NEW — dead band width above threshold (FR-005/FR-006) |

Validation (config loader): both new fields must be finite and > 0; `relevantPositionRange` an integer ≥ 1. Defaults added to `apps/hub-server/config/engineer-config.json`.

**Deliberately absent** (YAGNI, spec Assumptions): `paceDegradationPctThreshold`, `paceDegradationRollingLaps` — the M4-reserved percentage config is superseded by classification transitions.

## Dedup keys (DedupTracker — third strategy added)

| Strategy | Alert types | Key format | Reset |
|---|---|---|---|
| Per-lap *(existing)* | `hero:fuel_critical` | `{eventType}:{lapNumber}` | automatic (new lap) |
| Event-cleared *(existing)* | blue flag, safety car, pit limiter, pit window | `{eventType}` | `recordCleared(eventType)` |
| **Scoped-event-cleared** *(new)* | `competitor:pit_entry`, `competitor:pit_exit`, `hero:pace_degradation` | `{eventType}:{scope}` | `recordCleared(eventType, scope?)` — scoped clear removes one key; scope-less clear removes all keys of the type |

Scope values: `carIdx` (competitor alerts), degradation level `watch` \| `critical` (pace alert).

API change: `dedupKeyFor(eventType, lapNumber, scope?)`, `shouldFire(eventType, lapNumber, scope?)`, `recordFired(eventType, lapNumber, scope?)`, `recordCleared(eventType, scope?)`. Existing call sites are unaffected (scope optional).

Clear-signal wiring (racing-engineer `onEvent`):

| Incoming event | Clears |
|---|---|
| `competitor:pit_exit` (carIdx C) | `competitor:pit_entry:C` — then the event still evaluates as a T2-03 alert candidate (dual role: clear signal AND alert producer; unlike M4 clear signals it must NOT early-return) |
| `competitor:pit_entry` (carIdx C) | `competitor:pit_exit:C` — same dual role |
| `hero:pit_exit` | `hero:pit_window_open` *(existing)* + `hero:pace_degradation` (all scopes) |

## GapAlertMonitor state (new, in-process)

One instance per RacingEngineerService; two `DirectionState` slots (`ahead`, `behind`):

```
DirectionState {
  adjacentCarIdx: number | null   // reset trigger: adjacency change
  closingArmed: boolean           // init FALSE — arms on first observation of g ≥ T (FR-004:
                                  //   a gap already below T at first sight must not fire)
  wideningArmed: boolean          // init false — widening requires a prior closing phase (FR-005)
}
```

Transition rules (T = gapThresholdSeconds, M = gapHysteresisMarginSeconds, g = current gap):

| Condition | Action |
|---|---|
| g ≥ T ∧ ¬closingArmed ∧ ¬wideningArmed | closingArmed=true (initial arming, no fire) |
| g < T ∧ closingArmed | fire closing alert; closingArmed=false; wideningArmed=true |
| g > T+M ∧ wideningArmed | fire widening alert; wideningArmed=false; closingArmed=true |
| T ≤ g ≤ T+M | no state change (dead band), except initial arming above |
| hero missing (`RaceState.hero === null`, pre-session) / adjacent car changed / no adjacent car / adjacent car in a different class (valid class data — FR-007) / invalid gap (≤0, non-finite, or lapped-scale) | reset slot to init; standing non-battle conditions, not logged per tick |
| sessionPhase = Caution ∨ hero.onPitRoad ∨ adjacent.onPitRoad | evaluation CONTINUES with firing replaced by logging: a would-fire crossing emits `gap_alert_suppressed {reason}` and applies the same arm/disarm transitions as a fire (hysteresis bounds log volume — never per tick); when the suppression condition clears, reset slot to init (disarmed — the restart requires a fresh ≥ T observation, so no alert burst as the field spreads out again) |

Post-reset behavior (green flag, post-overtake): the fresh slot starts disarmed, so a gap already under T produces nothing until it has been observed at ≥ T once (spec edge case "Already close at first sight"). Class comparison uses the same degenerate-data fallback as the pit relevance test (research.md R4): if either car's class data is invalid, the class check is skipped.

**Lapped-scale definition**: a gap is lapped-scale (invalid for battle purposes) when `g > 0.8 × hero.estimatedLapTime`; when `estimatedLapTime` is unavailable or ≤ 0, fall back to 72 seconds (0.8 × the 90s default). This mirrors the gap model's `LAPPED_CAR_THRESHOLD = 0.8` convention so both components agree on what "lapped" means.

Gap computation (from `RaceState.field` — NOTE: `field` is `Record<carIdx, CarState>` keyed by car index, NOT by position; scan for the matching `position` value):
- ahead = the car whose `position === hero.position − 1` → `g = hero.gapToLeader − ahead.gapToLeader`
- behind = the car whose `position === hero.position + 1` → `g = behind.gapToLeader − hero.gapToLeader`

The monitor enqueues standard `QueuedAlert`s (tier 2, eventType `gap:closing` or `gap:pulling_away`); the DedupTracker is bypassed — arm/disarm state is the dedup (research.md R3).

## QueuedAlert (unchanged shape; new producers)

No interface change. New alerts populate:
- `eventType`: the five activated `AlertEventType` values (already in the union since M4)
- `dedupKey`: scoped format for competitor/pace alerts; monitor-generated gap alerts carry a descriptive key (`gap:closing:ahead` etc.) for logging only
- `lapNumber`: from the triggering event for competitor alerts; from `hero.lapCompleted` for monitor-generated gap alerts (gap/degradation events are published with `lapNumber: 0` — research.md R6)

## Coalescing (PriorityMessageQueue)

At `dequeueNext`, when the Tier 2 head is a `competitor:pit_entry` or `competitor:pit_exit` alert and further queued Tier 2 alerts share its `eventType`, all are removed and merged into one `QueuedAlert`:
- `messageText`: coalesced template (contract §Templates) from the per-car alerts' resolved car numbers/count
- `lapNumber`/`sessionTime`: from the head (earliest) alert
- one merged alert = one dequeued item (30s no-safe-window drop accounting unchanged — each queued alert keeps its own `enqueuedAt` until merged); merge logged as `alerts_coalesced` with the merged count

Relationships: coalescing never crosses event types, never touches gap/pace/hero alerts, and never resurrects alerts already dropped by the 30s no-safe-window rule.
