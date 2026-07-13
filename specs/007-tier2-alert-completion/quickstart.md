# Quickstart: Validating Tier 2 Alert Completion

**Feature**: 007-tier2-alert-completion

Two validation layers: unit tests (every rule decision path — Constitution VI requires test-first for agent decision paths) and a live-session check that maps to the spec's success criteria.

## Prerequisites

- Workspace installed: `npm install` at repo root
- For live validation: Redis + hub server running (`infra/docker-compose.yml`, `npm run dev -w apps/hub-server`), Tauri client publishing telemetry, Chatterbox reachable (or watch the structured logs instead of listening)

## Layer 1 — Unit tests

```bash
npm test -w apps/hub-server            # full engineer suite
npm run typecheck && npm run build     # workspace gates (Constitution VI)
```

Required coverage (see [contracts/alert-rules.md](contracts/alert-rules.md) for exact templates and reasons):

| Area | Scenarios that MUST have tests |
|---|---|
| Competitor pit rules | in-window fires with exact template; out-of-window logs `alert_skipped/relevance`; different class skipped; degenerate class data falls back to overall position; missing field entry / empty carNumber logs `identity-unresolved`; entry↔exit clear each other per car (once per visit, re-arms next visit) |
| Gap monitor | closing fires at crossing below T (ahead and behind variants, exact wording); fresh slot disarmed — gap already < T at first observation (green flag / post-overtake) stays silent until observed ≥ T; widening only fires above T+M and only after a closing phase; dead-band oscillation (T…T+M) fires nothing; opposite-boundary re-arm allows second closing alert; adjacency change resets state; cross-class adjacent car skipped (degenerate class data falls back to evaluating); caution / hero-on-pit-road / adjacent-on-pit-road suppress with logged reason; invalid gap resets silently |
| Pace rule | watch transition fires watch template once; critical fires critical template with `{trend}`; repeat events same level deduplicated; `hero:pit_exit` clears both levels (re-arms next stint) |
| Dedup tracker | scoped keys independent per car/level; scoped clear removes one key; scope-less clear removes all of type; existing unscoped behavior unchanged (regression) |
| Queue coalescing | 3 queued entries dequeue as one `{count} cars…` message with `alerts_coalesced` log; 2 merge with two-car template; entries never merge with exits; single alert unchanged; merged item counts once against 30s-drop accounting |
| Service wiring | `evaluateTier2` receives RaceState; competitor events act as clear signal AND alert candidate (no early return); monitor invoked from dispatch tick |

Expected: all new tests green alongside the existing M4/M5 engineer suite — no regressions in the existing `alert-rules`, `message-queue`, `dedup-tracker`, or behavior-named service suites (`degradation`, `proactive-briefings`, `driver-query`, `override`); `racing-engineer.test.ts` and `gap-alert-monitor.test.ts` are NEW in this feature.

## Layer 2 — Live session (maps to spec Success Criteria)

Run a race session with AI or multiplayer traffic (AI race with forced pit stops works well):

1. **SC-001 (relevance)**: Let a pit cycle happen. Confirm every same-class car within ±3 of your position is announced entering/exiting the pits, and cars outside the window produce `alert_skipped { reason: 'relevance' }` log lines, not audio.
2. **SC-002 (latency)**: On a pit entry outside any blackout zone, audio begins ≤ 3s after the car enters pit road (compare `alert_enqueued` → `clip_published` timestamps in hub logs).
3. **SC-003 (dedup)**: A car staying in the pits produces exactly one entry + one exit announcement; a battle hovering near 2.0s produces one closing alert and nothing further until the gap exceeds 2.5s and drops again; a long stint produces at most one watch + one critical pace alert, re-arming after your pit stop.
4. **SC-004 (scoping)**: Watch two AI cars battle away from you — no gap audio. Trigger a full-course caution — no gap audio while the field bunches, with `gap_alert_suppressed { reason: 'caution' }` logged.
5. **SC-005 (audit)**: After the session, grep the hub log: every `competitor:pit_entry`/`pit_exit`/`hero:pace_degradation` event and every monitor boundary crossing maps to exactly one of `alert_enqueued | alert_skipped | alert_deduplicated | gap_alert_suppressed | alerts_coalesced | alert_suppressed | tier2_dropped_no_window`.
6. **SC-006 (completion)**: `grep -n "TODO M5" apps/hub-server/src/engineer/alert-rules.ts` returns nothing.

Config sanity: change `gapThresholdSeconds` to 3.0 in `config/engineer-config.json`, restart the hub, and confirm closing alerts now fire at 3.0s (FR-011 — defaults work untouched, overrides take effect).
