# Follow-up issues to file (007)

Drafted during /speckit-implement (2026-07-13). Creating GitHub issues requires
the project owner — file these two with `gh issue create` (or paste into the
GitHub UI), then link BOTH in the 007 PR description (T034 exit criterion).

---

## Issue 1 (T031) — gap-model: `gap:pulling_away` re-fires every tick and triggers on closing rate

**Body:**

`apps/hub-server/src/models/gap-model.ts:114-118` — the `gap:pulling_away`
emission has two defects (surfaced by spec 007's research, R1):

1. **Re-fires every processor tick** once `closingRate > 0.3` holds for 2+
   ticks — there is no one-shot latch, so the event spams the bus and the
   `hub:events:ring` buffer.
2. **Triggers on the wrong sign**: `closingRate` positive means the gap is
   *shrinking*, so the condition fires while the trailing car is closing fast —
   the name and the condition disagree.

Spec 007 deliberately did NOT consume these events — the `GapAlertMonitor`
computes gap crossings from live `RaceState` instead (research.md R1). After
007 the emission is harmless to the Racing Engineer but still reaches the event
bus and ring buffer, where a future consumer (Stream Engineer, M6+) could be
misled. Fixing it inside 007 would have crossed the feature boundary
(Constitution VII).

**Suggested fix**: latch the emission (fire once per battle-status transition,
like `gap:closing`) and correct the rate-sign condition — or remove the event
if no consumer materialises by M6.

Refs: `specs/007-tier2-alert-completion/research.md` §R1, tasks.md T031.

---

## Issue 2 (T034) — 007 deferred live validation: manual guide Section 3 + weather live check

**Body:**

Track the Windows/iRacing live run deferred from 007's Mac validation to
closure. This issue is a stated exit criterion for the milestone and MUST be
linked in the 007 PR description.

Scope (specs/007-tier2-alert-completion/manual-testing-guide.md):

- **TC-09–TC-18** (live AI race): competitor pit announcements in/out of
  window, per-visit dedup, coalesced burst, gap closing/dead-band/re-arm
  cycle, non-driver battles silent, caution/pit-road suppression, post-session
  SC-005 audit sweep. **Carries SC-002's 3-second audible-latency validation**
  (the hub-side one-tick bound is already unit-tested — racing-engineer.test.ts).
- **TC-25** (live weather, observer mode): values match the in-sim display,
  update at session cadence; `weather.html` polls from OBS on `http://10.0.0.9`
  without CORS errors.
- **T025 verification** (non-deferrable before the live stream if the US4 fast
  path shipped first): confirm the eight weather field names against
  `sdk.enumerate_vars()` capitalization, run the full Rust gate (`cargo test`,
  `cargo clippy`, `cargo fmt --check`), and confirm `WindDir`'s from/to
  convention (SDK var description + in-sim wind display) — then update the
  `WeatherState.windDirRad` doc comment.
