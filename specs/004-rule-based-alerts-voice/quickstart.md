# Quickstart: Rule-Based Alerts + Voice Validation

**Feature**: 004-rule-based-alerts-voice  
**Date**: 2026-06-30

---

## Prerequisites

- M3 complete: hub-server running and publishing events to `hub:events` Redis pub/sub
- Docker services running: `docker compose -f infra/docker-compose.yml up -d`
- Chatterbox TTS running: uncomment `chatterbox` in `infra/docker-compose.yml` and restart, or have it running externally at `http://localhost:8001`
- `apps/hub-server/config/engineer-config.json` populated (copy from `data-model.md`)
- `apps/hub-server/config/radio-blackout-zones.json` populated (empty `{ "zones": [] }` for initial testing)
- Tauri app built and running

---

## Scenario 1: Fuel Critical Alert (Tier 1 — P1)

**Goal**: Verify end-to-end path from event → TTS → audio playback within 3 seconds.

**Setup**: Ensure audio output device is configured in Tauri settings.

**Steps**:

1. Open a Redis CLI: `redis-cli`
2. Publish a synthetic `hero:fuel_critical` event:
   ```
   PUBLISH hub:events '{"type":"hero:fuel_critical","sessionId":"test-001","sessionTime":3600,"lapNumber":20,"lapDistPct":0.5,"payload":{"lapsRemaining":0.8}}'
   ```
3. Listen for the audio clip reference:
   ```
   SUBSCRIBE voice:audio
   ```
4. Expected: message arrives on `voice:audio` within ~2 seconds containing `AudioClipRef`
5. Expected: Tauri plays the fuel critical audio clip audibly through configured output device

**Pass criteria**: Audio heard within 3 seconds of PUBLISH command.

---

## Scenario 2: Pit Window Alert (Tier 2 — Safe Window Gated)

**Goal**: Verify Tier 2 alert is held during a blackout zone and released at the next safe window.

**Setup**: Add a test zone to `radio-blackout-zones.json`:
```json
{ "zones": [{ "label": "Test Zone", "lapDistPctStart": 0.4, "lapDistPctEnd": 0.6 }] }
```

**Steps**:

1. Publish event while `lapDistPct` is 0.5 (inside zone):
   ```
   PUBLISH hub:events '{"type":"hero:pit_window_open","sessionId":"test-001","sessionTime":1200,"lapNumber":10,"lapDistPct":0.5,"payload":{}}'
   ```
2. Confirm: no audio within 3 seconds (held in queue)
3. Send a telemetry tick with `lapDistPct` outside the zone (triggers safe-window check):
   ```
   PUBLISH hub:events '{"type":"hero:position_change","sessionId":"test-001","sessionTime":1210,"lapNumber":10,"lapDistPct":0.7,"payload":{}}'
   ```
4. Expected: pit window audio plays within 3 seconds of step 3

**Pass criteria**: No audio during zone; audio within 3 seconds after zone clears.

---

## Scenario 3: Deduplication — Same Lap Suppression

**Goal**: Verify duplicate alerts do not fire twice on the same lap.

**Steps**:

1. Publish `hero:fuel_critical` for lap 20 (audio plays — see Scenario 1)
2. Publish `hero:fuel_critical` for lap 20 again immediately:
   ```
   PUBLISH hub:events '{"type":"hero:fuel_critical","sessionId":"test-001","sessionTime":3601,"lapNumber":20,"lapDistPct":0.6,"payload":{"lapsRemaining":0.7}}'
   ```
3. Expected: no second audio clip on `voice:audio`

**Pass criteria**: Only one `voice:audio` message per alert type per lap.

---

## Scenario 4: Pit Window Dedup Reset on Pit Exit

**Goal**: Verify pit window alert fires again in a new stint after a pit stop.

**Steps**:

1. Publish `hero:pit_window_open` for lap 10 → audio plays
2. Publish `hero:pit_window_open` for lap 11 → no audio (dedup active)
3. Simulate pit exit:
   ```
   PUBLISH hub:events '{"type":"hero:pit_exit","sessionId":"test-001","sessionTime":2000,"lapNumber":11,"lapDistPct":0.02,"payload":{}}'
   ```
4. Publish `hero:pit_window_open` for lap 20 (new stint):
   ```
   PUBLISH hub:events '{"type":"hero:pit_window_open","sessionId":"test-001","sessionTime":4000,"lapNumber":20,"lapDistPct":0.5,"payload":{}}'
   ```
5. Expected: audio plays for lap 20

**Pass criteria**: Audio fires on lap 20 after pit exit, confirming dedup reset.

---

## Scenario 5: Chattiness Low Suppresses Tier 2

**Goal**: Verify Chattiness=Low blocks Tier 2 but not Tier 1.

**Steps**:

1. Set Chattiness to Low in Tauri settings
2. Publish `hero:pit_window_open` — expected: no audio
3. Publish `hero:fuel_critical` — expected: audio plays
4. Set Chattiness back to Default
5. Publish `hero:pit_window_open` — expected: audio plays

**Pass criteria**: Zero Tier 2 audio with Chattiness=Low; Tier 1 unaffected.

---

## Scenario 6: Audio Device Test Panel

**Goal**: Verify the test panel works without an active race session.

**Steps**:

1. Open Tauri → Settings → Audio
2. Click "Play Test Clip"
   - Expected: sample TTS clip plays through configured output device within 3 seconds
3. Speak into microphone
   - Expected: input level meter reacts visually
4. Press configured PTT key
   - Expected: panel displays PTT detection confirmation

**Pass criteria**: All three sub-tests complete without starting a race session.

---

## Scenario 7: TTS Failure Logging

**Goal**: Verify structured failure log when Chatterbox is unreachable.

**Steps**:

1. Temporarily set `chatterboxUrl` in `apps/hub-server/config/engineer-config.json` to an unreachable address (e.g. `http://10.0.0.12:9999`)
2. Restart the hub server so it picks up the config change
3. Publish `hero:fuel_critical` event:
   ```
   PUBLISH hub:events '{"type":"hero:fuel_critical","sessionId":"test-001","sessionTime":3600,"lapNumber":20,"lapDistPct":0.5,"payload":{"lapsRemaining":0.8}}'
   ```
4. Check hub-server stdout for a log line containing `"TTS failure"`:
   ```
   npm run dev -w apps/hub-server 2>&1 | grep "TTS failure"
   ```
5. Expected log line contains: `alertType`, `tier`, `lapNumber`, `failureReason`, `timestamp`
6. Expected: no audio plays; no crash; hub continues processing subsequent events

**Teardown**: Restore `chatterboxUrl` to `http://10.0.0.12:8004` and restart the hub server.

**Pass criteria**: Structured log emitted; process continues normally.

---

## Deploy Test (Live iRacing Session)

**Goal**: Validate the full path in a real practice session.

1. Configure a pit window range in `engineer-config.json` appropriate for the track length
2. Configure fuel critical threshold for a short stint (e.g., 0.5 laps remaining to trigger easily in practice)
3. Start a practice session at any iRacing track
4. Drive normally — monitor:
   - Pit window alert fires at the configured lap via speakers
   - Fuel critical fires when fuel estimate crosses threshold
   - No audio during Radio Blackout Zones (if configured)
   - No repeated alerts on subsequent laps

**Pass criteria**: Both pit window and fuel critical alerts heard through speakers at the correct conditions.
