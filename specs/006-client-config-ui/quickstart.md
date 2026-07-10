# Quickstart Validation: Tauri Client Configuration UI

**Date**: 2026-07-07 | **Feature**: specs/006-client-config-ui

These scenarios validate M10 end-to-end. Each can be run independently (in priority order); no active iRacing session is required for SC-1 through SC-4.

> **Numbering note**: SC-1 through SC-8 here are quickstart test scenarios. The spec's success criteria use a separate three-digit sequence (SC-001 through SC-008). They overlap in count but are not the same — e.g., quickstart SC-7 = voice profile upload; spec SC-007 = settings persist across restart.

---

## Prerequisites

- Hub server running (`npm run dev` in `apps/hub-server`)
- Redis running (`infra/docker-compose.yml`)
- Tauri app built and running (`npm run tauri dev` in repo root)
- For SC-5 (debug): active iRacing session or session replay
- For SC-7 (voice): Chatterbox running with `chatterboxReferenceAudioDir` configured and writable

---

## SC-1 — Audio Setup (US1)

**Goal**: Select mic + speaker, confirm audio test plays from correct device. Must complete in under 3 minutes (spec SC-001).

> **Timing**: Start a stopwatch when the Audio tab first opens. Stop it when the test clip plays through the selected speaker. Must be < 3 minutes.

1. Open the Tauri app → Settings → **Audio tab**. *(Start stopwatch here.)*
2. Verify the input and output dropdowns list all system audio devices by name.
3. Select a headset microphone from the input dropdown.
4. Speak into the mic — confirm the level meter responds.
5. Select a speaker from the output dropdown.
6. Click **"Test Playback"** — confirm the sample clip plays through the selected speaker. *(Stop stopwatch here — must be < 3 minutes since step 1.)*
7. Click **Save**.
8. Restart the app → reopen Audio tab → confirm saved device selections are displayed.

**Pass**: Devices listed, level meter responds, test clip plays from correct device, selections persist across restart.

---

## SC-2 — Connection Config + LLM Model Change (US2)

**Goal**: Update LLM model name in UI; next Tier 3 message uses the new model without restart.

1. Open Settings → **Connection tab**.
2. Click **"Test"** next to Redis — confirm green ✓.
3. Click **"Test"** next to Hub Server — confirm green ✓.
4. Change the **LLM Model** field to a different model name (e.g., `test-model-1B`).
5. Click **Save**.
6. Open hub server logs — confirm `hub:config:llm` was updated in Redis.
7. Trigger a Tier 3 message (e.g., hold PTT and ask a question).
8. In hub server logs, confirm the LLM request used `model: "test-model-1B"`.
9. Restore the original model name and Save.

**Pass**: No hub restart needed; LLM request log shows the new model on the next Tier 3.

---

## SC-3 — PTT Hotkey Binding (US3)

**Goal**: Bind a new PTT key and confirm it captures audio.

1. Open Settings → **Hotkeys tab**.
2. Confirm the Hotkeys tab shows the current PTT state. **Fresh install**: `ptt_hotkey` defaults to `""` (never configured — T001/I1 changed M5's `"F13"` default) and the soft prompt "No PTT key set — click 'Set PTT Key' to bind one" is shown. **Config upgraded from M5**: the previously saved key (e.g., F13) is displayed instead.
3. Click **"Set PTT Key"** — confirm "Listening..." indicator appears.
4. Press **F14** (or any available function key).
5. Confirm the display updates to "F14".
6. Click **Save**.
7. Hold F14 with the sim window in focus — confirm the **PTT-active indicator in the Hotkeys tab** lights up for the duration of the hold. **A1 (signal change — do NOT use the mic meter)**: the mic level meter is always-on (the M5 capture stream runs continuously) and responds to voice regardless of PTT state, so it cannot confirm the global shortcut fired; the PTT-active indicator (T023/A1), driven by the PTT press/release events, is the valid signal. **Test setup**: stay on the Hotkeys tab (where the indicator lives), switch focus to the sim window (borderless-windowed mode), then hold F14 — use a second screen if needed so the settings page remains visible while the sim has focus.
8. Release F14 — confirm the indicator goes inactive.

**Pass**: Key capture works, binding persists, holding the key lights the PTT-active indicator (and releasing extinguishes it).

**SC-3b — Binding failure (accessibility denied)**:
1. On macOS: revoke Accessibility permission for the app in System Preferences → Privacy & Security → Accessibility.
2. Click "Set PTT Key" and press a key.
3. Confirm the error message reads: "Accessibility permission required — open System Preferences → Privacy & Security → Accessibility."
4. Confirm the "Open Accessibility Settings" button is visible directly beneath the error message.
5. Click the button — confirm macOS System Preferences opens to the Privacy & Security → Accessibility pane (not just System Preferences root).

**Pass**: Error message shown with correct text, button visible, button opens the correct pane.
**Fail**: Button absent, button opens wrong pane, or error message text differs from FR-028/FR-012 wording.

---

## SC-4 — Personality Sliders (US4)

**Goal**: Change personality, confirm next engineer message reflects it.

1. Open Settings → **Personality tab**.
2. Confirm all 5 sliders show current saved values.
3. Set **Energy** slider to **1** (the minimum level — the exact word label comes from the implemented label set; spec US4 examples use "Quiet" and FR-014 calls this Quiet mode, so assert the minimum-level label shown, not a specific hardcoded string).
4. Confirm the description text notes "Tier 2 and Tier 3 commentary suppressed."
5. Click **Save**.
6. Trigger a Tier 2 alert (e.g., a pit window opening event, or manually via `/api/audio/test`).
7. Confirm no audio is produced (suppressed by Energy=1).
8. Reset Energy to 3, Save.

**Pass**: Sliders display correctly, Energy=1 suppresses Tier 2, change takes effect without restart.

---

## SC-5 — Telemetry Debug Tab (US5)

**Goal**: Live values update and stream lag warning fires at threshold.

1. Start an iRacing session (or replay).
2. Open Settings → **Debug tab**.
3. Confirm the session status shows "Active — [Track Name]".
4. Confirm fuel, lap number, track position, and lap time delta all display values and update within 1 second.
5. With session stopped: confirm "No active session" state and stale values are not shown.
6. Simulate stream lag > 500ms (pause Redis consumer briefly or inject delay) — confirm the visual lag warning appears.

**Pass**: Live values update ≥ 1 Hz, no-session state shown correctly, lag warning fires at 500ms.

**SC-5b — Diagnostics redirect (D2)**:
1. Navigate to the `/diagnostics` route (or click any nav link that previously opened the Diagnostics page).
2. Confirm the app lands in the Settings panel with the **Debug tab** active.
3. Confirm the debug content (session status, telemetry variables, stream lag) is visible.

**Pass**: Diagnostics route redirects correctly to Debug tab; no blank page or 404.

---

## SC-6 — Save Failure Handling

**Goal**: Local save failure retains form state and shows specific error.

1. Open Settings → **Connection tab**.
2. Make a change to the Redis URL field.
3. Simulate a local save failure (e.g., make the AppConfig directory read-only temporarily).
4. Click **Save**.
5. Confirm: error message displayed with specific cause ("Cannot write to config file: permission denied").
6. Confirm: the changed Redis URL is still in the input field (not reverted).
7. Restore directory permissions, click **Save** again — confirm success.

**Pass**: No silent data loss; specific error shown; unsaved state retained; retry succeeds.

**SC-6b — Hub sync failure + stale-value limitation (E3, FR-027/U2)**:
1. Stop Redis (leave the hub server running) — e.g., `docker compose stop redis` in `infra/`.
2. Change a personality slider or the LLM model name, click **Save** — confirm the local save succeeds and the dismissable banner appears: "Settings saved locally. Hub sync failed: [reason]." (The "hub sync" is the Redis pipeline write of `hub:config:personality` + `hub:config:llm`; it fails while Redis is down.)
3. Restart Redis. WITHOUT saving again, trigger a Tier 3 message — confirm in the hub server logs that the hub used the PREVIOUS (stale) values from Redis (or the `engineer-config.json` fallback if the keys were never written), not the values just saved locally. This is the documented M10 limitation (FR-027/U2): there is no automatic resync after a failed hub sync; the driver's next explicit Save is what updates Redis.
4. Click **Save** again — confirm the hub sync succeeds and the next Tier 3 message uses the new values.

**Pass**: Local save survives the Redis outage with a dismissable warning; the stale-value window behaves exactly as documented (new values reach the hub only on the next explicit Save); recovery via re-Save works.

---

## SC-7 — Voice Profile Upload (US6, P3)

**Goal**: Upload an MP3, test the cloned voice.

1. Prepare a 10–30 second MP3 recording.
2. Open Settings → **Voice tab**.
3. Confirm status shows "Default voice (no profile uploaded)."
4. Click **Upload Voice Profile**, select the MP3 file.
5. Confirm upload progress indicator appears.
6. On completion: confirm filename and upload timestamp are shown.
7. Click **"Test Voice"** — confirm sample clip plays using the cloned voice.
8. Restart the app — open Voice tab — confirm uploaded profile is still shown (persisted via Redis).

**Pass**: Upload completes, test clip plays with cloned voice, persists across restart.

**SC-7b — Format validation**:
1. Attempt to upload a WAV file.
2. Confirm error: "File must be an MP3."

**SC-7c — Duration validation**:
1. Attempt to upload an MP3 shorter than 3 seconds.
2. Confirm error: "Audio must be between 3 and 60 seconds (got X.Xs)."

---

## SC-8 — Telemetry Logging Toggle (US7, P3)

**Goal**: Enable logging, confirm file is created; confirm racing path unaffected.

1. Open Settings → **Logging tab**.
2. Confirm toggle is Off and log directory path is displayed.
3. Switch toggle On → Save.
4. Start an iRacing session.
5. After 30 seconds, open the log directory — confirm a `.ndjson` file has been created with telemetry frames.
6. Open the file — confirm JSON objects contain the expected fields (fuel, lap, speed, etc.).
7. Toggle Off → Save — confirm logging stops cleanly.
8. While logging is enabled (ideally with the logging channel loaded toward ~80% capacity), trigger a Tier 1 alert and measure delivery latency against a logging-disabled baseline — pass requires the P99 latency increase to be ≤ 50ms (the quantitative spec SC-008/E3 threshold; a subjective "feels normal" is NOT a pass).

**Pass**: Log file created, frames written, alert latency within the P99 +50ms bound (spec SC-008/E3), logging stops cleanly on toggle-off.
