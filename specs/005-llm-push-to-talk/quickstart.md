# Quickstart: Racing Engineer — LLM + Push-to-Talk

Validation scenarios proving M5 works end-to-end. See [data-model.md](data-model.md) and [contracts/](contracts/) for shapes; this is a run/validate guide only.

## Prerequisites
- Infra up: `docker compose -f infra/docker-compose.yml up -d` (redis, postgres, chatterbox).
- OpenAI-compatible LLM endpoint reachable; set in `apps/hub-server/config/engineer-config.json` `llm.baseUrl`/`model` (or env). Verify it supports **streaming** + **tool calling**.
- `DATABASE_URL` (or discrete PG env) set for the hub; migration `001_engineer_events.sql` applies on startup.
- Whisper model `ggml-base.en.bin` present for the Tauri client.
- Build: `npm run build && npm run typecheck` (workspace-wide).

## Scenario 1 — On-demand PTT query (P1, SC-001/002/010)
1. Start hub (`server-init`) and Tauri client; begin a live/simulated stint with fuel + tire state populated.
2. Hold the PTT control, say "Do we pit this lap?", release.
3. **Expect**: first audio of the answer within **5 s** of release; the answer references current fuel/tire figures that match `get_fuel_status`/`get_tire_status` (no fabricated numbers).
4. Verify an `engineer_events` row exists (`outcome=synthesized`, `tools_called` includes the fuel/tire tool).

## Scenario 2 — Empty / silence capture (SC-004)
1. Hold PTT, stay silent, release.
2. **Expect**: no spoken answer; log `reason: "empty-transcription"`; no `engineer_events` row for the empty capture.

## Scenario 3 — Proactive Tier 3 briefings (US2)
1. Trigger a pit-lane-entry event → **expect** a synthesized pit-entry briefing (sequence of clips), no interruption of any playing clip.
2. Trigger a safety-car deployment → **expect** the immediate Tier 1 alert first, then a synthesized safety-car briefing.
3. Set Energy=1 (Tranquil); trigger a `hero:lap_complete` (post-sector) boundary → **expect** no commentary.

## Scenario 4 — Personality direction (SC-005)
1. Hold race state constant. For each trait, run the eval set at levels 1 and 5.
2. **Expect**: Energy→length/frequency; Warmth→register; Assertiveness→assertiveness; Openness→conventional↔visionary; Conscientiousness→spontaneous↔meticulous, each moving in the intended direction.

## Scenario 5 — Override tracking + no repeat (US4, SC-006)
1. Elicit a pit recommendation for lap N.
2. Do not pit; let the car complete lap N (S/F crossing) without a pit entry.
3. **Expect**: recommendation `overridden`; the same pit recommendation is **not** re-issued within the window context; subsequent related speech reflects staying out.

## Scenario 6 — Adaptive deference (US5, SC-007)
1. Override the pit recommendation type `deferenceThreshold` times (default 2) in one session.
2. **Expect**: next comparable **unsolicited** output is information-only (no directive). A direct PTT "should I pit?" still returns a direct recommendation. New session ⇒ behavior resets.

## Scenario 7 — Session memory (US6)
1. Make + log a recommendation; record its outcome.
2. Later in the same session, ask a related PTT question.
3. **Expect**: the answer is consistent with the earlier recommendation/outcome (memory present in context). Force an over-budget context ⇒ `context-truncated` log; context still within ceiling (SC-009).

## Scenario 8 — Graceful degradation (P1, SC-003)
1. Make the LLM endpoint unreachable mid-stint.
2. **Expect**: all Tier 1/2 alerts still fire exactly as M4; every Tier 3 trigger skipped with `reason:"llm-unreachable"`; a PTT query yields a brief canned "Reasoning engine unavailable" (no hang past `timeoutMs`); `engineer_events` row `outcome=skipped-llm-unreachable`.
3. Restore the endpoint → next trigger/query synthesizes normally (no restart).

## Definition-of-done checks
- `npm test` (hub) + `cargo test` (Tauri) + agent evals green.
- `npm run build && npm run typecheck`; ESLint/Prettier; rustfmt/clippy.
- Deploy test = Scenario 1 + Scenario 5 combined (SC-010).
