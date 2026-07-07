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

## Evaluation harness (Constitution VI)
Prompt/personality changes require **evaluations**, not unit tests alone. Evals run as a **separate `npm run eval`** command — **excluded** from `npm test` / the CI gate (the local LLM is not available in CI).

**Target + judge model**: Lemonade Server `https://lemonade.tdkottke.com/v1`, model `user.Ornith-1.0-35B-GGUF`, **temperature 0**. The same endpoint/model serves both the engineer-under-test and the LLM judge. Eval config is separate from runtime `engineer-config.json` so the two can diverge.

**Method — hybrid**:
- **Deterministic proxy metrics** (in-process, no model call) where a trait has one: `energy` → response length / word count; `assertiveness` → count of imperatives / directive modal verbs.
- **LLM-as-judge, pairwise** for the semantic traits (`warmth`, `openness`, `conscientiousness`; also a cross-check on energy/assertiveness): show the judge replies A and B (from level 1 and level 5, same scenario) and ask "Which is more {trait word — e.g. *nurturing*}?" — a relative choice, not absolute scoring, at temp 0.

**Scenarios**: a fixed set of **5** race situations authored in the harness — pit decision, safety-car briefing, fuel query, tire query, post-lap commentary — with race state held constant across each trait sweep.

**Pass bar (per trait)**:
- Compare **level 1 vs level 5** across the 5 scenarios; the direction (proxy metric and/or judge choice) MUST hold in **≥ 4 of 5** scenarios.
- Each comparison runs a few samples; take the **majority**.
- Full 1<2<3<4<5 monotonicity is NOT required (too strict for an LLM) — pairwise 1-vs-5 with the 4/5 margin is the bar.

**Hard deterministic assertion** (gate, not direction): `energy === 1` (Tranquil) MUST produce **no** Tier 3 commentary — asserted without the judge.

## Source of values
- Runtime: Redis KV `hub:config:personality` (written by Tauri `PersonalityPanel`).
- Default: `engineer-config.json` `personality` (all traits = 3). Absent/malformed ⇒ defaults + warning log.
