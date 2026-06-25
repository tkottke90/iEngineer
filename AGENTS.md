# AGENTS.md — iRacing Engineer

This file is authoritative. When any instruction here conflicts with a user request, flag the conflict before proceeding. Do not silently violate these constraints.

---

## Project Overview

iRacing Engineer is an AI-powered race engineer and stream director for sim racers. It is a **TypeScript + Rust monorepo** (npm workspaces). Two AI agents run on a homelab hub server and communicate with a Tauri desktop app on the racing PC via Redis.

See `Docs/` for full product, architecture, and spec documentation. Consult it before making structural decisions.

---

## Monorepo Layout

```
apps/tauri-client/   Tauri 2 (Rust backend + Preact webview) — racing PC
apps/hub-server/     Node.js hub — homelab Docker
packages/types/      Shared TypeScript types (source of truth for Redis schema)
packages/ui/         Shared Preact components
infra/               Docker Compose stack
```

---

## NON-NEGOTIABLE: hub-server is built on hono-preact

> **This is a hard constraint. Do not work around it, do not "simplify" it, do not replace it with raw Hono, Express, or any other framework.**

The hub-server uses **[hono-preact](https://github.com/sbesh91/hono-preact)** (`nodeAdapter`). Full framework docs: <https://framework.sbesh.com/llms-full.txt>

hono-preact is a Vite-driven full-stack framework: Hono on the server, Preact in the browser, manifest-driven routes, typed loaders/actions, streaming everywhere.

### Required file structure

```
apps/hub-server/
  vite.config.ts          honoPreact({ adapter: nodeAdapter() }) — required
  src/
    routes.ts             defineRoutes() — single source of truth for ALL routes
    api.ts                Custom Hono app for REST/WebSocket endpoints (merged by createServerEntry)
    server.tsx            createServerEntry(routes, { api }) — framework entry point
    pages/
      <page>.tsx          definePage() or serverLoaders.default.View(...)
      <page>.server.ts    defineLoader() / defineAction() co-located with page
    pipeline/             Telemetry processors (no hono-preact dependency)
    state/                Race state + derived models (no hono-preact dependency)
    agents/               Racing Engineer + Stream Engineer (no hono-preact dependency)
    services/             LLM, TTS, STT, OBS, Discord, iRacing API clients
    db/                   PostgreSQL queries and migrations
    redis/                Redis client, stream consumers, pub/sub
```

### Routing rules

- **All UI pages** go in `src/pages/` as `.tsx` + `.server.ts` pairs and are declared in `src/routes.ts` via `defineRoutes()`.
- **All REST API routes** (race state, sessions, broadcast plans, config) go in `src/api.ts` as a standard Hono app. `createServerEntry` merges it.
- **WebSockets** use the hono-preact WebSocket/rooms system or Hono's WebSocket helper mounted in `api.ts` — not a separate route file.
- **Overlay endpoints** (OBS browser sources) are Hono routes in `api.ts`.
- **Never** create a manual `app.ts` that assembles a Hono app from scratch for the UI layer.

### Loader/action pattern

```ts
// src/pages/race-control.server.ts
import { defineLoader, defineAction } from 'hono-preact';

export const serverLoaders = {
  default: defineLoader(async ({ c }) => {
    // return typed data for the page
  }),
};

export const serverActions = {
  updatePlan: defineAction(async (_ctx, payload) => {
    // mutate, return result
  }),
};
```

```tsx
// src/pages/race-control.tsx
import { definePage } from 'hono-preact';
import { serverLoaders } from './race-control.server.js';

const View = serverLoaders.default.View(
  ({ data }) => <RaceControlCenter data={data} />,
  { fallback: <LoadingScreen /> },
);

export default definePage(View);
```

### Dev and build scripts

```jsonc
// apps/hub-server/package.json
"scripts": {
  "dev": "vite dev",
  "build": "vite build",
  "start": "node dist/server.js",
  "typecheck": "tsc --noEmit"
}
```

`tsx watch` is **not** the dev server for hub-server. Vite is.

### What NOT to do

- Do **not** use `tsx watch src/index.ts` as the hub-server dev command.
- Do **not** create `src/app.ts` that manually assembles a Hono instance for the UI layer.
- Do **not** put UI pages inside `src/routes/ui/` — they belong in `src/pages/`.
- Do **not** skip the `vite.config.ts` or `src/routes.ts` manifest.
- Do **not** import hono-preact page components from raw Hono route handlers.

---

## LLM Client (hub-server)

The LLM client uses **LangChain** (`@langchain/core`, `@langchain/anthropic`, `@langchain/openai`). Both frontier (Claude) and local (OpenAI-compatible) backends implement `BaseChatModel` and are hot-swapped at runtime via `LLM_MODE` env var.

- **Do not** add `@anthropic-ai/sdk` or `openai` directly. Use the LangChain wrappers.
- Tool definitions use `parameters` (JSON Schema), not `input_schema`.
- See `src/services/llm/client.ts` for the `ConversationMessage` / `ToolCall` types.
- The agentic loop in STT handler passes `response.asMessage` + typed `ToolMessage`s with IDs — do not revert to raw `{ role: "user" }` tool result messages.

---

## TypeScript / Shared Types

- All types shared between hub-server and tauri-client webview live in `packages/types`.
- Types that cross the **Redis boundary** are defined in Rust (`#[derive(TS)]`) and exported to `packages/types/src/generated/` via `cargo test`. Do not hand-write types that duplicate Rust structs — run the export instead.
- Types that cross the **Tauri IPC boundary** are generated by `tauri-specta`. Do not hand-write them.

---

## Rust (tauri-client)

- The iRacing SDK integration is custom Rust against `irsdk_defines.h` — do not introduce community SDK crates.
- Audio I/O uses `cpal` (capture) and `rodio` (playback) — do not use browser Web Audio API for anything in the audio pipeline.
- Resampling uses `rubato` — do not shell out to ffmpeg from Tauri for audio resampling.
- Camera control uses the iRacing broadcast message API (Windows `PostMessage`) — this is intentionally Windows-only and not a bug.

---

## Redis Architecture

Two telemetry streams, never merged:

| Stream | Rate | Content |
|--------|------|---------|
| `telemetry:live` | 60 Hz | Brake, throttle, lateral G, speed, per-car lap dist pct |
| `telemetry:session` | 15 Hz | Positions, lap times, fuel, flags, pit road status |

Pub/Sub channels: `session:yaml`, `session:events`, `voice:transcription`, `voice:audio`, `camera:command`.

Do not collapse the two streams into one. The rate distinction is load-bearing for the live processor's safe-window detection.

---

## Agent Architecture

Two agents in `src/agents/`:

**Racing Engineer** — voice co-pilot. Three-tier message queue (Tier 1 immediate/gate-override, Tier 2 safe-window-gated, Tier 3 LLM briefing). Safe window signal gates Tier 2+: lateral G < 0.4g AND throttle > 0.7 AND no brake in last 150m AND not in radio blackout zone.

**Stream Engineer** — autonomous OBS director. Three-tier shot queue (Tier 1 immediate, Tier 2 event-driven/force-after-30s, Tier 3 ambient). Cut window gates Tier 2+: min dwell elapsed AND no active overtake AND no unresolved incident AND subject not in blackout zone.

Both agents subscribe to the `EventBus`, which delivers events in-process AND publishes to `session:events` Redis channel.

Derived models (`FuelModelCalculator`, `TireModelCalculator`, `GapModelCalculator`) are **deterministic code**, not LLM reasoning. They are exposed to the LLM as callable tools, not embedded in prompts.

---

## Docker / Infra

The hub-server runs in Docker (`infra/docker-compose.yml`). Co-located services: Redis, PostgreSQL, Speaches (Whisper STT), Chatterbox TTS, OTel collector.

- Speaches endpoint: `http://speaches:8000` (Docker service name)
- Chatterbox endpoint: `http://chatterbox:8001` (Docker service name)
- All env vars documented in `.env.example` at repo root.

---

## Style Rules

- No comments unless the WHY is non-obvious (hidden constraint, subtle invariant, workaround for a specific bug).
- No multi-paragraph docstrings.
- No backwards-compatibility shims for removed code.
- Prefer editing existing files over creating new ones.
- Do not add error handling for scenarios that cannot happen. Only validate at system boundaries (user input, external API responses).
