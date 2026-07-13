# Contract: Tier 2 Alert Completion — Rule Definitions

**Supersedes**: the T2-02…T2-06 reference rows in `specs/004-rule-based-alerts-voice/contracts/alert-rules.md` (which were explicitly "for future reference only"). T1 rules and T2-01 are unchanged.

**Evaluated by**: hub-server `alert-rules.ts` (event-driven rules) and `gap-alert-monitor.ts` (state-driven rules)

---

## Event-driven rules (input: `RaceEvent` + `RaceState` + `EngineerConfig` → `QueuedAlert | null`)

| Rule ID | Trigger | Condition | Dedup key |
|---------|---------|-----------|-----------|
| T2-02 | `competitor:pit_entry` | competitor within relevance window (below) | `competitor:pit_entry:{carIdx}` |
| T2-03 | `competitor:pit_exit` | competitor within relevance window | `competitor:pit_exit:{carIdx}` |
| T2-06 | `hero:pace_degradation` | `payload.signal ∈ {watch, critical}` (event is already transition-gated upstream); any other signal value returns null + logs `alert_skipped {reason:'invalid-signal'}` (defensive — unreachable via the current pipeline, but FR-012 forbids a silent null) | `hero:pace_degradation:{signal}` |

**Relevance window (T2-02/03)**: `competitor.carClassId === hero.carClassId && |competitor.classPosition − hero.classPosition| ≤ config.relevantPositionRange`. Degenerate class data (`carClassId ≤ 0` or `classPosition ≤ 0` on either car) ⇒ skip the class test and use overall `position` distance instead. The announced position uses the same field the test used.

**Identity guard**: `state.hero === null` (pre-session) ⇒ return null + log `alert_skipped { reason: 'no-hero' }`; `state.field[payload.carIdx]` missing, or `carNumber` empty ⇒ return null + log `alert_skipped { reason: 'identity-unresolved' }`. Never announce a placeholder.

## State-driven rules (input: `RaceState` per dispatch tick → enqueued `QueuedAlert`s)

| Rule ID | Fires when | Direction variants |
|---------|-----------|--------------------|
| T2-04 `gap:closing` | **same-class** hero-adjacent gap crosses **below** `gapThresholdSeconds` while closing is armed | ahead (hero chasing), behind (hero defending) |
| T2-05 `gap:pulling_away` | **same-class** hero-adjacent gap crosses **above** `gapThresholdSeconds + gapHysteresisMarginSeconds` while widening is armed | ahead (hero losing touch), behind (hero pulling away) |

Closing arms only after the gap has been observed at ≥ threshold (fresh slots start disarmed — no green-flag / post-overtake noise). A cross-class adjacent car is a standing non-battle condition: the slot resets and is not evaluated (and not logged per tick), same as no adjacent car. Full arm/disarm semantics, dead band, reset and suppression conditions: [data-model.md §GapAlertMonitor](../data-model.md). Suppression logging reasons: `caution`, `hero-on-pit-road`, `adjacent-on-pit-road`.

---

## Canonical spoken-text templates

Implementers MUST use these exact templates (FR-013). `{gap}` renders to one decimal place; `{pos}` is the position field chosen by the relevance test.

| Rule | Variant | Template |
|------|---------|----------|
| T2-02 | single | `Car {carNumber} pitting from P{pos}` |
| T2-02 | coalesced ×2 | `Cars {carNumber1} and {carNumber2} are pitting` |
| T2-02 | coalesced ≥3 | `{count} cars around you are pitting` |
| T2-03 | single | `Car {carNumber} out of pits, P{pos}` |
| T2-03 | coalesced ×2 | `Cars {carNumber1} and {carNumber2} back out of the pits` |
| T2-03 | coalesced ≥3 | `{count} cars back out of the pits` |
| T2-04 | ahead | `Gap closing — {gap} seconds to the car ahead` |
| T2-04 | behind | `Car behind closing — gap {gap} seconds` |
| T2-05 | behind (hero ahead) | `Gap {gap} seconds — you're pulling away` |
| T2-05 | ahead (hero behind) | `Losing touch — gap {gap} seconds to the car ahead` |
| T2-06 | watch | `Pace dropping — tires starting to go off` |
| T2-06 | critical | `Pace critical — tires are done, {trend} seconds off your early pace` |

`{trend}` = `payload.trend` rendered to one decimal place (seconds of pace lost, last lap vs. first lap of the rolling window).

Coalesced ordering: car numbers in ascending queue (arrival) order.

---

## Coalescing contract (FR-014)

Applied by `PriorityMessageQueue.dequeueNext` when the Tier 2 head is T2-02 or T2-03:

1. Remove every other queued Tier 2 alert with the **same eventType** (entries merge with entries, exits with exits — never across).
2. Emit one merged `QueuedAlert` using the coalesced template; head alert supplies `lapNumber`/`sessionTime`.
3. Log `alerts_coalesced { eventType, mergedCount, carNumbers }`.
4. The merged alert counts as ONE queued item; the 30-second no-safe-window drop applies via each alert's own `enqueuedAt` until the merge. Per-car dedup was recorded at enqueue and is unaffected.
5. Ordering vs. personality suppression: the merge happens at dequeue (inside `dequeueNext`), BEFORE the dispatcher's Energy=1 check — so Energy suppression applies to the merged alert as one `alert_suppressed` entry, and the preceding `alerts_coalesced {carNumbers}` log preserves per-car accounting for SC-005 even when the merged announcement is then suppressed.

## Structured logging contract (FR-012)

Every decision on the new paths emits exactly one structured log entry:

| Event | When | Required fields |
|---|---|---|
| `alert_enqueued` *(existing)* | rule fired, queued | alertType, tier, lapNumber |
| `alert_deduplicated` *(existing)* | dedup suppressed | alertType, dedupKey |
| `alert_skipped` *(new)* | relevance fail / identity unresolved / no hero / invalid signal | alertType, carIdx (when applicable), reason: `relevance` \| `identity-unresolved` \| `no-hero` \| `invalid-signal` |
| `gap_alert_suppressed` *(new)* | monitor suppression | direction, reason: `caution` \| `hero-on-pit-road` \| `adjacent-on-pit-road` |
| `alerts_coalesced` *(new)* | dequeue-time merge | eventType, mergedCount, carNumbers |
| `alert_suppressed` *(existing)* | Energy=1 at dequeue | alertType, reason |
| `tier2_dropped_no_window` *(existing)* | 30s gate timeout | alertType |

FR-012 outcome mapping (this table is canonical — FR-012 defers to it, wording aligned 2026-07-11): fired → `alert_enqueued`; skipped (relevance / identity-unresolved / no-hero / invalid-signal) → `alert_skipped` (distinguished by `reason`); suppressed → `gap_alert_suppressed` (caution / pit road, gap monitor) or `alert_suppressed` (Energy=1 personality, dequeue); deduplicated → `alert_deduplicated`; coalesced → `alerts_coalesced` (the merged delivery then counts as delivered for every covered car — SC-005); dropped (no safe window in 30s) → `tier2_dropped_no_window`.

## Compatibility notes

- `evaluateTier2` signature: `(event, state: RaceState, config)` — call sites in `racing-engineer.ts` and unit tests updated; `signals` reachable as `state.signals`.
- `gap:closing` / `gap:pulling_away` **events** on `hub:events` are no longer alert candidates (their `evaluateTier2` cases are removed; the monitor owns those alert types). Other consumers of these events are unaffected.
- `competitor:pit_entry` / `competitor:pit_exit` are simultaneously clear signals (for each other, per car) and alert candidates — they must not early-return from the clear-signal switch in `racing-engineer.onEvent` the way M4's hero clear signals do.
