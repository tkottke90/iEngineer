# Contract: Alert Rule Definitions

> **Supersession note (2026-07-13)**: the T2-02…T2-06 reference rows below were
> marked "for future reference only" and are SUPERSEDED by
> [`specs/007-tier2-alert-completion/contracts/alert-rules.md`](../../007-tier2-alert-completion/contracts/alert-rules.md)
> — the shipped rules differ materially (class-relative relevance window, a
> state-driven GapAlertMonitor instead of gap-event conditions, classification
> transitions instead of a percentage threshold, and revised templates).
> T1 rules and T2-01 remain authoritative here.

**Evaluated by**: hub-server `alert-rules.ts`  
**Input**: `RaceEvent` from the event bus (`hub:events` Redis pub/sub)  
**Output**: `QueuedAlert | null`

---

## Tier 1 Alert Rules (Gate-Override — Immediate Delivery)

| Rule ID | Triggering EventType | Condition | Spoken Text (canonical) |
|---------|----------------------|-----------|------------------------|
| T1-01 | `hero:fuel_critical` | `payload.lapsRemaining <= config.fuelCriticalLapsRemaining` | "Fuel critical — {lapsRemaining} laps remaining" |
| T1-02 | `hero:blue_flag` | event received | "Blue flag — let them by" |
| T1-03 | `session:safety_car_deployed` | event received | "Safety car deployed — hold position" |
| T1-04 | `hero:pit_limiter_active` | `payload.active === true` | "Pit limiter active" |

---

## Tier 2 Alert Rules (Safe-Window Gated)

| Rule ID | Triggering EventType | Condition | Spoken Text (canonical) |
|---------|----------------------|-----------|------------------------|
| T2-01 | `hero:pit_window_open` | `signals.pitWindowOpen === true` | "Pit window is open — you can box this lap" |
| T2-02 | `competitor:pit_entry` | `payload.position <= config.relevantPositionRange` | "Car {carNumber} pitting from P{position}" |
| T2-03 | `competitor:pit_exit` | `payload.position <= config.relevantPositionRange` | "Car {carNumber} out of pits, P{position}" |
| T2-04 | `gap:closing` | `payload.gapSeconds <= config.gapThresholdSeconds` | "Gap closing — {gapSeconds}s to car ahead" |
| T2-05 | `gap:pulling_away` | `payload.gapSeconds >= config.gapThresholdSeconds` | "Gap {gapSeconds}s — you're pulling away" |
| T2-06 | `hero:pace_degradation` | `payload.degradationPct >= config.paceDegradationPctThreshold` | "Pace dropping — {degradationPct}% off your average" |

**Canonical spoken text** is the required TTS input string for each active M4 rule. Implementers MUST use this exact template, substituting `{field}` placeholders with the corresponding payload value at dispatch time. Deviating from these templates makes SC-003/SC-004 qualitative acceptance subjective. M5 rules (T2-02 through T2-06) are included for future reference only; their spoken text is not validated in M4.

---

## Safe-Window Gate Logic

```
function isSafeWindow(lapDistPct: number, zones: RadioBlackoutZone[]): boolean {
  return !zones.some(z => lapDistPct >= z.lapDistPctStart && lapDistPct <= z.lapDistPctEnd);
}
```

- Tier 1 alerts: bypass gate entirely
- Tier 2 alerts: held in queue until `isSafeWindow()` returns true, then dequeued on next telemetry tick

---

## Deduplication Rules

| Alert | Dedup Reset Condition |
|-------|-----------------------|
| `hero:fuel_critical` | Per-lap key expires naturally — dedup key is `hero:fuel_critical:{lapNumber}`, so the alert re-enables on each new lap without needing an explicit clear call. If fuel is still critical the next lap, it fires again. If fuel rises above threshold before the lap ends, no `hero:fuel_critical` event will be published by the race state engine for that condition, so no duplicate fires. No `recordCleared()` call is needed for this alert type. |
| `hero:blue_flag` | `hero:blue_flag_cleared` event received |
| `session:safety_car_deployed` | `session:safety_car_cleared` event received |
| `hero:pit_limiter_active` | `hero:pit_limiter_active` with `payload.active === false` received |
| `hero:pit_window_open` | `hero:pit_exit` event received |
| `competitor:pit_entry` / `competitor:pit_exit` | Per-competitor, per-lap — deferred to M5; carIdx dimension added to dedup key at that point |
| `gap:closing` / `gap:pulling_away` | Gap moves to opposite side of threshold — deferred to M5 |
| `hero:pace_degradation` | Pace recovers below threshold — deferred to M5 |

### Dedup Key Strategy (M4)

Two key strategies, selected by alert type (per FR-006):

| Strategy | Alert types | Key format | Reset mechanism |
|----------|-------------|-----------|-----------------|
| **Per-lap** | `hero:fuel_critical` | `{eventType}:{lapNumber}` | Automatic — new lap = new key = re-enabled. No `recordCleared()` call. |
| **Event-cleared** (persistent) | `hero:blue_flag`, `session:safety_car_deployed`, `hero:pit_limiter_active`, `hero:pit_window_open` | `{eventType}` (no lap number) | Explicit `recordCleared(eventType)` when the clearing event arrives. |

**Why two strategies**: fuel critical has no discrete "recovered" event, so the per-lap key gives it a natural once-per-lap cadence. The event-cleared alerts persist across laps (a blue flag shown for 3 laps should announce once, not every lap) and only reset when their explicit clear event fires — this makes pit window fire exactly once per stint.

**Condition-clear semantics**: `recordCleared(eventType)` removes all entries for that event type. A same-lap re-fire IS permitted when an event-cleared condition clears and re-triggers within the same lap (e.g., blue flag shown → cleared → shown again on lap 5 fires the alert each time).

Dedup key format (M5+): event-cleared alerts extend to `{eventType}:{carIdx|"hero"}` and per-lap alerts to `{eventType}:{carIdx|"hero"}:{lapNumber}` (when competitor alerts activate)

---

## Chattiness Filter

Applied at **dequeue time** (dispatcher tick), not enqueue time — so mid-race Chattiness changes take effect immediately without touching queued alerts:

```
if (chattiness === 'Low' && alert.tier === 2) → discard (log suppression)
```

Tier 1 alerts are never filtered by Chattiness.
