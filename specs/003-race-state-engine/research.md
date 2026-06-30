# Research: Race State Engine

**Feature**: `003-race-state-engine`  
**Date**: 2026-06-29

---

## Decision 1 — Redis Consumer Group Pattern (XREADGROUP)

**Decision**: Use a single `XREADGROUP` call blocking on both telemetry streams simultaneously using `>` IDs for live consumption. On hub server restart, run `XAUTOCLAIM` to reclaim pending (unacknowledged) messages before switching to `>` mode.

**Rationale**:
- `XREADGROUP ... BLOCK 50 STREAMS iracing:telemetry:live iracing:telemetry:session > >` blocks on both streams in a single call and returns as soon as either has new entries. No separate connections or polling loops needed per stream.
- `>` (special ID) tells the server to deliver only new, never-seen messages to this consumer. The Pending Entries List (PEL) tracks delivery until `XACK` is sent.
- On restart, pending messages (delivered but not acknowledged before crash) are reclaimed with `XAUTOCLAIM stream group consumer idle_ms 0`, which migrates idle messages back to the current consumer before switching to `>`.
- Because `iracing:telemetry:live` is capped at `MAXLEN 3600` (~60 seconds at 60 Hz) and `iracing:telemetry:session` at `MAXLEN 900` (~60 seconds at 15 Hz), consumer group state provides meaningful restart safety within a 60-second crash window. Older entries are unavailable either way.

**Consumer group names** (created on hub server startup with `XGROUP CREATE ... $ MKSTREAM`):
- Live stream: group `hub:live-processor`, consumer `hub-server-1`
- Session stream: group `hub:session-processor`, consumer `hub-server-1`

**Alternatives considered**:
- Separate XREADGROUP calls per stream on separate connections: Simpler crash-restart logic but doubles connection count and requires managing two concurrent blocking loops. Not worth the complexity for two streams.
- XREAD without consumer groups: Loses PEL tracking and restart offset; acceptable for the live 60 Hz stream (sensor data, not business events), but required by FR-003 for both streams.

---

## Decision 2 — 60 Hz Processing Loop

**Decision**: Use `setInterval(fn, 16)` in the main Node.js thread. Each callback must complete in under 2ms; the safe window evaluation (3 comparisons + rolling distance buffer update) is well within that budget.

**Rationale**:
- The safe window evaluator performs three arithmetic comparisons and a ring-buffer distance update per tick. Profiling estimate: < 0.1ms per tick even at 60 Hz.
- `setInterval(fn, 16)` delivers ±3–5ms jitter in practice (OS scheduling granularity), which is acceptable. The safe window signal is a boolean gate, not a precise timestamp — a few ms of jitter does not materially affect message delivery timing.
- Worker threads (for CPU-offloading) add ~0.1–0.2ms message-passing overhead per frame and increase implementation complexity. Not justified when the callback is < 0.1ms.
- The XREADGROUP consumer loop runs in a separate `async` loop (not inside `setInterval`), so the two loops do not block each other. Redis I/O latency (local network, < 1ms) does not affect the 60 Hz timer.

**Practical pattern**:
```
setInterval(async () => {
  // Drain all queued live telemetry (batch read from ring buffer / latest state)
  // Update safe window signal from latest data
  // Write updated signal to DerivedSignals in-memory state
}, 16);
```

The XREADGROUP loop continuously drains the stream and writes the latest live telemetry fields to a shared in-memory buffer. The `setInterval` loop reads that buffer — never blocking on Redis — so its callback is always < 1ms.

**Alternatives considered**:
- Worker thread per processor: Adds IPC overhead (~0.2ms/message), more complex lifecycle management. Not justified for sub-millisecond callbacks.
- `setImmediate` busy-loop with hrtime drift correction: More precise timing but CPU-hot (100% core utilization on the timer). Unnecessary for ±5ms acceptable jitter.
- Separate Node.js process per processor: Over-engineered for a single-machine deployment.

---

## Decision 3 — Redis Connections: XREADGROUP + PUBLISH Coexistence

**Decision**: Two ioredis connections in the hub server process:
1. **Consumer connection** — used exclusively for XREADGROUP (blocking reads) and XACK.
2. **Command connection** — used for all non-blocking writes: PUBLISH (event bus), SET (KV snapshots), LPUSH + LTRIM (event ring buffer), XGROUP CREATE (setup).

**Rationale**:
- A blocking XREADGROUP call on a connection cannot be interrupted by other commands while it is waiting. Using the same connection for both streaming and PUBLISH would require waiting for each BLOCK timeout before issuing the PUBLISH, introducing up to 50ms latency on event delivery.
- Redis Pub/Sub subscriber mode (SUBSCRIBE command) puts a connection into subscriber-only mode — no other commands allowed. The hub server in M3 is a **publisher only** on the event bus (no subscriptions in the hub), so a dedicated subscriber connection is not needed.
- Two connections = ~100KB RAM overhead; negligible.

**Connection setup**:
```
consumerConnection = new Redis(config)   // XREADGROUP, XACK
commandConnection  = new Redis(config)   // PUBLISH, SET, LPUSH, LTRIM, XGROUP CREATE
```

**Alternatives considered**:
- Single connection with manual sequencing: XREADGROUP with BLOCK 0 (infinite wait) would starve the PUBLISH path indefinitely. BLOCK with timeout (e.g., 50ms) allows interleaving but adds 50ms worst-case latency to all event publishing — unacceptable for a 67ms processing cycle budget.
- Three connections (add a publisher-only connection): Not needed; the command connection handles publishing and KV writes without conflicts since neither PUBLISH nor SET is a blocking command.

---

## Decision 4 — Types Package Extension

**Decision**: Add `pitWindowOpen: boolean` to `DerivedSignals` in `packages/types/src/race-state.ts`, and add `summary: string` to `FuelModel` in `packages/types/src/models.ts`. Add `estimatedPitDuration: number | null` to `CarState`.

**Rationale**:
- `pitWindowOpen` was clarified in the spec as a Fuel + Tire Model signal (FR-020a); it belongs in `DerivedSignals` alongside `safeWindowOpen` and `cutWindowOpen`.
- `FuelModel.summary` is required by FR-013 (pre-formatted natural-language string for voice briefings). The types package is the shared contract layer; adding the field there ensures hub-server and any future consumer agree on the shape.
- `CarState.estimatedPitDuration` is derived in the hub server (from `pitExitTime - pitEntryTime`) and needs to be in the shared type so overlays and the Racing Engineer can read it from the KV snapshot.

**Alternatives considered**:
- Extend types in hub-server only: Violates Principle II (Workspace Isolation) — cross-package type dependencies must flow through `packages/types`.

---

## Decision 5 — Redis Key Namespace

**Decision**: Hub server uses the `hub:` namespace prefix for all Redis keys it writes, distinct from the `iracing:` prefix used by the Tauri client.

| Key | Type | Content | TTL |
|-----|------|---------|-----|
| `hub:race-state:{sessionId}` | String (JSON) | Full `RaceState` snapshot | 2h |
| `hub:fuel-model:{sessionId}` | String (JSON) | `FuelModel` snapshot | 2h |
| `hub:tire-model:{sessionId}` | String (JSON) | `TireModel` snapshot | 2h |
| `hub:events:ring:{sessionId}` | List | Last 100 `RaceEvent` JSON entries (LPUSH + LTRIM) | 2h (via EXPIREAT reset on each write) |
| `hub:events` | Pub/Sub channel | `RaceEvent` JSON payloads | N/A (ephemeral) |

**Rationale**: Clear namespace separation makes debugging and monitoring trivial — `KEYS hub:*` returns only hub-server state; `KEYS iracing:*` returns only Tauri-published telemetry. No key collisions are possible.
