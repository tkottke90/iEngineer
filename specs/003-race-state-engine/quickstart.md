# Quickstart: Race State Engine Validation

**Feature**: `003-race-state-engine`  
**Purpose**: End-to-end validation that the hub server correctly processes telemetry, builds Race State, and emits events — without requiring a live iRacing session.

---

## Prerequisites

- Redis running locally (via `infra/docker-compose.yml`)
- Hub server dependencies installed: `npm install` in `apps/hub-server/`
- `packages/types` built: `npm run build` in `packages/types/`
- `ioredis` added to hub-server dependencies

---

## 1. Start Infrastructure

```bash
# From repo root
docker compose -f infra/docker-compose.yml up -d redis

# Verify Redis is reachable
redis-cli ping  # → PONG
```

---

## 2. Start Hub Server

```bash
cd apps/hub-server
npm run dev
```

Verify startup in logs:
- `[hub] Consumer groups created: hub:live-processor, hub:session-processor`
- `[hub] Live Processor started (60 Hz)`
- `[hub] Session Processor started (15 Hz)`
- `[hub] Awaiting telemetry...`

Health check:
```bash
curl http://localhost:3000/healthz  # → ok
```

---

## 3. Inject a Session Event (simulate Tauri client connecting)

```bash
redis-cli XADD iracing:events:session '*' payload \
  '{"active":true,"track_name":"Watkins Glen Boot","player_car_name":"BMW M4 GT3","player_car_idx":3,"session_type":"Race","wall_clock_time":"14:00:00","ts":1719619200000}'
```

Expected hub server log:
```
[hub] Session started: sessionId=1719619200000 track="Watkins Glen Boot" heroCarIdx=3
```

---

## 4. Inject Telemetry (simulate a race lap)

Use the telemetry replay script to inject a sequence of messages:

```bash
# Inject 5 seconds of session telemetry at 15 Hz (75 messages)
node scripts/inject-session-telemetry.js \
  --hero-car-idx 3 \
  --fuel-start 45.0 \
  --fuel-burn-per-lap 2.8 \
  --laps 2 \
  --session-id 1719619200000
```

The script injects:
- `iracing:telemetry:session` entries with `carIdxPosition`, `carIdxLapCompleted`, `carIdxF2Time`, `fuelLevel`, `carIdxOnPitRoad` arrays
- `iracing:telemetry:live` entries with `brake`, `throttle`, `latAccel`, `speed`

---

## 5. Validate Race State KV

After 2 laps of injected telemetry:

```bash
redis-cli GET hub:race-state:1719619200000 | jq .
```

**Expected**:
- `session.sessionPhase` = `"Racing"`
- `field["3"].position` populated
- `hero.fuelLevel` ≈ `45.0 - (2 × 2.8)` = `39.4`
- `hero.safeWindowOpen` = `true` (if injecting mid-straight telemetry)
- `signals.pitWindowOpen` = `false` (fuel surplus, new tires)

```bash
redis-cli GET hub:fuel-model:1719619200000 | jq .
```

**Expected**:
- `burnRatePerLap` ≈ `2.8` (within ±0.05)
- `dataSource` = `"live"`
- `confidenceLevel` = `"low"` after 2 laps (< 3 needed for medium)
- `summary` contains "laps remaining"

---

## 6. Validate Event Bus

Subscribe before injecting a pit stop:

```bash
# Terminal 1: Subscribe
redis-cli subscribe hub:events

# Terminal 2: Inject pit entry
node scripts/inject-pit-entry.js --hero-car-idx 3 --session-id 1719619200000
```

**Expected event** in Terminal 1:
```json
{
  "type": "hero:pit_entry",
  "sessionId": "1719619200000",
  "sessionTime": 1842.3,
  "lapNumber": 3,
  "lapDistPct": 0.02,
  "payload": { "lapNumber": 3 }
}
```

Also verify ring buffer:
```bash
redis-cli LRANGE hub:events:ring:1719619200000 0 4 | jq .
```

---

## 7. Validate Safe Window Signal

Inject a braking zone sequence (high brake input → zero brake → safe window opens):

```bash
node scripts/inject-braking-sequence.js \
  --session-id 1719619200000 \
  --brake-duration-ms 800 \
  --post-brake-distance-m 200
```

Query in-memory state via HTTP:
```bash
curl http://localhost:5173/api/race-state | jq '.hero.safeWindowOpen'
```

**Expected**: `false` during braking, `true` after 150m of travel with throttle > 0.7.

---

## 8. Run Unit Tests

```bash
cd apps/hub-server
npm test
```

**Expected output**:
```
FuelModel
  ✓ computes burnRatePerLap from 5 lap completions (within ±0.05 liters)
  ✓ excludes outlap and inlap from rolling average
  ✓ resets fuelAtLapStart baseline on refuel detection
  ✓ reports lapsRemaining: null for time-based race (SessionLapsRemain = -1)
  ✓ Level 3: estimates fuel from lap count × class default

TireModel
  ✓ classifies nominal when degradation < 0.3s
  ✓ classifies watch when degradation 0.3–0.6s
  ✓ classifies critical when degradation > 0.6s
  ✓ excludes outlap and inlap from stint median

GapModel
  ✓ classifies battle when gap ≤ 1.0s
  ✓ classifies resolved after 2+ checks > 1.5s
  ✓ does not classify lapped-car gaps as battles

LiveProcessor (safe window)
  ✓ safeWindowOpen false when |LatAccel| > 0.4g
  ✓ safeWindowOpen false when Throttle < 0.7
  ✓ safeWindowOpen false when brake event within last 150m
  ✓ safeWindowOpen true when all three conditions satisfied
  ✓ safeWindowOpen false (observer mode, no zones configured)

17 passing (123ms)
```

---

## 9. Load Validation (Manual — SC-001 p99 latency)

To validate p99 KV write latency under realistic session load:

```bash
# From repo root — inject 60 laps at 15 Hz cadence
node scripts/inject-session-telemetry.js --laps 60 --rate 15 --session-id $(date +%s)000
```

While the script runs, monitor hub server logs for `cycleLatencyMs` values. All values should be ≤ 67ms (15 Hz budget). This validates SC-001 "100% of simulated session ticks processed within the 15 Hz budget."

---

## 10. Run Integration Tests

```bash
cd apps/hub-server
npm run test:integration
```

Requires Redis running. Tests inject synthetic telemetry directly and assert on Redis output.

**Expected**: Redis round-trip test confirms events are emitted within one processing cycle.

---

## Validation Checklist

| Scenario | Pass condition |
|----------|---------------|
| Session event triggers State initialization | Hub logs session start, `hub:race-state` key exists in Redis |
| 5 lap completions → Fuel Model converges | `burnRatePerLap` within ±0.05 liters of injected value |
| Pit entry → `hero:pit_entry` event emitted | Event appears in `hub:events` pub/sub and ring buffer |
| Braking zone → `safeWindowOpen = false` | HTTP endpoint returns `false` during injected braking sequence |
| Observer mode, no zones → `safeWindowOpen = false` | Signal is `false` when `source = "observer"` |
| Gap ≤ 1.0s → `gap:battle` event | Event emitted; `activeBattles` includes the pair |
| Redis restart → hub server resumes correctly | After `redis-cli DEBUG SLEEP 5`, hub resumes consuming without restart |
| Hub server restart → resumes from correct offset | After process kill + restart, no events are duplicated or lost |
