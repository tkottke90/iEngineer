# Implementation Plan: Rule-Based Alerts + Voice

**Branch**: `004-rule-based-alerts-voice` | **Date**: 2026-06-30 | **Spec**: [spec.md](spec.md)

## Summary

Add the first driver-facing feature: a Racing Engineer service in the hub server that subscribes to the event bus, evaluates rule-based alert conditions, generates TTS audio via Chatterbox, and delivers audio clips to the Tauri client for immediate playback. Includes Tier 1 (gate-override) and Tier 2 (safe-window gated) alerts, a priority message queue with deduplication, Chattiness personality config, and an audio device test panel in Tauri settings.

**Audio delivery architecture**: hub generates MP3 via `POST /tts` (Chatterbox clone mode) → stores in-memory → publishes `AudioClipRef` on `voice:audio` Redis pub/sub → Tauri receives → fetches via `GET /api/audio/:audioId` → plays with existing `AudioPlayback::play_url()`.

## Technical Context

**Language/Version**: TypeScript (Node.js 22) — hub-server; Rust (edition 2021) — Tauri client; TypeScript (Preact) — UI

**Primary Dependencies**: ioredis (pub/sub), undici (Chatterbox HTTP call — bundled with Node.js 22, no extra install), rodio (Rust audio playback — already present), redis-rs (already present), cpal (already present)

**Storage**: In-process `Map<audioId, Buffer>` for audio clips (60s TTL as module constant `AUDIO_CLIP_TTL_MS = 60_000` in `audio-store.ts` — not user-configurable; the Rust `subscriber.rs` hard-codes the same value and both must be updated together); in-process `Map<alertKey, DedupEntry>` for deduplication; JSON config files for radio blackout zones and engineer config; Redis **key** (SET/GET) `hub:config:chattiness` ("Low"|"Default") written by Tauri on config save and read by `RacingEngineerService` at each dispatcher tick — this is the runtime sync channel for Chattiness preference (distinct from Redis **pub/sub**: `voice:audio` is a pub/sub channel for `AudioClipRef` delivery, not a key)

**Testing**: mocha + chai (hub-server TypeScript); cargo test (Tauri Rust)

**Target Platform**: macOS / Windows desktop (Tauri); local hub server (Node.js)

**Performance Goals**: Tier 1 alerts delivered within 3 seconds of triggering event (end-to-end: event → TTS → pub/sub → Tauri fetch → playback start)

**Constraints**: No LLM calls; no STT; no interrupts (clips play to completion); TTS failure = log + drop, no retry

**Scale/Scope**: Single driver, single active session, ~10 alert types

## Constitution Check

*GATE: Must pass before implementation. Re-check after design.*

| Principle | Check | Status |
|-----------|-------|--------|
| I. Real-Time Reliability | Racing Engineer uses separate Redis consumer group from Stream Engineer? | ✅ Racing Engineer subscribes to `hub:events` pub/sub channel (not the Stream producer group); separate concern. TTS failure gracefully drops — no crash. |
| I. Real-Time Reliability | Voice feedback ≤ 3 seconds? | ✅ Specified as SC-001; Chatterbox GPU latency 0.5–2s leaves headroom. |
| II. Workspace Isolation | New types flow through `packages/types`? | ✅ `engineer.ts` added to `packages/types/src/`; no cross-workspace direct imports. |
| II. Workspace Isolation | New `engineer/` modules in hub-server are self-contained? | ✅ No imports into `apps/tauri-client`. |
| II. Workspace Isolation | `useMicLevel.ts` (Web Audio hook) placement in `packages/ui/src/hooks/`? | ✅ **Documented decision**: `packages/ui` is restricted to "no business logic," which the constitution defines as domain/agent decision logic (alert rules, dedup, strategy). A hook wrapping the browser `getUserMedia`/Web Audio level meter is presentation-layer I/O with zero domain knowledge — it computes a display value for a UI bar, identical in kind to a resize-observer or focus hook. It is used by exactly one component (`AudioDeviceTestPanel`) in the same package (Principle VII satisfied). Placing it in `packages/ui/src/hooks/` is compliant; no separate package (which Principle VII forbids as organizational-only) and no amendment are required. This entry closes the recurring analyzer flag. |
| III. Agent Autonomy | Engineer only surfaces advice (voice cue), does not execute pit strategy? | ✅ Alerts are advisory only; no car control. |
| III. Agent Autonomy | No LLM calls in M4? | ✅ Rule-based only. M5 MUST add prompt source files under `apps/hub-server/prompts/` and audit logging when LLM inference is introduced. |
| IV. Local-First | TTS via Chatterbox (self-hosted)? | ✅ `http://10.0.0.12:8004` (homelab); no cloud TTS. |
| IV. Local-First | New infra dependency (Chatterbox) added to `infra/docker-compose.yml`? | ✅ Already present (commented); uncomment to activate. |
| V. Observability | TTS failures emit structured log with alertType, tier, lapNumber, failureReason, timestamp? | ✅ Defined in `EngineerFailureLog` contract. |
| V. Observability | Audio delivery events logged? | ✅ Each clip published and played will emit structured log lines. |
| V. Observability | Postgres audit log gate? | ✅ Exempt — M4 Racing Engineer is rule-based (no LLM inference). Constitution v1.1.2 explicitly defers the Postgres gate to LLM-backed capabilities. Gate applies at M5 when LLM enters the path. (Exemption condition: structured console logs MUST be emitted for all decisions and failures — see `EngineerFailureLog` and dispatcher suppression logs.) |
| VI. Test-Backed Change | Unit tests for alert rules, dedup tracker, and message queue? | ✅ Required before merge. |
| VI. Test-Backed Change | Integration test: event → TTS → pub/sub round-trip? | ✅ Required; Chatterbox can be mocked at HTTP layer. |
| VII. YAGNI | No M5 personality features implemented? | ✅ Familiarity/Aggression are config stubs only. |
| VII. YAGNI | Complexity justified? | ✅ Each new module has a single responsibility; no speculative abstractions. |

**Constitution violations**: None. No amendment required.

## Project Structure

### Documentation (this feature)

```text
specs/004-rule-based-alerts-voice/
├── plan.md              # This file
├── research.md          # Phase 0 — architecture decisions
├── data-model.md        # Phase 1 — types and file layout
├── quickstart.md        # Phase 1 — validation scenarios
├── contracts/
│   ├── alert-rules.md   # Alert rule definitions and dedup logic
│   ├── chatterbox-tts.md # Chatterbox API contract
│   └── hub-audio-endpoint.md # Hub HTTP + pub/sub contracts
└── tasks.md             # Phase 2 — generated by /speckit-tasks
```

### Source Code

```text
packages/types/src/
└── engineer.ts                       # New: AlertTier, QueuedAlert, AudioClipRef, PersonalityConfig, etc.

apps/hub-server/src/
├── engineer/
│   ├── racing-engineer.ts            # Top-level service; subscribes to hub:events pub/sub
│   ├── alert-rules.ts                # Tier 1 + Tier 2 rule evaluators → QueuedAlert | null
│   ├── dedup-tracker.ts              # DedupMap; per-condition cleared/fired tracking
│   ├── message-queue.ts              # Priority queue; Tier 1 head / Tier 2 tail; safe-window gate
│   ├── tts-client.ts                 # POST /tts → MP3 Buffer (Chatterbox clone mode)
│   ├── audio-store.ts                # In-memory clip map + getAudioStore() accessor; TTL cleanup (route handler lives in src/api.ts)
│   └── personality-config.ts         # Loads engineer-config.json; Chattiness filter
├── config/
│   ├── radio-blackout-zones.json     # Static blackout zone config (empty default)
│   └── engineer-config.json          # Thresholds, Chatterbox URL, voice ID
└── server-init.ts                    # Wire RacingEngineerService on startup

apps/tauri-client/src-tauri/src/
├── engineer/
│   ├── mod.rs
│   ├── subscriber.rs                 # PubSubListener for voice:audio; stale-clip check
│   └── playback_queue.rs             # Sequential no-interrupt Tokio task; calls play_url()
├── commands.rs                       # Add: test_audio_playback, get_ptt_status
└── lib.rs                            # Register new commands; spawn engineer subscriber task

apps/tauri-client/src/pages/
└── Setup.tsx                         # Add AudioDeviceTestPanel section

packages/ui/src/components/
└── AudioDeviceTestPanel/
    └── index.tsx                     # Mic input meter, PTT test, playback test button
```

## Complexity Tracking

No constitution violations — table not required.

## Implementation Phases

### Phase A: Types + Config (prerequisite for everything else)

1. Add `packages/types/src/engineer.ts` with all new shared types
2. Add `hero:pit_limiter_active` to `EventType` in `packages/types/src/events.ts`
3. Create `apps/hub-server/config/engineer-config.json` (default values)
4. Create `apps/hub-server/config/radio-blackout-zones.json` (empty zones array — JSON only, per FR-010)
5. Extend `AppConfig` in `apps/tauri-client/src-tauri/src/state.rs` with `chattiness`, `familiarity`, and `aggression` fields (all `String`, default `"Default"`) and verify `ptt_hotkey: String` with default `"F13"` is present — per T007

**Test gate**: `npm run build && npm run typecheck` must pass workspace-wide.

### Phase B: Hub — Alert Rules + Queue (core logic, no I/O)

1. Implement `alert-rules.ts` — two pure functions: `evaluateTier1(event, config) → QueuedAlert | null` and `evaluateTier2(event, signals, config) → QueuedAlert | null`; M4 implements T1-01–T1-04 and T2-01 only; T2-02–T2-06 are `return null` stubs marked `// TODO M5`
2. Implement `dedup-tracker.ts` — `DedupTracker` class with `shouldFire()`, `recordFired()`, `recordCleared()`
3. Implement `message-queue.ts` — `PriorityMessageQueue` class with `enqueue()`, `dequeueNext(lapDistPct, zones)`
4. Implement `personality-config.ts` — `loadEngineerConfig()`, `shouldSuppressAlert(alert, chattiness)`

**Test gate**: Unit tests for all four modules (mocha + chai). Alert rules tested against fixture `RaceEvent` objects. Dedup tracker tested for same-lap suppression, condition-clear reset, and pit-window-specific reset. Queue tested for Tier 1 priority ordering and safe-window gate.

### Phase C: Hub — TTS Client + Audio Store

1. Implement `tts-client.ts` — `generateClip(text): Promise<Buffer>` via `POST /tts`; on failure emit `EngineerFailureLog` and throw
2. Implement `audio-store.ts` — `AudioStore` class: `store(buffer): { audioId, clipUrl }`, `get(audioId): Buffer | null`, TTL cleanup interval
3. Add `GET /api/audio/:audioId` route to the hub Hono app in `src/api.ts` (alongside `/api/race-state`, `/api/fuel-model` — not the hono-preact `routes.ts` page table)

**Test gate**: Unit test for `audio-store.ts` (store, get, TTL eviction). Integration test: `tts-client.ts` with a real Chatterbox instance (or HTTP mock).

### Phase D: Hub — Racing Engineer Service

1. Implement `racing-engineer.ts` — `RacingEngineerService` class:
   - Subscribes to `hub:events` Redis pub/sub channel
   - On each event: evaluate rules → dedup check → chattiness filter → enqueue
   - Background dispatcher: on each safe-window tick, dequeue next eligible alert → generate TTS → publish `AudioClipRef` to `voice:audio`
   - See T020 for full error-handling contract (`_generating` flag, `finally` guard, fuel history reset)
2. Wire `RacingEngineerService` into `server-init.ts` startup

**Test gate**: Integration test — publish synthetic `hero:fuel_critical` to `hub:events`, confirm `voice:audio` message arrives within 5 seconds (allowing for TTS latency). Mock Chatterbox at HTTP layer.

### Phase E: Tauri — Engineer Subscriber + Playback Queue

1. Implement `engineer/subscriber.rs` — spawn `PubSubListener` on `voice:audio`; parse `AudioClipRef`; stale-clip check (`generatedAt + 60000 < now` → discard with log); enqueue `clipUrl` in `PlaybackQueue`
2. Implement `engineer/playback_queue.rs` — Tokio task that dequeues `clipUrl` strings sequentially and calls `AudioPlayback::play_url()`; no interruption; logs each play and any error
3. Register `engineer` module in `lib.rs`; spawn subscriber task in `setup()`
4. Add `test_audio_playback` Tauri command — invokes hub's test endpoint to generate a sample clip, enqueues it

**Test gate**: `cargo test` for playback queue sequential ordering. Manual smoke test: publish to `voice:audio` → audio plays in Tauri.

### Phase F: Tauri — Audio Device Test Panel

1. Add `POST /api/audio/test` endpoint to the hub Hono app in `src/api.ts` (not `routes.ts`) — synthesizes a fixed test phrase ("Racing engineer online. Audio check.") via `TtsClient`, stores in `AudioStore`, returns `{ clipUrl }` (test-only shortcut; does not use `voice:audio` pub/sub channel)
2. Add `test_audio_playback` Tauri command (`commands.rs`) — calls hub `POST /api/audio/test`, enqueues the returned `clipUrl` via `PlaybackQueue`
3. Implement `packages/ui/src/components/AudioDeviceTestPanel/index.tsx`:
   - "Play Test Clip" button — invokes `test_audio_playback` Tauri command; 30s synthesis timeout before error state
   - Mic input level meter — Web Audio API `getUserMedia` via `useMicLevel.ts` hook
   - PTT trigger test — listens for PTT hotkey event, displays confirmation
4. Add `AudioDeviceTestPanel` to `apps/tauri-client/src/pages/Setup.tsx`

**Test gate**: Manual: open Settings → Audio; all three sub-tests pass per quickstart Scenario 6.

### Phase G: Infra Verification

1. Verify `chatterbox-models` volume is present in `infra/docker-compose.yml` and Chatterbox service is uncommented

**Test gate**: `docker compose up -d` starts Chatterbox; sample `curl -X POST http://10.0.0.12:8004/tts -H "Content-Type: application/json" -d '{"text":"test","voice_mode":"clone","reference_audio_filename":"voice2.wav","output_format":"mp3","stream":false}' --output test.mp3` returns an MP3 file.

## Definition of Done

- [ ] All unit tests pass: `npm test` (hub-server), `cargo test` (tauri)
- [ ] `npm run build && npm run typecheck` passes workspace-wide
- [ ] ESLint + Prettier pass (hub-server, packages/types, packages/ui)
- [ ] rustfmt + clippy pass (tauri)
- [ ] All quickstart scenarios pass (Scenarios 1–7)
- [ ] Deploy test: live practice lap with pit window alert and fuel critical alert heard through speakers
- [ ] No duplicate alerts in deploy test
- [ ] TTS failure log emitted correctly when Chatterbox is stopped
