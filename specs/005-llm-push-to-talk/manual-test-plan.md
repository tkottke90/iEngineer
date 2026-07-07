# M5 Manual Test Plan — Racing Engineer: LLM + Push-to-Talk

A hands-on plan to verify the M5 changes on your rig. Most hub behaviors can be
driven with `redis-cli` (no live race needed); a few (override tracking, accurate
fuel/tire answers) need live or simulated telemetry. Check each box as you go.

**Legend:** 🧪 automated · 💉 event-injection (redis-cli) · 🎧 needs audio/mic ·
🏁 needs live/simulated race · ⏱ latency-sensitive

---

## 0. How to use this

- Run **Section 2 (automated)** first — it's the fastest confidence check.
- For **Section 3**, keep three terminals open:
  1. **Hub logs:** `cd apps/hub-server && npm start` (or `tail -f apps/hub-server/logs/hub.jsonl`)
  2. **Audio out monitor:** `redis-cli SUBSCRIBE voice:audio`
  3. **Injector:** where you run the `redis-cli PUBLISH …` commands
- Each test lists the log line(s) to watch for. `[engineer]`/`[stt]`/`[hub]` prefixes
  are the M5 signals.

---

## 1. One-time setup

- [X] **Infra up:** `docker compose -f infra/docker-compose.yml up -d redis postgres chatterbox`
- [X] **Postgres reachable:** `psql "$DATABASE_URL" -c '\dt'` (or the compose defaults
      `postgresql://iracing:iracing@localhost:5432/iracing_engineer`)
- [X] **Install + build:** `npm install && npm run build`
- [X] **Whisper model:** `bash apps/tauri-client/src-tauri/models/download.sh`
      (~142 MB; sets up `ggml-base.en.bin`). If launching the client from another
      cwd, set `WHISPER_MODEL_PATH=/abs/path/ggml-base.en.bin`.
- [X] **LLM config:** confirm `apps/hub-server/config/engineer-config.json` →
      `llm.baseUrl` = `https://lemonade.tdkottke.com/v1`, `llm.model` =
      `user.Ornith-1.0-35B-GGUF`, and the endpoint is reachable:
      `curl -s $BASEURL/models | head`
- [X] **Chatterbox reachable:** `curl -s http://10.0.0.12:8004/health` (or your URL
      in `chatterboxUrl`)
- [X] **Env:** the hub auto-loads the repo-root `.env` at startup (walks up from cwd)
      → expect `[hub] Loaded environment {file: …/.env}`. Ensure `.env` has
      `DATABASE_URL` (defaults to `postgresql://iracing:iracing@localhost:5432/iracing_engineer`),
      or `export DATABASE_URL=…` to override.
- [X] **Start the hub:** `cd apps/hub-server && npm start` → expect
      `[hub] engineer_events migrations applied` and `[hub] Racing Engineer started`.
      If you instead see `engineer_events migrations failed` or `audit pre-write
      failed … client password must be a string`, Postgres auth/URL is wrong — fix
      `DATABASE_URL` and **restart the hub**.

---

## 2. Automated verification 🧪

- [X] **Hub unit + integration tests:** `npm test -w apps/hub-server` → **122 passing**.
- [X] **Postgres round-trip (integration):** `npm run test:integration -w apps/hub-server`
      → the `engineer_events` round-trip test passes (skips only if PG is down).
- [X] **Rust STT tests:** `cargo test --manifest-path apps/tauri-client/src-tauri/Cargo.toml stt::`
      → 4 passing (resample + is_speech).
- [X] **Personality + tool-calling evals** (live LLM): `npm run eval -w apps/hub-server`
      → tool-calling: fuel/tire questions call the tools; personality: each trait's
      direction holds ≥4/5. (Skips if the LLM is unreachable.)
- [X] **Gates:** `npm run typecheck` and `npm run build` are clean.

---

## 3. Manual functional tests

### A. On-demand PTT query — hub side 💉 (US1)

- [X] **A1 — Driver query end-to-end (plumbing).** Inject a transcript as if STT ran:
  ```
  redis-cli PUBLISH engineer:query '{"queryId":"t1","transcript":"do we pit this lap?","sessionId":"s1","capturedAtMs":0}'
  ```
  **Expect:** hub logs an `engineer_events` insert, one or more `[engineer] Clip published`
  lines with `tier:3`, and the `voice:audio` monitor prints `AudioClipRef`(s) with
  `"tier":3,"tier3Type":"driver-query"`. Chatterbox produces audio clips.
  *(Without a live race, tools report "not available" and the answer will say so —
  that's correct, not a bug.)*

- [X] **A2 — Empty transcription guard (FR-004).**
  ```
  redis-cli PUBLISH engineer:query '{"queryId":"t2","transcript":"   ","sessionId":"s1","capturedAtMs":0}'
  ```
  **Expect:** `[engineer] PTT query ignored — empty transcript`; **no** `voice:audio`.

- [X] **A3 — Concurrency cap (Q4).** With Ornith-35B (slow), fire several fast:
  ```
  for i in 1 2 3 4 5; do redis-cli PUBLISH engineer:query "{\"queryId\":\"q$i\",\"transcript\":\"status?\",\"sessionId\":\"s1\",\"capturedAtMs\":0}"; done
  ```
  **Expect:** at least one `[engineer] PTT query dropped — queue depth cap reached`
  (`reason:"queue-cap-drop"`) once more than `queueDepthCap` (default 3) are pending.

### B. Proactive Tier 3 briefings 💉 (US2)

- [X] **B1 — Pit-lane entry briefing.**
  ```
  redis-cli PUBLISH hub:events '{"type":"hero:pit_entry","sessionId":"s1","sessionTime":0,"lapNumber":5,"payload":{}}'
  ```
  **Expect:** a `voice:audio` clip with `"tier3Type":"pit-entry"`.

- [X] **B2 — Safety car: immediate Tier 1 + additive Tier 3 (FR-016).**
  ```
  redis-cli PUBLISH hub:events '{"type":"session:safety_car_deployed","sessionId":"s1","sessionTime":0,"lapNumber":5,"payload":{}}'
  ```
  **Expect:** first a Tier 1 clip (`"tier":1,"eventType":"session:safety_car_deployed"`),
  then a Tier 3 `"tier3Type":"safety-car"` briefing.

- [X] **B3 — Post-sector cadence.** Publish `hero:lap_complete` several times:
  ```
  for l in 1 2 3 4; do redis-cli PUBLISH hub:events "{\"type\":\"hero:lap_complete\",\"sessionId\":\"s1\",\"sessionTime\":0,\"lapNumber\":$l,\"payload\":{}}"; done
  ```
  **Expect:** a `post-sector` briefing roughly every `postSectorMinLapGap` laps
  (default 2), **not** every lap.

### C. Personality 🎧 (US3)

- [X] **C1 — Energy=1 suppresses commentary.** Set the trait directly:
  ```
  redis-cli SET hub:config:personality '{"openness":3,"warmth":3,"energy":1,"conscientiousness":3,"assertiveness":3}'
  ```
  Then repeat **B3**. **Expect:** `[engineer] Tier 3 suppressed at Energy 1`; **no**
  post-sector clips. (A direct **A1** driver-query still answers — Energy=1 only
  suppresses unsolicited commentary.)

- [X] **C2 — Direction is audible.** Reset to a chatty/assertive profile
  `'{"openness":3,"warmth":5,"energy":5,"conscientiousness":5,"assertiveness":5}'`
  vs a terse one `'…"energy":1…"assertiveness":1…'`, and compare the answer to the
  same **A1** query. **Expect:** high-energy/assertive is longer and more directive.

- [X] **C3 — UI panel.** In the Tauri client → Setup → **Engineer Personality**: move
  the five sliders, click **Save**. **Expect:** `redis-cli GET hub:config:personality`
  reflects the new values; the hub picks them up on the next synthesis.

### D. Graceful degradation 💉 (US7)

- [X] **D1 — LLM down.** Point `llm.baseUrl` at a dead URL (or stop the endpoint) and
  restart the hub. Then:
  - Inject **B1/B2** → `[engineer] Tier 3 skipped — LLM unavailable`; safety car's
    **Tier 1 alert still fires** (rule path unaffected, SC-003).
  - Inject **A1** → a brief canned "reasoning engine unavailable" clip is published.
  - Verify `engineer_events` rows have `outcome = 'skipped-llm-unreachable'`.
- [X] **D2 — Recovery.** Restore `llm.baseUrl`, restart, inject **A1** → normal
  synthesis resumes (no code change needed).

### E. Override, deference, memory 🏁 (US4/US5/US6)

> These need `signals.pitWindowOpen = true`, which comes from live/simulated
> telemetry (the pit-window-open alert is the pit recommendation). The deterministic
> logic is already covered by `override.test.ts` / `deference.test.ts` /
> `session-memory-context.test.ts`; the steps below confirm it end-to-end.

- [ ] **E1 — Override recorded.** In a live/simulated race, reach the pit window
  (engineer says the window is open) but **do not pit**; let the lap complete.
  **Expect:** `[engineer] Recommendation logged` then `[engineer] Pit recommendation
  overridden — engineer will stop advocating`; the pit call is **not** repeated
  (SC-006).
- [ ] **E2 — Followed.** Repeat but **do** pit within the window → `[engineer] Pit
  recommendation followed` (no override counted).
- [ ] **E3 — Deference.** Override the pit call twice in one session → `[engineer]
  Entering deference (information) mode for recommendation type` (`type:"pit"`);
  subsequent unsolicited pit talk becomes informational, but a direct PTT "should I
  pit?" still gives a direct answer.
- [ ] **E4 — Memory in context.** After E1, ask a related question via PTT →
  the answer reflects that you stayed out (the recommendation/outcome is in context).

---

## 4. Latency check ⏱ (SC-001) — important

- [ ] With the LLM reachable, time an **A1** driver-query from publish to the first
  `voice:audio` clip (watch timestamps on the `SUBSCRIBE voice:audio` monitor, or the
  `[engineer] Clip published` log time). **Target: first audio ≤ 5 s.**
- [ ] ⚠️ **Ornith-35B risk:** it's larger than the 9B model POC-0003 measured
  (~2.7 s TTFT). If first-audio exceeds ~5 s, swap `llm.model` in
  `engineer-config.json` to a smaller/faster model on the same endpoint
  (config-only, no code change) and re-check.

---

## 5. Full deploy test 🏁🎧⏱ (SC-010)

- [ ] Drive a race stint with iRacing running and the Tauri client connected.
- [ ] Confirm the PTT global shortcut registered: client log
      `[stt] global PTT shortcut registered` (if it says *failed … check OS
      accessibility permission*, grant Accessibility/Input Monitoring to the app).
- [ ] Hold PTT, ask **"Do we pit this lap?"**, release. **Expect:** `[stt] Whisper
      base.en loaded — PTT ready` (once at start), then `[stt] PTT query published to
      engineer:query`, and a spoken briefing whose **first audio is heard < 5 s** after
      release, referencing real fuel/tire numbers.
- [ ] Elicit a pit recommendation, **override it**, and confirm the engineer **stops
      repeating** the call.

---

## 6. Postgres audit verification (SC-008)

- [ ] After any synthesis, inspect the audit table:
  ```
  psql "$DATABASE_URL" -c "SELECT tier3_type, outcome, latency_ms, array_length(tools_called,1) AS tools, created_at FROM engineer_events ORDER BY created_at DESC LIMIT 10;"
  ```
  **Expect:** one row per LLM interaction; `outcome` ∈ {`synthesized`,
  `skipped-llm-unreachable`, `error`}; fuel/tire queries show `tools ≥ 1`.

---

## 7. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| No PTT capture; shortcut "failed to register" | Grant OS **Accessibility / Input Monitoring** to the client; verify `ptt_hotkey` parses (default `F13`) |
| `[stt] whisper model unavailable` | Run `models/download.sh` or set `WHISPER_MODEL_PATH` |
| PTT query never answered | Check `redis-cli SUBSCRIBE engineer:query` shows the publish; confirm hub subscribed (`[hub] Racing Engineer started`) |
| No audio, but clips published | Chatterbox down/misconfigured (`chatterboxUrl`), or Tauri output device not set (Setup → audio) |
| Every Tier 3 skipped | LLM unreachable — check `llm.baseUrl` + `curl $BASEURL/models` |
| `engineer_events migrations failed` | Postgres down or `DATABASE_URL` wrong — Tier 3 audit degrades but Tier 1/2 keep working |
| Answers ignore fuel/tire reality | Expected without live telemetry; race state/tools return "not available" until a session is active |
| First audio > 5 s | See Section 4 — switch to a smaller `llm.model` |

---

## Sign-off

- [X] Section 2 automated checks green
- [X] Sections 3A–3D verified via injection
- [X] Section 4 latency within budget (or model swapped)
- [X] Section 5 live deploy test passed (SC-010)
- [X] Section 6 audit rows present
