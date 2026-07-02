# Contract: Personality → System Prompt Construction

## Prompt files (source-controlled, `apps/hub-server/prompts/`)
Each file begins with a header comment: **purpose**, **expected input schema**, **expected output schema** (Constitution III).

- `system-base.md` — engineer persona, safety/advise-only rules (never instruct automatic actions), brevity guidance, tool-use guidance.
- `personality.md` — the 5-trait construction fragment (below), composed into the system prompt.
- `tier3-driver-query.md`, `tier3-pit-entry.md`, `tier3-safety-car.md`, `tier3-post-sector.md` — per-type task framing.

No inline prompt strings in business logic — `tier3-synthesizer.ts` loads and composes files.

## Trait → instruction mapping (`personality.md`)
Each trait level (1–5) maps to a word-anchored instruction fragment. All five are always represented in the constructed prompt (FR-017, SC-005).

| Trait | 1 | 2 | 3 | 4 | 5 |
|-------|---|---|---|---|---|
| `openness` | Conventional | Cautious | Balanced | Inquisitive | Visionary |
| `warmth` | Detached | Reserved | Cordial | Empathetic | Nurturing |
| `energy` | Tranquil | Measured | Steady | Animated | Exuberant |
| `conscientiousness` | Spontaneous | Flexible | Organized | Methodical | Meticulous |
| `assertiveness` | Deferential | Accommodating | Diplomatic | Confident | Commanding |

- **Energy** also governs verbosity/frequency; **level 1 (Tranquil)** is a hard gate that suppresses Tier 2 alerts and Tier 3 commentary (supersedes M4 `chattiness==='Low'`).
- **Warmth** → register / form of address. **Assertiveness** → how directive/risk-tolerant recommendations are. **Openness** → conventional↔visionary framing. **Conscientiousness** → spontaneous↔meticulous detail.
- Non-Energy effects are prompt-shaping only (no hard behavioral gates).

## Evaluation requirement (Constitution VI)
Prompt/personality changes require **evaluations**, not unit tests alone: hold four traits + race state constant, vary the fifth 1→5, assert output moves in the trait's intended direction across a representative prompt set (SC-005).

## Source of values
- Runtime: Redis KV `hub:config:personality` (written by Tauri `PersonalityPanel`).
- Default: `engineer-config.json` `personality` (all traits = 3). Absent/malformed ⇒ defaults + warning log.
