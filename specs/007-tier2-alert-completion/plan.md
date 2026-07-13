# Implementation Plan: Tier 2 Alert Completion — Competitor Pit, Gap, and Pace Alerts (+ Weather Telemetry Passthrough)

**Branch**: `007-tier2-alert-completion` | **Date**: 2026-07-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/007-tier2-alert-completion/spec.md`

## Summary

Activate the five Tier 2 alert rules stubbed since M4 (`competitor:pit_entry`, `competitor:pit_exit`, `gap:closing`, `gap:pulling_away`, `hero:pace_degradation`) in the hub server's Racing Engineer service. All work is confined to `apps/hub-server/src/engineer/` plus shared types and config:

- **Competitor pit alerts** (event-driven): consume the existing `competitor:pit_entry`/`pit_exit` events, filter by a class-position relevance window around the hero (±3 default), resolve car number/position from live `RaceState`, dedup per car per pit visit, and coalesce same-kind announcements pending together into one message at dequeue time.
- **Gap alerts** (state-driven): a new `GapAlertMonitor` polls `RaceState` on the existing dispatch cadence, computes the hero's gap to the **same-class** position-adjacent cars ahead and behind from `gapToLeader` deltas, and runs a per-direction hysteresis state machine (closing fires below `gapThresholdSeconds`; widening fires above threshold + new `gapHysteresisMarginSeconds`; dead band between; fresh slots start disarmed until the gap is observed at ≥ threshold). The gap model's `gap:closing`/`gap:pulling_away` *events* are NOT used as triggers — see research.md R1 for why.
- **Pace degradation alert** (event-driven): consume the already-transition-only `hero:pace_degradation` event, one announcement per level (watch/critical) per stint, re-armed by `hero:pit_exit`.

**Scope addition (2026-07-10)** — **Weather telemetry passthrough**: populate the currently-placeholder `session.weather` in `RaceState` with live sim weather so external stream overlays (specifically the `weather.html` OBS overlay, needed for an upcoming live stream) can poll it via the existing `GET /api/race-state` endpoint (CORS already enabled). This is the one part of this feature that touches the Tauri collector and the pipeline: the collector adds the iRacing weather vars to its 15Hz session-rate field set, and the hub session processor maps them into `session.weather` before the existing KV snapshot write. No new endpoints and no alert-path involvement.

Alert work requires no pipeline, Tauri, or infra changes; the weather passthrough is the sole exception (collector field set + one pipeline mapping). New config fields: `relevantPositionRange`, `gapHysteresisMarginSeconds`.

## Technical Context

**Language/Version**: TypeScript 5.x (ES2022 modules, NodeNext resolution), Node.js 20+

**Primary Dependencies**: ioredis (hub:events pub/sub — existing), `@iracing-engineer/types` (workspace), existing engineer modules (`PriorityMessageQueue`, `DedupTracker`, `alert-rules`, TTS client)

**Storage**: none new — no Postgres change (rule-based path, no LLM inference; see Constitution Check V)

**Testing**: mocha + chai unit tests under `apps/hub-server/tests/unit/engineer/`

**Target Platform**: hub server (Node.js process, LAN deployment)

**Project Type**: monorepo service feature (single workspace app touched + shared types package)

**Performance Goals**: Tier 2 delivery ≤ 3s from triggering condition when a safe window is open (Constitution I); GapAlertMonitor evaluation is an O(field size) scan (≤ 64 cars, `field` is keyed by carIdx) to locate the two position-adjacent cars, then O(1) state-machine work — negligible on the existing 100ms dispatch interval

**Constraints**: no LLM calls in the alert path; silence preferable to wrong-and-late; every non-delivery decision logged (no silent failures)

**Scale/Scope**: ~64-car field max (iRacing cap); 5 alert rules; ~6 source files touched, 1 new module, 1 new/extended test file set. Weather passthrough adds: 1 Rust collector file (field-set addition), 2 hub files (pipeline mapping + state `updateWeather()` mutator), 2 types files (`WeatherState` + `SessionTelemetryData` extensions) — 8 weather vars flowing at the existing 15Hz session rate (negligible payload growth)

## Constitution Check

*GATE: evaluated against constitution v1.2.2 — PASS (pre-research and post-design); re-affirmed against v1.2.3 (2026-07-11 — the Principle I PATCH ratifies exactly the safe-window-gated delivery this plan and FR-009/FR-010 already describe). No Complexity Tracking entries needed.*

| Principle | Assessment |
|---|---|
| I. Real-Time Reliability | PASS — rule-based path only, 3s Tier 2 budget unchanged; no LLM in path; monitor failure degrades to silence (alerts simply don't fire; errors logged). No Stream Engineer coupling. |
| II. Workspace Isolation | PASS — type changes go to `packages/types` (`EngineerConfig`, dedup key doc comments, `WeatherState` extension); hub-server consumes via the contract layer; no cross-app imports. The weather passthrough crosses the collector→hub boundary only via the existing Redis stream contract (new fields on `iracing:telemetry:session`, documented in the stream contract doc). |
| III. Agent Autonomy Contract | PASS — advisory voice alerts only; no prompts added or changed (no evaluation suite needed); no irreversible actions. |
| IV. Local-First Infrastructure | PASS — no new infrastructure; no cloud dependency. |
| V. Observability-Driven | PASS — no LLM inference ⇒ the Postgres audit gate does not apply (it binds LLM-backed capabilities; project-owner ruling 2026-07-10, ratified as constitution v1.2.2 — the post-M5 ambiguity in the prior "exempt until M5" wording is resolved at the source). The "no silent failures" rule DOES apply: every fired / relevance-suppressed / caution-suppressed / pit-road-suppressed / deduplicated / coalesced / identity-missing / queue-dropped decision emits a structured log entry (FR-012); this extends the existing M4 pattern (`alert_enqueued`, `alert_deduplicated`, `alert_suppressed`, `tier2_dropped_no_window`). |
| VI. Test-Backed Change | PASS — behavioral change to an agent decision path ⇒ test-first REQUIRED. Unit tests enumerated in quickstart.md; workspace `npm run build` / `typecheck` / lint gates before merge. |
| VII. Incremental Delivery (YAGNI) | PASS — one agent (Racing Engineer) touched; no speculative config (the M4-reserved percentage-threshold fields for pace degradation are deliberately NOT added); every new config field has an immediate consumer. Every weather field added has an immediate consumer too: the `weather.html` stream overlay (icon selection needs `skies`/`precipitation`/`fogLevel`; on-screen conditions need air/track temp, wind, humidity). No forecast data, no weather history, no weather-driven alerts — display passthrough only. |

## Project Structure

### Documentation (this feature)

```text
specs/007-tier2-alert-completion/
├── plan.md              # This file
├── research.md              # Phase 0 — design decisions R1–R6
├── data-model.md            # Phase 1 — types, config, dedup keys, monitor state
├── quickstart.md            # Phase 1 — validation guide
├── contracts/
│   └── alert-rules.md       # Phase 1 — rule table, spoken-text templates, dedup & suppression contract
├── manual-testing-guide.md  # post-implementation test cases (TC-01–TC-22)
├── checklists/
│   └── requirements.md      # spec quality checklist
└── tasks.md                 # Phase 2 (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
packages/types/src/
├── engineer.ts                      # EngineerConfig: + relevantPositionRange, + gapHysteresisMarginSeconds
├── race-state.ts                    # WeatherState: + trackTempCelsius, windDirRad, skies (typed union),
│                                    #   precipitation, fogLevel
└── telemetry.ts                     # SessionTelemetryData: + weather fields (present in driver AND
                                     #   observer mode — global sim vars, not hero-only)

apps/tauri-client/src-tauri/src/telemetry/
└── publisher_task.rs                # SESSION_RATE_FIELDS: + AirTemp, TrackTempCrew, RelativeHumidity,
                                     #   WindVel, WindDir, Skies, Precipitation, FogLevel

apps/hub-server/
├── config/engineer-config.json      # + relevantPositionRange: 3, + gapHysteresisMarginSeconds: 0.5
└── src/engineer/
    ├── alert-rules.ts               # T2-02/03 (competitor pit) + T2-06 (pace degradation) activated;
    │                                #   gap cases removed from the event path (handled by monitor);
    │                                #   rules gain RaceState access + structured suppression logging
    ├── gap-alert-monitor.ts         # NEW — hero-adjacent gap hysteresis state machine (T2-04/05)
    ├── dedup-tracker.ts             # scope dimension: dedupKeyFor(eventType, lapNumber, scope?);
    │                                #   recordCleared(eventType, scope?)
    ├── message-queue.ts             # dequeue-time coalescing of same-kind competitor pit alerts (FR-014)
    ├── personality-config.ts        # loadEngineerConfig: defaults + fail-fast validation for the two new fields
    └── racing-engineer.ts           # wire monitor into dispatchTick; per-car dedup clear signals;
                                     #   evaluateTier2 call site passes RaceState

apps/hub-server/src/
├── pipeline/session-processor.ts    # map incoming weather fields → updateWeather() each cycle
│                                    #   (flows to /api/race-state via the existing writeKvSnapshot)
└── state/race-state.ts              # + updateWeather(weather: WeatherState) mutator

apps/hub-server/tests/unit/engineer/
├── alert-rules.test.ts              # extended: relevance window, identity fallback, pace levels
├── gap-alert-monitor.test.ts        # NEW — dead band, re-arm, direction wording, suppressions
├── dedup-tracker.test.ts            # extended: scoped keys, scoped clear
├── message-queue.test.ts            # extended: coalescing semantics
└── racing-engineer.test.ts          # NEW — service wiring (clear signals, monitor integration); service
                                     #   behavior today lives in behavior-named suites (degradation/
                                     #   proactive-briefings/driver-query/override.test.ts)

apps/hub-server/tests/unit/pipeline/
└── session-processor.test.ts        # extended: weather mapping (skies union, per-field no-regress,
                                     #   1:1 unit passthroughs)
```

**Structure Decision**: All alert logic lands in the existing `apps/hub-server/src/engineer/` module group beside the M4/M5 alert machinery it extends; the only new file is `gap-alert-monitor.ts`. The weather passthrough follows the established collector→stream→pipeline→KV path with no new files at all — only field additions along it. Shared contract changes flow through `packages/types` per Constitution II.

## Design Overview

### Event-driven rules (competitor pit, pace degradation)

`evaluateTier2` changes signature from `(event, signals, config)` to `(event, state: RaceState, config)` — `signals` remains reachable as `state.signals`, and the new rules need `state.field` / `state.hero` for car number, class, and position resolution. The one existing call site in `racing-engineer.ts` is updated, along with `alert-rules.test.ts` and whichever behavior-named service suites exercise that call site (there is no `racing-engineer.test.ts` today — this feature introduces it for wiring tests).

- **T2-02/T2-03 relevance**: competitor is relevant iff `sameClass(competitor, hero)` and `|classPos(competitor) − classPos(hero)| ≤ config.relevantPositionRange`. Single-class / missing-class fallback per research.md R4.
- **Identity**: `state.field[payload.carIdx]` supplies `carNumber` and position. Missing entry or empty car number ⇒ rule returns null and logs `alert_skipped` with `reason: 'identity-unresolved'` (FR-012, edge case "Missing car identity").
- **T2-06**: consumes `hero:pace_degradation` (already fires only on transition into watch/critical). Dedup key is scoped per level: `hero:pace_degradation:watch` / `:critical`; both cleared on `hero:pit_exit` (stint boundary — exactly the FR-008 "once per level per stint" semantics; see research.md R5).

### Gap alerts — `GapAlertMonitor` (state-driven)

The gap model's events encode battle-status transitions at hard-coded 1.0s/1.5s constants and cannot express "first crossing of the configurable 2.0s threshold" (research.md R1). Instead, a small monitor is invoked from the existing 100ms `dispatchTick`:

1. Read `RaceState`; locate hero and the position-adjacent cars ahead (`position − 1`) and behind (`position + 1`).
2. Compute `gapAhead = hero.gapToLeader − ahead.gapToLeader`, `gapBehind = behind.gapToLeader − hero.gapToLeader`.
3. Per direction, run the hysteresis machine (boundaries: `T = gapThresholdSeconds`, `M = gapHysteresisMarginSeconds`):
   - initial state: closing **disarmed**, widening **disarmed** — closing arms on the first observation of gap ≥ T without firing (FR-004 crossing semantics: green flag / post-overtake gaps already under T stay silent); widening only ever arms after a closing fire (FR-005 "first opens beyond" requires a prior closing phase);
   - gap < T and closing armed ⇒ fire closing alert, disarm closing, arm widening;
   - gap > T + M and widening armed ⇒ fire widening alert, disarm widening, re-arm closing;
   - T ≤ gap ≤ T + M (dead band) ⇒ no transitions (other than the initial arming above).
4. Reset a direction's state when the adjacent car changes (different `carIdx`), when the adjacent car is a different class (valid class data — clarified 2026-07-10, same degenerate-data fallback as pit relevance), or when either car's gap data is invalid. These standing non-battle conditions are not logged per tick.
5. During suppression conditions (`session.sessionPhase === 'Caution'`, `hero.onPitRoad`, or the adjacent car on pit road) evaluation CONTINUES with firing replaced by logging: a would-fire crossing emits `gap_alert_suppressed {reason}` and applies the same arm/disarm transitions (satisfies US2-AC7 — a gap compressing below T mid-caution produces the log). When the suppression condition clears, the slot resets to disarmed so the restart requires a fresh ≥ T observation. Fired alerts enqueue as standard `QueuedAlert`s with eventType `gap:closing` / `gap:pulling_away`; direction-specific wording per the contract.

Deduplication for gap alerts lives in the monitor's arm/disarm state (the DedupTracker is not consulted — the state machine IS the dedup, per data-model.md).

### Coalescing (FR-014)

Same-kind competitor pit alerts (`competitor:pit_entry` × N, or `pit_exit` × N) **pending simultaneously in the Tier 2 queue** are merged at dequeue time into a single `QueuedAlert` whose text follows the coalesced templates (contract §Canonical spoken-text templates). Dequeue-time merge matches FR-014's "pending at the same time" exactly and adds zero latency; per-car dedup was already recorded at enqueue. Merge is a `PriorityMessageQueue` concern; a merged message counts as the one dequeued item.

### Config

`relevantPositionRange: 3` and `gapHysteresisMarginSeconds: 0.5` added to `EngineerConfig` (types), `engineer-config.json` (defaults), and the config loader's validation. `gapThresholdSeconds` finally gets its consumer (it has been a placeholder since M4).

### Weather telemetry passthrough (stream-overlay consumer)

Today `session.weather` is set once to a hardcoded placeholder on session start (`session-event-processor.ts`) and never updated; the collector reads no weather vars at all. The passthrough is a straight pipe with no new transport, storage, or endpoints:

1. **Collector** (`publisher_task.rs`): add to `SESSION_RATE_FIELDS` — `AirTemp` (°C), `TrackTempCrew` (°C), `RelativeHumidity` (0–1), `WindVel` (m/s), `WindDir` (rad), `Skies` (0–3 enum), `Precipitation` (0–1), `FogLevel` (0–1). All are global sim vars available in both driver and observer mode, so they publish unconditionally (not hero-gated). Field names must be verified against `sdk.enumerate_vars()` per the existing test pattern in `publisher_task.rs`.
2. **Types** (`packages/types`): extend `SessionTelemetryData` with the raw fields and `WeatherState` with `trackTempCelsius`, `windDirRad`, `precipitation`, `fogLevel`; `skies` becomes the typed union `'Clear' | 'PartlyCloudy' | 'MostlyCloudy' | 'Overcast'` mapped from the 0–3 enum. Existing fields (`tempCelsius`, `humidity`, `windSpeedMs`) keep their meaning; `tempCelsius` is air temp.
3. **Hub pipeline** (`session-processor.ts` + `state/race-state.ts`): each session-telemetry cycle maps the incoming fields through a new `updateWeather()` mutator before the existing `writeKvSnapshot` call, so the values ride the KV snapshot that `GET /api/race-state` already serves (CORS enabled 2026-07-10). Missing/absent weather fields (older collector build) leave the previous weather value untouched — never regress to the placeholder.
4. **Consumer**: the `weather.html` OBS overlay polls `/api/race-state` and derives its icon (`sun`/`cloud`/`rain`/`fog`) and conditions string client-side: `fogLevel` dominant ⇒ fog; `precipitation > 0` ⇒ rain; else `skies` picks sun vs. cloud. The overlay itself lives outside this repo (streaming assets) and is not part of this feature's deliverable — the hub-side contract is: fresh, truthful `session.weather` at session-telemetry cadence (15Hz upstream; KV snapshot cadence at the API).

**Non-goals**: no weather forecast (WeekendInfo forecast blocks), no weather history/trending, no weather-driven engineer alerts, no dedicated `/api/weather` endpoint. If a weather alert (e.g. "rain incoming") is wanted later, it builds on this state without rework.

**Testing**: unit test the enum/field mapping in the session processor (skies union, absent-field no-regress behavior); collector field-name assertions extend the existing `SESSION_RATE_FIELDS` test in `publisher_task.rs`.

## Complexity Tracking

No constitution violations — table not required.
