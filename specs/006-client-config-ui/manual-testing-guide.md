# Manual Testing Guide: Tauri Client Configuration UI (M10)

**Feature**: `specs/006-client-config-ui` | **Written**: 2026-07-09

A step-by-step walkthrough of every M10 feature as actually implemented. Each
section is self-contained — commands are repeated in place, so you never need
to scroll back to an earlier section.

**Platform notes (macOS)**:

- iRacing telemetry only exists on Windows. Sections that need a live session
  are marked **[needs iRacing/Windows]** — everything else is fully testable
  on this Mac.
- **Cockpit or just a session?** Most [needs iRacing] checks only need a
  LOADED session (parked in the garage is fine): session state + badges, the
  1Hz snapshot feed and live lag warning, telemetry log file creation, and
  PTT queries end-to-end. You must actually DRIVE for: the Debug tab's values
  visibly changing (lap time delta needs ≥1 completed lap — plan on 2–3),
  meaningful telemetry log content (speed/RPM/throttle are zeros while
  parked), and Tier 1/2 alerts (Energy=1 suppression, SC-008 latency) — start
  a solo Test Drive with the fuel slider set very low and the fuel-critical
  alert fires within a lap or two. A session replay also works for the
  values-updating checks.
- The app's data directory on macOS is
  `~/Library/Application Support/com.iracing.engineer/` (the Tauri bundle
  identifier). The saved settings live in `config.json` inside it.
- **Windows paths** — note that settings and logs live in DIFFERENT
  directories (Roaming vs. Local), so don't look for `config.json` next to
  the log file:
  - Settings: `%APPDATA%\com.iracing.engineer\config.json`
  - Logs: `%LOCALAPPDATA%\com.iracing.engineer\logs\client.log.<date>`
  - Fresh-install reset (PowerShell):

    ```powershell
    Remove-Item "$env:APPDATA\com.iracing.engineer\config.json"
    ```

- **If the app crashes**: Rust panic messages go to stderr, NOT the log file.
  Run the app from a terminal to see them — `npm run tauri dev` during
  development, or launch the installed `.exe` directly from PowerShell/cmd so
  the panic text is captured in that window.
- Your global npm config sets `omit=dev`, so every install in this repo needs
  `--include=dev` or dev tooling silently disappears.

**Known blocker (T034b / analysis C1)**: your Chatterbox runs on a REMOTE host
(`http://10.0.0.12:8004`, confirmed reachable). The hub writes uploaded voice
profiles to a LOCAL directory, which the remote Chatterbox cannot see — so the
Voice section below can verify validation + persistence mechanics, but the
actual cloned-voice audio is blocked until the deployment decision is made
(run Chatterbox locally with the prepared bind mount, or share the reference
directory to the remote host).

---

## 0. Environment setup (do this once per test run)

1. Start Redis and Postgres:

   ```bash
   docker compose -f infra/docker-compose.yml up -d redis postgres
   ```

2. Install dependencies and build the workspace (from the repo root):

   ```bash
   npm install --include=dev && npm run build
   ```

3. Start the hub server (leave this terminal running — its log output is used
   in several checks below):

   ```bash
   cd apps/hub-server && npm run dev
   ```

4. In a second terminal, start the Tauri app:

   ```bash
   cd apps/tauri-client && npm run tauri dev
   ```

   For the full push-to-talk *speech* pipeline (Whisper transcription), build
   with the STT feature instead — this needs `models/ggml-base.en.bin` to
   exist and takes noticeably longer to compile:

   ```bash
   cd apps/tauri-client && npm run tauri dev -- --features stt
   ```

   > The PTT **key binding and indicator** work in the default build — only
   > transcription/queries need the `stt` build.

5. To simulate a **fresh install** at any point (first-launch hint, the
   never-configured PTT prompt), quit the app and delete the saved config:

   ```bash
   rm ~/Library/Application\ Support/com.iracing.engineer/config.json
   ```

---

## 1. Settings page, tabs, and the Diagnostics redirect (FR-001, FR-030, B4)

1. [X] In the app's top nav, click **Setup**. Confirm seven tabs render: Audio,
   Connection, Hotkeys, Personality, Debug, Voice, Logging.
2. [ ] **Cross-tab unsaved state**: in the Connection tab, change the Redis URL to
   any garbage value (do NOT click Save). Switch to the Audio tab, then back
   to Connection. The edited value must still be in the field.
3. [ ] Fix the field back before moving on.
4. [ ] **FR-030 redirect**: click the **Diagnostics** nav button. You must land on
   the Settings page with the **Debug** tab already active (the old
   diagnostics content — connection status, field browser, watchlist — now
   lives inside that tab, below the new "Live Snapshot" section). No blank
   page, no crash.

**Pass**: 7 tabs, unsaved edits survive tab switches, Diagnostics lands on the
Debug tab.

---

## 2. Audio devices (US1 / quickstart SC-1)

> Timing check (spec SC-001): start a stopwatch when you first open the Audio
> tab; the test clip should be playing through your chosen speaker in under
> 3 minutes.

1. [ ] Open **Setup → Audio**. Both dropdowns must list your system devices plus a
   "System default" entry.
2. [ ] Select your headset microphone in the **Microphone** dropdown. This applies
   IMMEDIATELY (live switch) — no Save needed.
3. [ ] Speak into the mic. The level meter bar under the dropdown must respond
   within ~100ms of your voice (it is fed by the Rust capture stream, so it
   confirms the *selected* device is live).
4. [ ] Select your speaker/headset in the **Playback** dropdown.
5. [ ] Click **Test Playback** (inside the audio test panel). A short clip should
   play through the selected output.
   > This calls the hub, which synthesizes via Chatterbox — the hub terminal
   > will show the request. If Chatterbox is unreachable you get an error
   > instead of audio; that is a Chatterbox/network issue, not an M10 bug.
6. [ ] Click **Save** (bottom of the page), then quit and relaunch the app. Reopen
   the Audio tab — both selections must display the saved devices.
7. [ ] **Unavailable device** (needs an unpluggable device, e.g. a USB or
   Bluetooth headset): select it in both dropdowns, Save, quit the app,
   unplug/disconnect the device, relaunch. The Audio tab must show
   `"<name>" unavailable — using system default` next to each affected
   dropdown (and a combined "please reselect your microphone and speaker"
   warning if both were unplugged). The app must keep working on system
   defaults. Re-selecting a device clears the warning.

**Pass**: live device switch, meter responds, clip plays on the chosen output,
selections persist, unavailable devices degrade gracefully with a visible
notice.

---

## 3. Connection + LLM configuration (US2 / quickstart SC-2)

### 3.1 Per-service Test buttons

1. [ ] Open **Setup → Connection**.
2. [ ] Click **Test Redis** → green `✓`. Click **Test Hub** → green `✓`. Click
   **Test LLM** → green `✓` with a latency (this probes
   `GET {base_url}/models` on your Lemonade endpoint — never a synthesis
   call).
3. [ ] Failure cases — change the LLM Base URL port to something dead (e.g.
   `http://localhost:9`), click **Test LLM**, and confirm the exact message
   `✗ connection refused`. Point it at a URL that answers with an error to see
   the `HTTP <status>` taxonomy messages. Restore the real URL after.

### 3.2 Inline validation (FR-026, G1)

1. [ ] Blank out the **LLM Model** field → an inline error appears and the
   page-level **Save** button becomes disabled with an explanatory note.
2. [ ] Type a malformed URL (`not a url`) into Redis URL → same behavior.
3. [ ] Restore valid values → errors clear, Save re-enables.
4. [ ] The **LLM API Key** field must accept being EMPTY without any validation
   complaint (empty = local endpoint, no auth).

### 3.3 Cloud-endpoint warning (FR-007 cloud key gap)

1. [ ] Type `https://api.anthropic.com/v1` into LLM Base URL. As you type, an
   amber warning must appear: "API key is stored locally but not forwarded to
   the hub server…". It must NOT block Save.
2. [ ] Restore `https://lemonade.tdkottke.com/v1` — the warning disappears.

### 3.4 First-launch hint (FR-007)

1. [ ] Quit the app and delete the config to simulate a fresh install:

   ```bash
   rm ~/Library/Application\ Support/com.iracing.engineer/config.json
   ```

2. [ ] Relaunch, open **Setup → Connection**. The blue "Default — update for your
   setup" hint must be visible near the LLM fields.
3. [ ] Click its **×**. The hint hides. Quit and relaunch WITHOUT saving — the
   hint must be back (dismiss is session-only).
4. [ ] Now click **Save** (defaults unchanged is fine), quit, relaunch — the hint
   must be gone permanently.

### 3.5 Model change reaches Redis (no restart — FR-009)

1. [ ] Change **LLM Model** to `test-model-1B` and click **Save**.
2. [ ] Verify the Redis key the hub reads per-request:

   ```bash
   docker compose -f infra/docker-compose.yml exec redis redis-cli GET hub:config:llm
   ```

   Expected: `{"baseUrl":"https://lemonade.tdkottke.com/v1","model":"test-model-1B"}`
   — and confirm there is **no `apiKey`** in the value.
3. [ ] **[needs iRacing/Windows + stt build]** Hold PTT and ask a question; the
   hub terminal's `Inference triggered` log must show the new model on the
   very next Tier 3 call — no hub restart.
4. [ ] Restore the original model name and click **Save**, then re-check the key:

   ```bash
   docker compose -f infra/docker-compose.yml exec redis redis-cli GET hub:config:llm
   ```

5. [ ] **Audit event**: change the API key field to anything, Save, and check the
   Tauri terminal for a `llm-api-key-updated hasKey=true` log line — the key
   VALUE must never appear in the log. Clear the key and Save again →
   `hasKey=false`.

**Pass**: three working Test buttons with the exact error strings, validation
gates Save, hint lifecycle correct, `hub:config:llm` updates on Save with no
apiKey, audit event fires without leaking the key.

---

## 4. Push-to-talk binding (US3 / quickstart SC-3, SC-3b)

> Timing check (spec SC-003): from clicking "Set PTT Key" to seeing the
> PTT-active indicator light should take under 30 seconds.

### 4.1 Never-configured state

1. [ ] Simulate a fresh install (quit the app first):

   ```bash
   rm ~/Library/Application\ Support/com.iracing.engineer/config.json
   ```

2. [ ] Relaunch → **Setup → Hotkeys**. You must see the SOFT prompt "No PTT key
   set — click 'Set PTT Key' to bind one" with a dismiss **×** — NOT a red
   error banner. The Tauri terminal shows
   `no PTT key configured — skipping global shortcut registration`.

### 4.2 Binding a key

1. [ ] Click **Set PTT Key** → "Listening for key…" appears and the button
   disables.
2. [ ] **Keep the app window focused** and press **F14** (or any function key /
   letter). The capture happens through the settings window during the
   listening period; the *bound* shortcut afterwards is global.
3. [ ] The display updates to the key name. The binding **auto-saves** — do NOT
   click Save; instead quit and relaunch and confirm the key is still shown
   (and the terminal logs `global PTT shortcut registered`).
4. [ ] **Timeout path**: click **Set PTT Key** and press nothing for 10 seconds →
   the inline message "No key pressed — try again" appears (no red banner).

### 4.3 PTT-active indicator (the SC-003 confirmation signal)

1. [ ] Stay on the Hotkeys tab. **Hold** the bound key — the grey `● PTT`
   indicator must turn green for exactly as long as you hold it.
2. [ ] Now click into another app (unfocus iRacing-style), hold the key again
   while watching the settings window on screen — the indicator must still
   light, proving the shortcut is OS-global.
   > The mic level meter in the Audio tab is deliberately NOT the signal here
   > — it is always-on regardless of PTT.

### 4.4 Accessibility-denied banner (macOS)

1. [ ] Open **System Settings → Privacy & Security → Accessibility** and remove /
   disable the iRacing Engineer (or terminal, in dev) entry.
2. [ ] Back in the app: **Set PTT Key** → press a key. A RED persistent banner
   must appear: "Voice queries disabled — PTT key could not be registered:
   Accessibility permission required…" with an **Open Accessibility
   Settings** button beneath it.
3. [ ] Click the button — macOS must open directly to the Privacy & Security →
   Accessibility pane.
4. [ ] Switch to the Audio tab and back to Hotkeys — the banner must STILL be
   there (it survives tab switches and only clears on a successful bind).
5. [ ] Confirm every other tab still works — the error is contained to Hotkeys.
6. [ ] Re-grant the permission, bind a key successfully → banner clears.

**Pass**: soft prompt vs. banner are distinct, binding auto-persists, timeout
is transient, indicator tracks the physical key globally, accessibility flow
shows the banner + working deep-link button.

---

## 5. Engineer personality (US4 / quickstart SC-4)

1. [ ] Open **Setup → Personality**. All five sliders must show the previously
   saved values (not 3/3/3/3/3 defaults, if you changed them before).
2. [ ] Drag **Energy** to **1**. The amber "Quiet mode: Tier 2 and Tier 3
   commentary will be suppressed." warning must appear IMMEDIATELY — before
   any Save.
3. [ ] Click **Save**, then verify the hub-side key:

   ```bash
   docker compose -f infra/docker-compose.yml exec redis redis-cli GET hub:config:personality
   ```

   Expected: `{"openness":3,"warmth":3,"energy":1,"conscientiousness":3,"assertiveness":3}`
   (with your values; `energy` must be `1`).
4. [ ] **[needs iRacing/Windows]** With a session running, trigger a Tier 2 alert
   → no audio (suppressed). Direct PTT queries still get answered.
5. [ ] Set Energy back to 3 and **Save**, then confirm:

   ```bash
   docker compose -f infra/docker-compose.yml exec redis redis-cli GET hub:config:personality
   ```

**Pass**: sliders reflect saved state, Energy=1 warning is instant, Redis
reflects each Save without a hub restart.

---

## 6. Debug tab (US5 / quickstart SC-5)

1. [ ] Open **Setup → Debug**. The **Live Snapshot** section is at the top.
2. [ ] **Badges**:
   - `Redis: Connected` (green) while docker Redis is up.
   - `Hub:` starts as grey `Checking…`, then turns green `Connected` within a
     couple of seconds (first probe result).
   - `Whisper:` shows `Load failed` (red) in a default macOS dev build (STT is
     not compiled in) or `Loading…` → `Ready` in an `stt` build with the model
     present.
3. [ ] **Hub loss**: press `Ctrl+C` in the hub terminal to stop it. Watch the Hub
   badge — it must flip to red `Disconnected` within ~12 seconds (10s stale
   window measured from the last successful probe, +2s probe timeout worst
   case). Everything else in the app keeps working. Restart the hub:

   ```bash
   cd apps/hub-server && npm run dev
   ```

   The badge must return to `Connected` within ~11 seconds.
4. [ ] **No-session state**: with iRacing absent (i.e., on this Mac), the section
   shows "No active session" and the four telemetry values show `—`. Never
   stale numbers.
5. [ ] **Stream lag** (simulated, no iRacing needed): first stop the hub server
   with `Ctrl+C` in its terminal — a running hub would immediately consume
   and acknowledge the synthetic entry, erasing the lag you are trying to
   create. Then create an unacknowledged entry so the pending-entry lag ages:

   ```bash
   docker compose -f infra/docker-compose.yml exec redis redis-cli XGROUP CREATE iracing:telemetry:live hub:live-processor '$' MKSTREAM
   docker compose -f infra/docker-compose.yml exec redis redis-cli XADD iracing:telemetry:live '*' probe manual-lag-test
   docker compose -f infra/docker-compose.yml exec redis redis-cli XREADGROUP GROUP hub:live-processor manual-tester COUNT 1 STREAMS iracing:telemetry:live '>'
   ```

   > If the first command errors with `BUSYGROUP Consumer Group name already
   > exists`, that is fine — the hub already created the group; continue with
   > the next two commands.

   Wait a few seconds, then switch to another tab and back to Debug (the
   snapshot refreshes on mount; the live 1Hz event feed only runs during an
   active session). The "Stream lag" number must show a growing value and
   turn red once past 500 ms. (The Hub badge will show Disconnected while the
   hub is stopped — expected.) When done, restart the hub:

   ```bash
   cd apps/hub-server && npm run dev
   ```
   > The flashing "⚠ Stream lag over 500 ms" warning banner (with its 5-second
   > dismissal hysteresis) is driven by the live event feed, so verifying the
   > full appear/dismiss behavior needs an active session
   > **[needs iRacing/Windows]** — the automated Vitest suite covers the state
   > machine exhaustively either way.

   Clean up the synthetic entry when done:

   ```bash
   docker compose -f infra/docker-compose.yml exec redis redis-cli DEL iracing:telemetry:live
   ```

6. [ ] **[needs iRacing/Windows]** With a live session: fuel, lap, track position,
   and lap delta update at ≥1Hz; session line reads "Active — [Track Name]".

**Pass**: tri-state badges behave (grey → green/red, never a false red on
first load), hub loss detected within the documented window, lag value
displays and reddens past 500 ms, no-session state is honest.

---

## 7. Telemetry logging (US7 / quickstart SC-8)

1. [ ] Open **Setup → Logging**. The toggle is off; the read-only path shows
   `~/Library/Application Support/com.iracing.engineer/logs/telemetry`
   (a resolved absolute path — if it ever shows "could not be resolved", the
   toggle must be disabled/greyed out).
2. [ ] Switch the toggle **on**. No error should appear (the directory is created
   and write-probed at toggle time).
3. [ ] Confirm the setting persists: quit, relaunch, reopen Logging — still on.
   Then check the directory exists:

   ```bash
   ls -la ~/Library/Application\ Support/com.iracing.engineer/logs/telemetry/
   ```

   > Log FILES appear lazily on the first telemetry frame, which requires a
   > connected iRacing SDK — on this Mac the directory stays empty; that is
   > expected. **[needs iRacing/Windows]**: after ~30s of a live session, a
   > `iracing-telemetry-<session>-<timestamp>.ndjson` file exists; open it
   > and confirm each line is a complete JSON object with `ts`, `sessionId`,
   > `fuel`, `speed`, `gear`, `rpm`, throttle/brake, and accel fields.
4. [ ] **Path-validation errors** (the two distinct messages): toggle logging
   **off**, make the directory read-only, and try to enable it again:

   ```bash
   chmod -w ~/Library/Application\ Support/com.iracing.engineer/logs/telemetry
   ```

   Toggling on must fail with an error starting
   `log directory is not writable:` (and the toggle stays off). Restore it:

   ```bash
   chmod +w ~/Library/Application\ Support/com.iracing.engineer/logs/telemetry
   ```

   Toggle on again → succeeds.
5. [ ] **[needs iRacing/Windows]** SC-008 latency check: with logging on and a
   session running, trigger a Tier 1 alert and compare delivery latency to a
   logging-off baseline — the P99 increase must be ≤ 50ms (watch the
   `telemetry-log-channel-depth` debug log for the ~80% channel-load
   condition).

**Pass**: toggle persists, path is resolved + read-only, unwritable path
yields the specific error without enabling, real-time path never blocks.

---

## 8. Voice profile (US6 / quickstart SC-7, SC-7b, SC-7c)

> **Read first**: end-to-end cloned-voice audio is blocked by the T034b
> deployment decision (remote Chatterbox can't see locally-written files).
> Steps 1–5 verify everything up to that boundary: validation gates, file
> write, Redis persistence, and restart recovery.

0. [ ] The hub writes uploads to `/data/chatterbox/reference` (from
   `engineer-config.json`). Create it once so the write succeeds on this Mac:

   ```bash
   sudo mkdir -p /data/chatterbox/reference && sudo chown $(whoami) /data/chatterbox/reference
   ```

1. [ ] Open **Setup → Voice**. With nothing uploaded it must say
   **"Default voice (no profile uploaded)"**.
   - Stop Redis and reopen the tab (switch away and back) to see the third
     state — "Redis unreachable — profile status unavailable":

     ```bash
     docker compose -f infra/docker-compose.yml stop redis
     ```

     Then bring it back:

     ```bash
     docker compose -f infra/docker-compose.yml start redis
     ```

2. [ ] **Format rejection (SC-7b)** — make a fake "mp3" that fails the magic-byte
   check and try to upload it; the error "File must be an MP3" must appear
   WITHOUT any request reaching the hub (hub terminal stays quiet):

   ```bash
   cp /System/Library/Sounds/Ping.aiff /tmp/fake.mp3
   ```

3. [ ] **Duration rejection (SC-7c)** — create a 1-second real MP3 (requires
   ffmpeg; `brew install ffmpeg` if absent) and upload it:

   ```bash
   ffmpeg -f lavfi -i sine=frequency=440:duration=1 -codec:a libmp3lame /tmp/too-short.mp3
   ```

   Expected error: `Audio must be between 3 and 60 seconds (got 1.0s)`.

4. [ ] **Valid upload** — create a 15-second MP3 and upload it:

   ```bash
   ffmpeg -f lavfi -i sine=frequency=440:duration=15 -codec:a libmp3lame /tmp/voice-15s.mp3
   ```

   On success the tab immediately shows the generated
   `profile-<timestamp>.mp3` filename, upload time, and `15s` — no reload
   needed. Verify both persistence layers:

   ```bash
   ls -la /data/chatterbox/reference/
   ```

   ```bash
   docker compose -f infra/docker-compose.yml exec redis redis-cli GET hub:config:voice-profile
   ```

   The Redis value must contain `filename`, `uploadedAt`, and
   `durationSeconds` — and must NOT contain `testClipUrl`.

5. [ ] **Restart recovery (T035)**: restart the hub (`Ctrl+C` then):

   ```bash
   cd apps/hub-server && npm run dev
   ```

   The hub log must show `voice profile recovered from Redis`. Reopen the
   Voice tab — the profile is still displayed.

6. [ ] **Test Voice / cloned audio** — clicking **Test Voice** asks the remote
   Chatterbox to synthesize with `reference_audio_filename=profile-….mp3`.
   Because that file exists only on this Mac, the remote box will error (or
   use a missing reference). **This is the known T034b/C1 boundary** — once
   the deployment decision lands (local Chatterbox with the prepared compose
   bind mount, or a shared directory to `10.0.0.12`), re-run this step and
   confirm the sample phrase plays in the uploaded voice.

**Pass**: three display states render, wrong format rejected client-side with
no network call, short clip rejected by the hub with the exact bounds message,
valid upload persists to disk + Redis (no testClipUrl) and survives a hub
restart. Cloned audio: deferred to T034b.

---

## 9. Save-failure handling (FR-027 / quickstart SC-6, SC-6b)

### 9.1 Local disk failure — changes retained

1. [ ] Quit nothing; just make the app's data directory read-only:

   ```bash
   chmod -w ~/Library/Application\ Support/com.iracing.engineer
   ```

2. [ ] In **Setup → Connection**, change the Redis URL field, then click **Save**.
3. [ ] A red banner must appear ("Cannot write to config file: …") AND the changed
   value must still be sitting in the input — nothing reverts.
4. [ ] Restore permissions:

   ```bash
   chmod +w ~/Library/Application\ Support/com.iracing.engineer
   ```

5. [ ] Click **Save** again (the button stays enabled precisely so you can retry)
   → the banner clears and the save succeeds.
6. [ ] Change the field back to `redis://localhost:6379` and **Save**.

### 9.2 Hub sync failure — saved locally, stale on the hub (SC-6b)

1. [ ] Stop Redis (leave the hub running):

   ```bash
   docker compose -f infra/docker-compose.yml stop redis
   ```

2. [ ] Move a personality slider and click **Save**. Within a few seconds an amber
   dismissable banner appears: "Settings saved locally. Hub sync failed: …".
   The Save button remains usable.
3. [ ] Restart Redis:

   ```bash
   docker compose -f infra/docker-compose.yml start redis
   ```

4. [ ] WITHOUT saving again, confirm the hub-side key still holds the OLD value
   (this is the documented M10 limitation — no automatic resync):

   ```bash
   docker compose -f infra/docker-compose.yml exec redis redis-cli GET hub:config:personality
   ```

5. [ ] Click **Save** once more, then re-check — the key now has the new value:

   ```bash
   docker compose -f infra/docker-compose.yml exec redis redis-cli GET hub:config:personality
   ```

**Pass**: local failure keeps the form intact with a specific error and retry
works; hub-sync failure warns without blocking, local disk is never rolled
back, and the next Save heals Redis.

---

## 10. Settings survive a restart (spec SC-007 — final sweep)

1. [ ] Set a distinct value in every tab: devices, Redis/hub URLs, LLM base URL /
   model / API key, a bound PTT key, all five personality sliders, the
   logging toggle.
2. [ ] Click **Save**, then **force-quit** the app (⌘Q or kill the dev process)
   and relaunch.
3. [ ] Walk every tab: every field must display its saved value — nothing reverts
   to a default. You can also inspect the raw store directly:

   ```bash
   cat ~/Library/Application\ Support/com.iracing.engineer/config.json
   ```

**Pass**: zero fields revert; `config.json` matches what the UI shows.

---

## Result log

| # | Section | Pass/Fail | Notes |
|---|---------|-----------|-------|
| 1 | Tabs + redirect | | |
| 2 | Audio devices | | |
| 3 | Connection + LLM | | |
| 4 | PTT binding | | |
| 5 | Personality | | |
| 6 | Debug tab | | |
| 7 | Telemetry logging | | |
| 8 | Voice profile | | blocked past validation by T034b |
| 9 | Save failure | | |
| 10 | Restart persistence | | |
