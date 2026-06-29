# Quickstart: Validating Redis Telemetry Publishing

_Validation guide for spec 002. Covers prerequisites, setup, and runnable test scenarios that prove each user story end-to-end._

---

## Prerequisites

- Redis running locally: `docker compose -f infra/docker-compose.yml up -d redis`
- Redis CLI available: `redis-cli -h localhost -p 6379 ping` should return `PONG`
- iRacing client installed on Windows (for Scenarios 3–9)
- Tauri client built and running on Windows: `npm run tauri dev -w apps/tauri-client`
- All CI integration tests passing (`cargo test -p iracing-engineer-lib`)

---

## Scenario 1 — Client starts without Redis (graceful degradation, US4 SC-005)

**Goal**: Confirm the client does not crash when Redis is unreachable at startup.

```bash
# Stop Redis first
docker compose -f infra/docker-compose.yml stop redis

# Start the Tauri client
# → Diagnostic UI should load normally
# → Look for a warn-level log line: "Failed to connect to Redis: ..."
# → iRacing data reading should work normally (no blank panels)
```

**Expected**: Client starts, diagnostic UI is functional, a warning is logged. No crash, no error dialogs.

---

## Scenario 2 — Redis reconnects while client is running (SC-004)

**Goal**: Confirm client reconnects to Redis within 10 seconds after Redis becomes available.

```bash
# With client running and Redis stopped:
docker compose -f infra/docker-compose.yml up -d redis

# In a second terminal, poll for activity:
redis-cli XLEN iracing:events:connection
```

**Expected**: Within 10 seconds, `XLEN iracing:events:connection` returns ≥ 1 (snapshot was published). No client restart required.

---

## Scenario 3 — Connection state events (US1 SC-001, FR-001)

**Goal**: Confirm connection events appear within 2 seconds of iRacing state changes.

```bash
# Subscribe to connection events:
redis-cli XREAD COUNT 10 BLOCK 5000 STREAMS iracing:events:connection 0

# With client running and Redis up, close iRacing.
# Then reopen iRacing and join a session.
```

**Expected**:
- A `{"status":"Disconnected",...}` entry appears within 2 seconds of closing iRacing
- A `{"status":"Connected",...}` entry appears within 2 seconds of iRacing opening
- Both entries have a `payload` field containing valid JSON (see `contracts/redis-streams.md`)

---

## Scenario 4 — Session metadata events (US1 SC-006, FR-002)

**Goal**: Confirm session metadata is published within 2 seconds of a session starting or changing.

```bash
# Watch the session event stream:
redis-cli XREAD COUNT 10 BLOCK 5000 STREAMS iracing:events:session 0

# Enter a practice session in iRacing.
# Then switch to qualifying (if available).
```

**Expected**:
- An `{"active":true,"track_name":"...","car_name":"...","session_type":"Practice",...}` entry within 2 seconds of entering practice
- An updated entry with `session_type: "Qualify"` within 2 seconds of switching, without a preceding `active:false` entry
- When leaving the session: `{"active":false,...}` appears within 2 seconds

---

## Scenario 5 — Live telemetry stream rate (US2 SC-002)

**Goal**: Confirm live telemetry arrives at ≥ 60 Hz with no gap > 50 ms.

```bash
# Enter an active on-track session. Then:
redis-cli XRANGE iracing:telemetry:live - + COUNT 20
```

**Expected**:
- At least 20 entries appear
- Each entry contains `Speed`, `RPM`, `Throttle`, `Brake`, `Gear`, `SteeringWheelAngle` fields
- Adjacent `_ts` values differ by ≤ 50 ms (typically 15–17 ms at 60 Hz)
- **SC-002 gate**: The XRANGE output showing ≤ 50 ms gaps MUST be posted as a PR comment before merge

For rate validation:
```bash
# Count entries produced in 1 second:
START=$(redis-cli TIME | tr '\n' '.')
redis-cli XRANGE iracing:telemetry:live - + COUNT 1000 | grep "_ts" | wc -l
# Expect ≥ 60 entries per second of on-track driving
```

---

## Scenario 6 — Session-rate telemetry (US3 SC-003, FR-004)

**Goal**: Confirm session-rate stream publishes at ≥ 15 Hz with fuel and lap data.

```bash
# Drive for one full lap then:
redis-cli XRANGE iracing:telemetry:session - + COUNT 20
```

**Expected**:
- Entries contain `FuelLevel`, `LapLastLapTime`, `CarIdxPosition` fields
- Adjacent `_ts` values differ by ≤ 100 ms (typically ~67 ms at 15 Hz)
- `FuelLevel` decreases across entries as fuel is consumed
- After completing a lap, `LapLastLapTime` reflects the completed lap time

---

## Scenario 7 — FR-009 snapshot on Redis reconnect (US4 FR-009)

**Goal**: Confirm snapshot behavior on Redis reconnect while iRacing is connected.

```bash
# 1. Client running, iRacing connected, session active.
# 2. Stop Redis: docker compose stop redis
# 3. Wait 15 seconds (allows full backoff cycle).
# 4. Restart Redis: docker compose up -d redis
# 5. Immediately read the latest event entries:
redis-cli XREVRANGE iracing:events:connection + - COUNT 1
redis-cli XREVRANGE iracing:events:session + - COUNT 1
```

**Expected**:
- `iracing:events:connection` latest entry: `{"status":"Connected",...}` (FR-009 path c)
- `iracing:events:session` latest entry: `{"active":true,...}` with current session data (FR-009 path c)
- Both appear within 10 seconds of Redis becoming available again (SC-004)

---

## Scenario 8 — Telemetry suppressed with no active session (FR-011)

**Goal**: Confirm no telemetry is published when at the iRacing main menu.

```bash
# With iRacing open but not in a session (main menu):
redis-cli XLEN iracing:telemetry:live
# Wait 5 seconds
redis-cli XLEN iracing:telemetry:live
```

**Expected**: XLEN does not increase. Event streams still show `Connected` status. Entering a session should immediately begin telemetry.

---

## Scenario 9 — Redis URL reconfiguration (US4 FR-010)

**Goal**: Confirm URL change takes effect on next reconnect without restart.

1. Update the Redis URL in the Tauri client Settings panel to an invalid address (e.g. `redis://localhost:9999`).
2. Confirm warning logs appear (connection refused).
3. Update the URL back to `redis://localhost:6379`.
4. Wait for the backoff cycle to complete (≤ 10 seconds).

**Expected**: Client reconnects to the correct Redis instance and resumes publishing. No client restart required.

**Extended validation — FR-010 passive-apply while actively connected (E2)**:

5. With Redis reconnected and publishing on port 6379, change the URL in Settings to `redis://localhost:7777` (do not stop Redis).
6. Confirm publishing continues uninterrupted on port 6379 — the URL change is NOT applied immediately.
7. Kill Redis (`docker stop <container>`). Observe `warn!` logs as reconnect attempts target port 7777 (fails — nothing listening there).
8. Start a second Redis instance on port 7777 (`docker run -p 7777:6379 redis:7-alpine`). Wait for the backoff cycle (≤ 10 seconds).

**Expected (step 8)**: Client reconnects to `redis://localhost:7777` and resumes publishing — confirms the URL set in step 5 was stored and applied passively on the next reconnect attempt, not on save.

---

## CI Integration Tests (SC-007)

Seven round-trip tests run automatically on every PR via `cargo test`:

| Test | Validates |
|------|-----------|
| `test_connection_event_roundtrip` | ConnectionEvent serializes/deserializes correctly via Redis Streams XADD/XRANGE |
| `test_live_frame_roundtrip` | LiveTelemetryFrame fields survive XADD/XRANGE round-trip |
| `test_session_rate_frame_roundtrip` | SessionTelemetryFrame fields survive XADD/XRANGE round-trip |
| `test_fr009_path_a_dual_event` | iRacing disconnect emits ConnectionEvent(Disconnected) + SessionEvent(None) |
| `test_fr009_path_b_negative` | Redis reconnect while disconnected emits only ConnectionEvent(Disconnected), no SessionEvent |
| `test_fr009_path_c_none` | Redis reconnect while connected + no session emits ConnectionEvent(Connected) + SessionEvent(active:false) |
| `test_fr009_path_c_some` | Redis reconnect while connected + active session emits ConnectionEvent(Connected) + full SessionEvent |

Run with:
```bash
cargo test -p iracing-engineer-lib -- --test-threads=1
```

These tests use a local Docker Redis instance (`redis://localhost:6379`). They validate serialization round-trip correctness and FR-009 branching logic, but do not validate the 60 Hz rate constraint (manual only, see Scenario 5).
