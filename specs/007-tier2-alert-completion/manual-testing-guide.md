# Manual Testing Guide: Tier 2 Alert Completion (007)

**Feature**: `specs/007-tier2-alert-completion` | **Written**: 2026-07-10

A list of test cases to run after implementation. Each case has an **Action**
(with the exact commands) and an **Expected Outcome**. Cases are grouped so you
can run everything on the Mac first (build gates + synthetic event injection),
then finish the live cases on the Windows racing PC.

**How the alerts flow** (what you're observing): race events arrive on the
`hub:events` Redis pub/sub channel → alert rules / gap monitor evaluate →
alerts queue → dispatcher TTS → `clip_published` → Tauri plays the clip. Every
decision emits a structured log line in the hub terminal, so each case below is
verifiable from logs alone; hearing audio additionally requires Chatterbox
reachable and the Tauri client connected.

**Platform notes**:

- Sections 2 and 4 run entirely on the Mac — synthetic events are injected with
  `redis-cli PUBLISH`. Section 3 is marked **[needs iRacing/Windows]**: gap and
  relevance behavior read live `RaceState`, which only exists with telemetry
  flowing. An **AI race** is the right vehicle — you control field size, and AI
  cars actually pit.
- Tee the hub output to a file so the `grep` commands work:
  the setup below uses `tee /tmp/hub-007.log`.
- If Chatterbox (`http://10.0.0.12:8004`) is unreachable you'll see
  `tts_failure` instead of `clip_published` — the alert-decision checks still
  pass; only the audible part is blocked.

---

## 0. Environment setup (once per test run)

1. Start Redis (Postgres not needed for this feature, but harmless):

   ```bash
   docker compose -f infra/docker-compose.yml up -d redis
   ```

2. Install and build (repo root; your npm config needs `--include=dev`):

   ```bash
   npm install --include=dev && npm run build
   ```

3. Start the hub with logs teed to a file (leave running):

   ```bash
   cd apps/hub-server && npm run dev 2>&1 | tee /tmp/hub-007.log
   ```

4. **Precondition — personality Energy > 1** (Energy=1 suppresses ALL Tier 2
   alerts at dequeue and would make every case below silently "fail"):

   ```bash
   docker compose -f infra/docker-compose.yml exec redis redis-cli GET hub:config:personality
   ```

   If `energy` is 1, raise it in the Tauri Setup page (or
   `redis-cli SET hub:config:personality '{"openness":3,"warmth":3,"energy":3,"conscientiousness":3,"assertiveness":3}'`).

5. Optional (to hear audio): start the Tauri client in another terminal —
   `cd apps/tauri-client && npm run tauri dev` — and confirm it's connected to
   the hub.

Shell helper used throughout Section 2 (paste once per terminal):

```bash
pub() { docker compose -f infra/docker-compose.yml exec redis redis-cli PUBLISH hub:events "$1"; }
```

---

## 1. Build & test gates

### TC-01 — Unit suite and workspace gates

- **Action**:

  ```bash
  npm test -w apps/hub-server && npm run typecheck && npm run build
  ```

- **Expected Outcome**: All tests pass, including the new
  `gap-alert-monitor` suite and the extended `alert-rules`, `dedup-tracker`,
  `message-queue`, and `racing-engineer` suites. Typecheck and build clean.

### TC-02 — No stubs remain

- **Action**:

  ```bash
  grep -n "TODO M5" apps/hub-server/src/engineer/alert-rules.ts
  ```

- **Expected Outcome**: No output (exit code 1). The five stub cases are gone.

---

## 2. Synthetic event injection — no iRacing needed (Mac)

> With no telemetry flowing, `RaceState.field` is empty. That's deliberately
> useful: pace-degradation alerts are payload-driven (positive path testable),
> while competitor alerts require identity lookup (negative path testable).

### TC-03 — Pace degradation: watch level fires

- **Action**:

  ```bash
  pub '{"type":"hero:pace_degradation","sessionId":"manual-007","sessionTime":100,"lapNumber":0,"lapDistPct":0,"payload":{"signal":"watch","trend":0.8}}'
  grep -E "alert_enqueued|clip_published" /tmp/hub-007.log | tail -5
  ```

- **Expected Outcome**: `alert_enqueued` with `alertType: hero:pace_degradation`,
  then `clip_generated`/`clip_published`. If the Tauri client is running you
  hear exactly: **"Pace dropping — tires starting to go off"**.

### TC-04 — Pace degradation: same level deduplicates

- **Action**: Re-run the exact `pub` command from TC-03, then:

  ```bash
  grep "alert_deduplicated" /tmp/hub-007.log | tail -3
  ```

- **Expected Outcome**: `alert_deduplicated` with a dedup key of
  `hero:pace_degradation:watch`. No second clip, no second audio.

### TC-05 — Pace degradation: critical level fires with trend value

- **Action**:

  ```bash
  pub '{"type":"hero:pace_degradation","sessionId":"manual-007","sessionTime":200,"lapNumber":0,"lapDistPct":0,"payload":{"signal":"critical","trend":2.34}}'
  ```

- **Expected Outcome**: New `alert_enqueued` (critical is a separate dedup
  scope). Audio/text: **"Pace critical — tires are done, 2.3 seconds off your
  early pace"** (trend rendered to one decimal).

### TC-06 — Pit exit re-arms pace alerts (stint boundary)

- **Action**:

  ```bash
  pub '{"type":"hero:pit_exit","sessionId":"manual-007","sessionTime":300,"lapNumber":5,"lapDistPct":0.1,"payload":{"lapNumber":5,"carIdx":0}}'
  pub '{"type":"hero:pace_degradation","sessionId":"manual-007","sessionTime":400,"lapNumber":0,"lapDistPct":0,"payload":{"signal":"watch","trend":0.6}}'
  ```

- **Expected Outcome**: The second command produces a fresh `alert_enqueued`
  (watch key was cleared by `hero:pit_exit`) — the watch alert fires again for
  the new stint. TC-03's audio line plays again.

### TC-07 — Competitor pit entry with unresolvable identity is skipped, not announced

- **Action**:

  ```bash
  pub '{"type":"competitor:pit_entry","sessionId":"manual-007","sessionTime":500,"lapNumber":8,"lapDistPct":0.5,"payload":{"lapNumber":8,"carIdx":42}}'
  grep "alert_skipped" /tmp/hub-007.log | tail -3
  ```

- **Expected Outcome**: `alert_skipped` with `reason: 'identity-unresolved'`
  and `carIdx: 42` (no live race state ⇒ no field entry for car 42). No clip is
  generated — the engineer never announces a placeholder like "Car unknown".

### TC-08 — Every synthetic event is accounted for (no silent failures)

- **Action**:

  ```bash
  grep -cE "alert_enqueued|alert_skipped|alert_deduplicated|gap_alert_suppressed|alerts_coalesced|alert_suppressed|tier2_dropped_no_window" /tmp/hub-007.log
  ```

- **Expected Outcome**: Count ≥ the number of alert-candidate events you
  published in TC-03…TC-07 (5). Every event maps to a logged decision.

---

## 3. Live AI race **[needs iRacing/Windows]**

**Session recipe**: single-class AI race, ~10–15 AI drivers, a short course
(e.g., Okayama Short / Lime Rock), race length 20–30 min with **fuel required
and tire wear on** so AI cars make real pit stops. Set AI strength spread wide
enough that you naturally catch and get caught (±10% around your pace). Start
mid-field. Hub + Tauri running as in Section 0, telemetry publishing.

### TC-09 — Relevant competitor pit entry announced (SC-001, SC-002)

- **Action**: Race until a same-class car within ±3 positions of you enters
  the pits (the AI pit cycle makes this reliable). Watch the hub log.
- **Expected Outcome**: You hear **"Car {number} pitting from P{position}"**
  with the correct car number and position. Log shows `alert_enqueued` →
  `clip_published` with timestamps ≤ 3s apart (outside a blackout zone).

### TC-10 — Same car's pit exit announced; once per visit (SC-003)

- **Action**: Wait for the same car to leave pit road.
- **Expected Outcome**: One **"Car {number} out of pits, P{position}"**. Exactly
  one entry + one exit announcement for that visit — check with:

  ```bash
  grep "alert_enqueued" /tmp/hub-007.log | grep "competitor:pit"
  ```

  > Note: relevance is re-evaluated at exit time. If the car dropped outside
  > ±3 of your position during its stop (common — a pit stop costs several
  > positions), the exit is correctly skipped with
  > `alert_skipped { reason: 'relevance' }` even though the entry was
  > announced. That asymmetry is specified behavior (FR-002), not a bug.

### TC-11 — Out-of-window car is suppressed with a logged reason (SC-001)

- **Action**: When a car well outside ±3 of your position pits (e.g., the
  leader while you run P10), check:

  ```bash
  grep "alert_skipped" /tmp/hub-007.log | grep relevance | tail -3
  ```

- **Expected Outcome**: `alert_skipped { reason: 'relevance', carIdx: … }` for
  that car; no audio.

### TC-12 — Coalesced announcement during a pit-cycle burst (FR-014)

- **Action**: Opportunistic — most likely when several nearby AI pit on the
  same lap (common at fuel-window laps or under caution). Afterwards:

  ```bash
  grep "alerts_coalesced" /tmp/hub-007.log
  ```

- **Expected Outcome**: If ≥2 same-kind alerts were pending together, one
  combined message — **"Cars {a} and {b} are pitting"** (two) or
  **"{count} cars around you are pitting"** (three-plus) — and an
  `alerts_coalesced` log with `mergedCount` and car numbers. If the burst never
  happens naturally, rely on the unit test (TC-01) for this behavior.

### TC-13 — Gap closing on the car ahead (SC-002)

- **Action**: Catch the car ahead: close from >2.5s to under 2.0s.
- **Expected Outcome**: Exactly one **"Gap closing — {gap} seconds to the car
  ahead"** as you first cross 2.0s, delivered ≤ 3s after the crossing (or at
  the next safe window).

### TC-14 — Dead band: no chatter while hovering (SC-003)

- **Action**: Hold the gap oscillating between ~2.0s and ~2.5s for several
  laps (lift slightly on straights to manage it).
- **Expected Outcome**: No further gap announcements in either direction while
  the gap stays inside 2.0–2.5s.

### TC-15 — Widening re-arm cycle: pulling away, then a second closing alert

- **Action**: After a closing alert for the car behind (defend until it fires),
  pull the gap out past 2.5s; then let them close under 2.0s again.
- **Expected Outcome**: One **"Gap {gap} seconds — you're pulling away"** as
  you cross 2.5s, then one fresh **"Car behind closing — gap {gap} seconds"**
  on the second sub-2.0s crossing. Losing-touch variant (**"Losing touch — gap
  {gap} seconds to the car ahead"**) fires analogously if the car ahead breaks
  away after TC-13.

### TC-16 — No gap alerts for other cars' battles (SC-004)

- **Action**: Watch (or replay) a phase where two AI cars battle several
  positions away from you.
- **Expected Outcome**: No gap audio and no gap `alert_enqueued` lines for
  that pair — gap alerts only ever reference the cars adjacent to you.

### TC-17 — Gap alerts suppressed under caution and on pit road (SC-004)

- **Action**: When a full-course caution occurs (AI races produce them; be
  patient) — or, deterministically, drive down pit road during a battle — then:

  ```bash
  grep "gap_alert_suppressed" /tmp/hub-007.log | tail -5
  ```

- **Expected Outcome**: No gap audio while the field bunches under caution /
  while you're on pit road; log shows `gap_alert_suppressed` with
  `reason: 'caution'` or `'hero-on-pit-road'`.

### TC-18 — Post-session audit sweep (SC-005)

- **Action**: After the race:

  ```bash
  grep -E "competitor:pit_(entry|exit)|hero:pace_degradation" /tmp/hub-007.log | grep -v clip | wc -l
  grep -cE "alert_enqueued|alert_skipped|alert_deduplicated|alerts_coalesced|alert_suppressed|tier2_dropped_no_window|gap_alert_suppressed" /tmp/hub-007.log
  ```

- **Expected Outcome**: Every triggering event has a corresponding decision
  line — no alert-candidate event vanished without a logged outcome.

---

## 4. Configuration (Mac or Windows)

### TC-19 — Defaults work untouched (FR-011)

- **Action**:

  ```bash
  grep -E "relevantPositionRange|gapHysteresisMarginSeconds|gapThresholdSeconds" apps/hub-server/config/engineer-config.json
  ```

  Then start the hub with no config edits.

- **Expected Outcome**: Fields present with defaults `3`, `0.5`, `2.0`; hub
  starts clean with no config warnings.

### TC-20 — Threshold override takes effect (FR-011)

- **Action**: Edit `apps/hub-server/config/engineer-config.json`: set
  `gapThresholdSeconds` to `3.0`. Restart the hub (Ctrl-C, re-run the dev
  command from Section 0). Repeat TC-13 (live) — or verify via the unit suite's
  configurable-threshold test if off the sim.
- **Expected Outcome**: Closing alerts now fire at the 3.0s crossing (dead band
  3.0–3.5s). Revert the config afterwards.

### TC-21 — Invalid config is rejected loudly

- **Action**: Set `relevantPositionRange` to `-1`, restart the hub, watch the
  first lines of output. Revert afterwards.
- **Expected Outcome**: The hub fails fast (or logs a clear config-validation
  error naming the field) — it does not start silently with a nonsense window.

---

## 5. Regression (Mac, synthetic)

### TC-22 — M4 alerts still work through the same pipeline

- **Action**:

  ```bash
  pub '{"type":"hero:fuel_critical","sessionId":"manual-007","sessionTime":600,"lapNumber":12,"lapDistPct":0.2,"payload":{"lapsRemaining":0.8}}'
  pub '{"type":"hero:blue_flag","sessionId":"manual-007","sessionTime":610,"lapNumber":12,"lapDistPct":0.3,"payload":{}}'
  ```

- **Expected Outcome**: Both fire exactly as before this feature —
  **"Fuel critical — 0.8 laps remaining"** (Tier 1, immediate) and
  **"Blue flag — let them by"**. The `evaluateTier2` signature change did not
  disturb the Tier 1 path or existing Tier 2 pit-window behavior (covered by
  the unit suite in TC-01).

---

## Result log

| TC | Pass/Fail | Notes |
|----|-----------|-------|
| 01 |  |  |
| 02 |  |  |
| 03 |  |  |
| 04 |  |  |
| 05 |  |  |
| 06 |  |  |
| 07 |  |  |
| 08 |  |  |
| 09 |  |  |
| 10 |  |  |
| 11 |  |  |
| 12 |  |  |
| 13 |  |  |
| 14 |  |  |
| 15 |  |  |
| 16 |  |  |
| 17 |  |  |
| 18 |  |  |
| 19 |  |  |
| 20 |  |  |
| 21 |  |  |
| 22 |  |  |
