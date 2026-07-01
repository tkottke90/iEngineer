<!--
SYNC IMPACT REPORT
==================
Version change: 1.1.1 → 1.1.2 (PATCH — Clarified Postgres audit gate scope in Principle V)

Modified principles:
- V. Observability-Driven — The Postgres audit log gate now explicitly applies to LLM-backed
  agent capabilities only. Rule-based agent capabilities (no LLM inference in the decision
  path) are exempt until M5, provided structured console logs are emitted for all decisions
  and failures. Rationale: Postgres audit tables exist to make LLM decisions forensically
  reproducible. A deterministic rule engine has no hidden state to audit beyond its inputs
  and the structured logs that already capture them.

Added sections: N/A
Removed sections: N/A

Templates requiring updates: none (no principle-level semantics changed)

Follow-up TODOs:
- M5: Add Postgres `engineer_events` table when LLM inference is introduced to the Racing
  Engineer path. At that point the gate applies without exemption.
-->

# iRacing Engineer Constitution

## Core Principles

### I. Real-Time Reliability

The Racing Engineer path (telemetry → LLM → TTS → driver) is time-critical. Every component in
that path MUST prioritize low latency over completeness. Specifically:

- Telemetry ingestion MUST NOT block on LLM calls; use async queuing via Redis Streams
- Voice feedback MUST be delivered within 3 seconds of the triggering telemetry event
- A failure in the Racing Engineer path MUST NOT affect the Stream Engineer path, and vice versa
- Degraded-mode operation (e.g., LLM timeout) MUST fall back gracefully — silence is
  preferable to a crash or a stale/incorrect output delivered late
- **Gate**: Verify that the telemetry pipeline uses separate Redis consumer groups for the
  Racing Engineer and Stream Engineer so one backlog cannot starve the other

**Rationale:** iRacing races run in real time; a 5-second-late pit call is worse than no call
at all. Silence beats wrong-and-late. Path isolation ensures one agent's failure cannot cascade.

### II. Workspace Isolation

This is an npm-workspaces monorepo. Each package and app MUST be self-contained:

- `packages/types` is the shared contract layer — cross-package type dependencies MUST flow
  through it, never via direct relative imports across workspace boundaries
- `packages/ui` MUST contain only Preact components with no business logic
- `apps/tauri-client` and `apps/hub-server` MUST NOT import from each other
- New packages MUST have a clear, single responsibility; no organizational-only packages

**Rationale:** The monorepo packages are consumed by both Tauri (Rust runtime) and the hub
server. Cross-workspace imports create build-order fragility that breaks CI silently.

### III. Agent Autonomy Contract

AI agents advise and act within pre-authored constraints; they MUST NOT make irreversible
decisions unilaterally:

- The Racing Engineer MUST only surface advice (voice cue, pit recommendation) — it MUST NOT
  automatically execute pit strategies or modify car settings
- The Stream Engineer MUST follow the active `BroadcastPlan`; scene switches outside the plan
  require a plan update, not ad-hoc overrides
- All LLM prompts for agent decisions MUST be auditable — requests and responses MUST be
  logged to Postgres before the agent acts on them
- All agent system prompts and decision prompts MUST live in source-controlled files under
  `apps/*/prompts/` or `packages/*/prompts/`; no inline prompt strings in business logic
- Prompt files MUST include a comment header with: purpose, expected input schema, and
  expected output schema
- Prompt changes MUST be treated as behavioral changes and follow the test-backed change
  principle (Principle VI) — prompt changes require corresponding evaluations, not just
  unit tests

**Rationale:** The Racing Engineer operates while the driver is at speed. An autonomous action
(auto-pitting, OBS scene change mid-corner) is unsafe and unrecoverable. Versioned prompts
make behavioral rollback and debugging possible; unversioned prompts make it impossible.

### IV. Local-First Infrastructure

All real-time AI inference and data persistence MUST run on self-hosted infrastructure:

- STT: Whisper via Speaches (base.en model); no cloud STT dependency
- TTS: Chatterbox; no cloud TTS dependency
- Data: Redis Streams (telemetry bus) + Postgres (session history, audit log)
- LLM: Claude API is the default; an OpenAI-compatible local endpoint MUST remain a
  runtime-switchable alternative — no hard-coded provider
- New infrastructure dependencies MUST be added to `infra/` Docker Compose before any
  application code references them

**Rationale:** Race sessions happen on a home network where cloud latency is unpredictable.
Local inference keeps the voice feedback loop deterministic and protects against outages.

### V. Observability-Driven

All data flows MUST be inspectable:

- Telemetry MUST flow through Redis Streams at two speeds: 60 Hz (live) and 15 Hz (session)
- All LLM interactions (prompt + response + latency) MUST be written to Postgres
- OpenTelemetry collector (`infra/`) MUST be the single sink for traces and metrics
- OBS WebSocket events (scene changes, source visibility) MUST be logged with timestamps
- No silent failures: every agent decision that does not produce output MUST emit a structured
  log entry explaining why
- **Gate**: Every new **LLM-backed** agent capability MUST include a Postgres table or column
  for its audit log before the feature is considered complete. Rule-based agent capabilities
  (no LLM inference in the decision path) are exempt from this gate until M5, provided
  structured console logs are emitted for all decisions and failures

**Rationale:** When an AI makes a wrong call mid-race, post-session forensics require a
complete, timestamped log of what the agent saw and decided. Without it, debugging is
impossible.

### VI. Test-Backed Change (NON-NEGOTIABLE)

All behavioral changes to agents, telemetry logic, and shared packages MUST be backed by
automated tests AND linting/formatting checks before a PR is considered complete:

- **Rust**: unit tests via `cargo test`; formatting via `rustfmt`; linting via `clippy`
- **TypeScript**: unit tests via `mocha + chai` for all `packages/types` validators and
  `packages/ui` component contracts; linting via ESLint; formatting via Prettier
- **Integration**: Redis Streams producer/consumer round-trip tests for both telemetry speeds
- **Agent behavior**: prompt changes MUST be backed by evaluations (not unit tests alone) that
  verify the agent's decision output changes as intended across a representative set of inputs
- Feature branches MUST pass `npm run build`, `npm run typecheck`, and all linting/formatting
  checks workspace-wide before merge
- Test-First for new features is STRONGLY PREFERRED; it is REQUIRED for all agent decision
  paths

**Rationale:** Agent decisions affect real race outcomes. An untested fuel calculation or pit
recommendation is a race-ending bug. Linting and formatting gates prevent style drift from
accumulating across Rust and TypeScript simultaneously.

### VII. Incremental Delivery (YAGNI)

Each feature MUST deliver working, demo-able value at the smallest viable scope:

- New agent capabilities MUST be added to one agent at a time (Racing Engineer OR Stream
  Engineer, not both simultaneously in the same feature branch)
- Infrastructure additions MUST have an immediate consumer in the same PR; no speculative infra
- UI components in `packages/ui` MUST be used by at least one app at the time of merge
- Complexity MUST be justified in the plan's Complexity Tracking table before implementation
  begins

**Rationale:** This is a solo developer project. Speculative abstractions become dead weight
and obscure the critical path to a working race session.

## Technology Constraints

The following technology choices are fixed for v1 and MUST NOT be changed without a
constitution amendment:

| Layer | Choice | Rationale |
|---|---|---|
| Desktop client | Tauri 2 + Preact (TypeScript) | Native OS integration + lightweight UI |
| Hub server | Node.js + Hono + hono-preact | SSR + API in a single process |
| Telemetry bus | Redis Streams | Two-speed fan-out without polling |
| iRacing SDK | Custom Rust integration | No suitable community crate |
| TTS | Chatterbox (self-hosted) | Voice-cloning capability, no cloud cost |
| STT | Whisper via Speaches (base.en) | Offline capable, low latency |
| OBS control | WebSocket v5 | Official OBS protocol |
| LLM default | Anthropic Claude API | Frontier reasoning; switchable at runtime |

## Development Workflow

- Build on the existing scaffold at `apps/`, `packages/`, `infra/` — do not reorganize
  the workspace structure without a plan amendment
- All `// TODO` stubs in the scaffold are implementation targets; replace them with
  working code, do not delete them without implementing the intended behavior
- Infrastructure changes (new services, ports, volumes) go to `infra/docker-compose.yml` first
- TypeScript shared types go to `packages/types` before any consuming code is written
- Feature branches MUST pass `npm run build` and `npm run typecheck` (workspace-wide) before
  merge; no broken builds on `main`

## Governance

This constitution supersedes all other project conventions. The project owner (sole developer)
is the constitution's amendment authority. Any AI agent assisting with development MUST surface
constitution violations rather than silently working around them. Violations that require an
amendment MUST be flagged before implementation begins, not discovered in code review.

Amendments require:

1. A documented reason (PR description or spec) explaining the change
2. A version bump following semantic versioning:
   - **MAJOR**: principle removal, redefinition, or backward-incompatible governance change
   - **MINOR**: new principle or section, material expansion of existing guidance
   - **PATCH**: clarification, wording, typo fix, non-semantic refinement
3. An update to this file's Sync Impact Report comment reflecting what changed
4. All PRs MUST reference relevant principles in their Constitution Check section

All feature plans MUST include a Constitution Check gate before Phase 0 research.

**Version**: 1.1.2 | **Ratified**: 2026-06-26 | **Last Amended**: 2026-06-30
