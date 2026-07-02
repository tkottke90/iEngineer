# Feature Specification: Racing Engineer — LLM + Push-to-Talk

**Feature Branch**: `005-llm-push-to-talk`

**Created**: 2026-07-01

**Status**: Draft

**Input**: User description: "M5 — Racing Engineer: LLM + Push-to-Talk. Completes the voice loop. The engineer reasons, the driver can ask questions. Whisper STT (local, push-to-talk from Tauri mic), configurable PTT hotkey (hardware + Stream Deck passthrough), OpenAI-compatible LLM integration with tool calling for get_fuel_status()/get_tire_status(), context assembly with field truncation + token budget ceiling, Tier 3 LLM-synthesized messages (pit lane entry briefing, safety car briefing, on-demand driver queries, post-sector commentary), full personality system (Chattiness/Familiarity/Aggression) with POC validation findings, driver override tracking, adaptive deference, session memory, graceful degradation when LLM is unreachable."

## Clarifications

### Session 2026-07-02

- Q: What value scale should the personality dimensions use? → A: Five OCEAN-based personality traits, each on a 1–5 integer scale with every level anchored to a descriptive word (see Personality Config in Key Entities). The brief's three dimensions map onto traits — Chattiness→Energy, Familiarity→Warmth, Aggression→Assertiveness — and Openness + Conscientiousness are added. Energy at level 1 (Tranquil) is the suppression trigger that replaces M4's Chattiness=Low (suppresses Tier 2 and Tier 3 commentary).
- Q: For a pit recommendation, what closes the action window and marks it overridden? → A: The window is the recommended lap; an override is recorded when the car completes that lap (start/finish crossing) without a pit entry.
- Q: What is the deference threshold (count and scope)? → A: Default 2 overrides, counted per recommendation type (configurable); deference applies to that recommendation type.
- Q: How are concurrent PTT queries handled (press while one is in flight)? → A: Queue the new query and answer it after the in-flight one completes (FIFO, single in-flight query); a small configurable queue-depth cap bounds unbounded stacking, dropping excess presses with a structured log.
- Q: What should a PTT query do when the LLM is unreachable? → A: Speak a brief canned TTS acknowledgement (e.g., "reasoning engine unavailable"), no LLM required, plus a structured log entry.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — On-Demand Voice Query via Push-to-Talk (Priority: P1)

A driver is in a live race stint. They press and hold their configured push-to-talk (PTT) control and ask, "Do we pit this lap?" The engineer transcribes the spoken question, reasons over the current race state (fuel, tires, gaps, pit window), and speaks a synthesized briefing answer. The driver begins hearing the answer within 5 seconds of releasing the PTT control.

**Why this priority**: This is the headline capability of M5 and the primary deploy test — it closes the voice loop by letting the driver ask questions and receive reasoned answers. It exercises the entire new path (mic capture → local STT → context assembly → LLM with tool calling → TTS → audio playback) end to end and is independently valuable on its own.

**Independent Test**: With a live or simulated stint running, hold the PTT control, speak "Do we pit this lap?", and release. Confirm the engineer speaks a relevant, race-state-aware answer whose first audio is heard within 5 seconds of PTT release, and that the answer reflects actual current fuel and tire state.

**Acceptance Scenarios**:

1. **Given** a live session with the LLM reachable, **When** the driver holds PTT, asks "Do we pit this lap?", and releases, **Then** the engineer speaks a synthesized answer that references current fuel and tire status, with first audio heard within 5 seconds of PTT release.
2. **Given** the driver asks a fuel-related question, **When** the engineer reasons about the answer, **Then** it retrieves current fuel state through the `get_fuel_status()` capability rather than guessing, and the spoken answer is consistent with the retrieved values.
3. **Given** the driver asks a tire-related question, **When** the engineer reasons about the answer, **Then** it retrieves current tire state through the `get_tire_status()` capability and the spoken answer is consistent with the retrieved values.
4. **Given** the driver holds PTT but says nothing (silence) and releases, **When** transcription yields empty or non-speech text, **Then** the engineer does not synthesize an answer and emits a structured log entry (reason: "empty-transcription") instead of speaking a spurious response.
5. **Given** the driver releases PTT mid-sentence, **When** transcription completes on the captured audio, **Then** the engineer answers based on whatever was captured (no partial-audio crash).

---

### User Story 2 — Proactive Tier 3 Briefings (Priority: P2)

During a race, certain moments warrant a richer, reasoned spoken briefing rather than a canned Tier 1/2 alert. When the driver enters the pit lane, the engineer delivers a pit lane entry briefing. When a safety car is deployed, the engineer delivers a situation briefing. After a sector or lap, the engineer may offer short post-sector commentary. Each of these is synthesized by the LLM from the current race state.

**Why this priority**: Proactive Tier 3 briefings are the second half of the "engineer reasons" theme — the engineer volunteers reasoned context at high-value moments, not only when asked. They reuse the same synthesis path as US1 and demonstrate the engineer's judgment.

**Independent Test**: Simulate a pit lane entry event and, separately, a safety car deployment. Confirm the engineer speaks a distinct, context-appropriate synthesized briefing for each within its delivery budget, and that post-sector commentary respects the Energy trait setting.

**Acceptance Scenarios**:

1. **Given** the driver enters the pit lane, **When** the pit-entry trigger fires and the LLM is reachable, **Then** the engineer speaks a synthesized pit lane entry briefing appropriate to the current strategy (e.g., what to expect this stop).
2. **Given** a safety car is deployed, **When** the safety-car trigger fires, **Then** the engineer speaks a synthesized safety car briefing (e.g., implications for the driver's position and strategy) — while the immediate Tier 1 safety car alert (M4) still fires without waiting on the LLM.
3. **Given** Energy is set to level 1 (Tranquil), **When** a post-sector commentary trigger fires, **Then** no post-sector commentary is synthesized or spoken (Tier 3 commentary is suppressed at Energy level 1).
4. **Given** two Tier 3 triggers fire close together, **When** they are queued, **Then** they are delivered through the existing priority message queue without interrupting any in-progress clip and behind any pending Tier 1 alerts.

---

### User Story 3 — Personality Shapes the Engineer's Voice (Priority: P2)

A driver configures the engineer's personality across five OCEAN-based traits — Openness, Warmth, Energy, Conscientiousness, and Assertiveness — each set on a 1–5 scale anchored to a descriptive word (see Personality Config in Key Entities). The engineer's synthesized speech reflects those settings: a reserved, tranquil, deferential engineer sounds different from a nurturing, exuberant, commanding one, even for the same underlying race state.

**Why this priority**: Personality is what makes the engineer feel like a crew member rather than a status readout. All five traits are behaviorally active in M5 (the M4 brief's Chattiness/Familiarity/Aggression map onto Energy/Warmth/Assertiveness; Openness and Conscientiousness are new), shaping both whether the engineer speaks and how.

**Independent Test**: Hold four traits and race state constant, vary the fifth across its 1–5 range, and confirm the synthesized output changes in that trait's intended direction across a representative set of prompts.

**Acceptance Scenarios**:

1. **Given** two different Energy levels and identical race state, **When** the same Tier 3 trigger fires, **Then** the higher-Energy output is more verbose / more frequent than the lower-Energy output, and Energy at level 1 (Tranquil) suppresses Tier 2 and Tier 3 commentary (replacing M4's Chattiness=Low behavior).
2. **Given** two different Warmth levels, **When** the engineer speaks, **Then** the higher-Warmth output uses a more nurturing/empathetic register and form of address than the lower-Warmth (detached/reserved) output.
3. **Given** two different Assertiveness levels and an identical strategic decision point, **When** the engineer makes a recommendation, **Then** the higher-Assertiveness output advocates a more commanding/risk-tolerant option than the lower-Assertiveness (deferential) output.
4. **Given** two different Openness or Conscientiousness levels, **When** the engineer reasons and speaks, **Then** Openness shifts framing from conventional to visionary and Conscientiousness shifts it from spontaneous to meticulous, in the trait's intended direction.
5. **Given** the personality configuration is loaded, **When** the engineer's system prompt is constructed, **Then** all five traits (with their word-anchored levels) are represented in the prompt sent to the LLM, and the prompt is sourced from a version-controlled prompt file (not an inline string).

---

### User Story 4 — Driver Override Tracking (Priority: P2)

The engineer recommends a pit stop this lap. The driver chooses not to pit — the recommendation window passes with no action. The engineer detects that the driver overrode the recommendation, stops repeating that recommendation, and pivots to supporting the driver's actual decision (e.g., re-planning around staying out).

**Why this priority**: An engineer that keeps repeating a recommendation the driver has already declined is annoying and erodes trust. Detecting the override and pivoting is core to the engineer feeling like it listens to the driver.

**Independent Test**: Trigger a pit recommendation, then simulate the recommendation window passing without the driver acting on it. Confirm the engineer records an override, stops advocating that recommendation, and any subsequent related speech reflects the driver's decision rather than re-advocating.

**Acceptance Scenarios**:

1. **Given** the engineer made a pit recommendation, **When** the recommendation's action window passes with no corresponding driver action, **Then** the engineer records an override outcome and does not re-issue the same recommendation on subsequent laps within the same window context.
2. **Given** an override has been recorded, **When** the engineer next speaks about strategy, **Then** its framing acknowledges the driver stayed out / declined and supports that path rather than re-advocating the overridden action.
3. **Given** the driver acts on a recommendation within the window (e.g., pits when advised), **When** the window closes, **Then** the outcome is recorded as followed (not an override) and no deference shift is triggered.

---

### User Story 5 — Adaptive Deference After Repeated Overrides (Priority: P3)

Over a session, a driver repeatedly overrides the engineer's recommendations. The engineer adapts: instead of continuing to make assertive recommendations, it shifts toward presenting information and letting the driver decide, reducing unsolicited advocacy.

**Why this priority**: This is a refinement on override tracking (US4) that makes the engineer feel adaptive over a whole session. It is valuable but depends on override tracking existing first, so it is lower priority.

**Independent Test**: Simulate the driver overriding recommendations repeatedly within a session up to the configured threshold. Confirm the engineer's subsequent behavior shifts measurably from recommendation-framing to information-presentation framing.

**Acceptance Scenarios**:

1. **Given** the driver has overridden recommendations up to the configured deference threshold within a session, **When** the engineer next faces a comparable decision point, **Then** its output presents the relevant information without a directive recommendation (information mode).
2. **Given** the engineer has shifted to information mode, **When** the driver explicitly asks for a recommendation via PTT (US1), **Then** the engineer still gives a direct recommendation on request (deference suppresses unsolicited advocacy, not answers to direct questions).
3. **Given** a new session starts, **When** the engineer initializes, **Then** the deference state resets and the engineer begins in its normal recommendation mode.

---

### User Story 6 — Session Memory Informs Reasoning (Priority: P3)

The engineer remembers what has happened this session — the recommendations it made, whether the driver followed or overrode them, and updates to the fuel model calibration — and it uses that memory when reasoning about new questions and briefings.

**Why this priority**: Session memory is what lets the engineer's answers stay consistent with what it already said and observed. It improves answer quality across US1 and US2 but is not required for the basic loop, so it is lower priority.

**Independent Test**: Make a recommendation, record its override outcome, then ask a related PTT question later in the same session. Confirm the engineer's answer references the earlier recommendation/outcome, demonstrating the memory was included in its reasoning context.

**Acceptance Scenarios**:

1. **Given** the engineer made and logged a recommendation earlier in the session, **When** the driver later asks a related question via PTT, **Then** the assembled reasoning context includes the recommendation log and the answer is consistent with it.
2. **Given** the fuel model calibration was updated during the stint, **When** the engineer next reasons about fuel, **Then** the latest calibration is reflected in the reasoning context.
3. **Given** the reasoning context would exceed the configured token budget ceiling, **When** context is assembled, **Then** older/lower-priority memory is truncated per the field truncation rules so the ceiling is not exceeded, and a structured log entry records that truncation occurred.

---

### User Story 7 — Graceful Degradation When the LLM Is Unreachable (Priority: P1)

The LLM endpoint becomes unreachable mid-session (network drop, service down, timeout). The engineer stops producing Tier 3 messages but keeps delivering Tier 1 and Tier 2 rule-based alerts exactly as before. When a driver presses PTT during an outage, they are told the reasoning engine is unavailable rather than hearing silence with no explanation.

**Why this priority**: Per the project's real-time reliability principle, an LLM failure must never degrade the safety-critical rule-based alert path. This is a P1 reliability guarantee that gates the whole feature — Tier 3 is additive and must fail closed without collateral damage.

**Independent Test**: With the LLM endpoint made unreachable, run a stint. Confirm Tier 1/2 alerts still fire correctly, Tier 3 briefings are skipped with structured logs, and a PTT query yields a brief spoken "reasoning unavailable" acknowledgement rather than a hang or crash.

**Acceptance Scenarios**:

1. **Given** the LLM is unreachable, **When** a Tier 3 trigger fires, **Then** no Tier 3 message is produced, the trigger is skipped, and a structured log entry records the skip with reason and timestamp.
2. **Given** the LLM is unreachable, **When** any Tier 1 or Tier 2 condition occurs, **Then** the corresponding rule-based alert is delivered exactly as in M4, unaffected by the LLM outage.
3. **Given** the LLM is unreachable, **When** the driver presses PTT and asks a question, **Then** the engineer speaks a brief canned acknowledgement that the reasoning engine is unavailable (no LLM required), emits a structured log entry, and does not hang past the configured timeout.
4. **Given** the LLM becomes reachable again, **When** the next Tier 3 trigger or PTT query occurs, **Then** synthesized messages resume automatically without a restart.

---

### Edge Cases

- **STT service/model unavailable**: If local transcription fails to initialize or errors on a clip, the PTT query is dropped with a structured log (reason: "stt-failure"); no LLM call is made; Tier 1/2 alerts are unaffected.
- **Empty or non-speech transcription**: Silence, background noise, or an empty transcript does not trigger an LLM call (see US1 AC4).
- **PTT pressed while a clip is playing**: The captured query is transcribed and answered; the answer queues per the existing no-interrupt priority rules (it never cuts off the current clip).
- **PTT pressed while a previous PTT query is still being processed**: The new query is queued and answered FIFO after the in-flight one completes (a single query is in flight at a time, so rapid re-presses never spawn concurrent LLM calls). A small configurable queue-depth cap bounds stacking; presses beyond the cap are dropped with a structured log (a query is never silently lost without a log).
- **LLM returns a tool call for a capability that has no data yet** (e.g., tire status before the first flying lap): The tool returns a well-formed "not yet available" result and the engineer's answer reflects that gap rather than inventing data.
- **LLM response exceeds a sane length / never terminates**: A response length/time ceiling truncates or aborts the synthesis; the partial-but-safe result (or a fallback) is spoken or the message is dropped with a log — never an unbounded stream.
- **Context assembly would exceed the token budget ceiling**: Field truncation rules apply deterministically (see US6 AC3) so the LLM request stays within budget.
- **Sentence-boundary false positives** (POC-0003 finding): The streaming splitter must not dispatch fragments split on decimals/abbreviations (e.g., "You are 2." from "2.4 seconds") to TTS — a hardened boundary rule is required so spoken briefings are not fragmented.
- **Configured PTT control conflicts with an in-sim binding**: The client documents/handles the conflict; a hardware or Stream Deck passthrough that maps to the PTT still activates capture without requiring focus on the client window.
- **Stream Deck / hardware passthrough sends the PTT signal while the client is unfocused**: Capture still begins (global hotkey / passthrough), because racing happens with focus on the sim, not the client.
- **LLM produces unsafe / out-of-contract advice** (e.g., instructing an automatic action): The engineer only ever surfaces spoken advice; no synthesized message can trigger an automatic car/strategy action (advise-only guarantee).

## Requirements *(mandatory)*

### Functional Requirements

#### Speech-to-Text & Push-to-Talk

- **FR-001**: The Tauri client MUST capture microphone audio while the configured PTT control is held and stop capture on release, then transcribe the captured audio locally (no cloud STT, no network upload of audio).
- **FR-002**: Local transcription MUST run in the Tauri client using the STT engine and model validated in POC-0002 (Whisper `base.en` as the production default, with a smaller model as a documented fallback), producing text from the captured clip.
- **FR-003**: The PTT control MUST be a configurable hotkey in the Tauri client, and MUST also activate from a hardware key and from a Stream Deck passthrough, including when the client window does not have OS focus.
- **FR-004**: An empty, silence-only, or non-speech transcription MUST NOT trigger an LLM request. Non-speech is detected as any of: an empty or whitespace-only transcript, a Whisper no-speech/blank marker (e.g., `[BLANK_AUDIO]`), or output below a minimal character/word threshold. On such a result the system MUST emit a structured log entry (reason: "empty-transcription") and produce no spoken response.
- **FR-005**: On STT initialization or transcription failure, the PTT query MUST be dropped with a structured log entry (reason: "stt-failure"); no LLM request is made and the rule-based alert path is unaffected.

#### LLM Integration & Tool Calling

- **FR-006**: The engineer MUST reason over race state using an OpenAI-compatible LLM endpoint that remains runtime-switchable (no hard-coded provider), consistent with the local-first / switchable-provider principle.
- **FR-007**: The LLM integration MUST support tool calling and MUST expose at least `get_fuel_status()` and `get_tire_status()` as callable tools that return current values from live race state; the engineer MUST use these tools rather than fabricating fuel/tire values.
- **FR-008**: Each tool MUST return a well-formed result even when the underlying data is not yet available (e.g., before the first flying lap), so the engineer can state the gap rather than invent data.
- **FR-009**: LLM requests MUST enforce a response ceiling (maximum length and/or maximum time); a response that exceeds the ceiling MUST be truncated or aborted safely, never streamed unbounded.
- **FR-010**: The LLM→TTS path MUST use the streaming per-sentence synthesis architecture validated in POC-0003 (begin TTS on the first complete sentence), with a hardened sentence-boundary rule that does NOT dispatch fragments split on decimals or abbreviations to TTS.

#### Context Assembly

- **FR-011**: The engineer MUST assemble a structured race-state summary as LLM context, including current telemetry-derived state (fuel, tires, gaps, position, session/flag state) and relevant session memory (FR-018).
- **FR-012**: Context assembly MUST enforce a token budget ceiling; when the assembled context would exceed the ceiling, deterministic field truncation rules MUST reduce it below the ceiling following the fixed field-priority order defined in data-model.md (dropping/summarizing lowest-priority, oldest content first; NEVER dropping the current fuel/tire summary, position, session/flag state, or the driver's question), and a structured log entry MUST record that truncation occurred.
- **FR-013**: All LLM system prompts and decision prompts MUST live in version-controlled prompt files (under `apps/*/prompts/` or `packages/*/prompts/`), each with a header documenting purpose and expected input/output schema; no inline prompt strings in business logic. System prompt construction MUST realize the five-trait OCEAN personality model defined in Personality Config (Key Entities) and MUST be validated by evaluations — not unit tests alone — per Constitution VI. (No standalone personality-validation POC exists; the OCEAN model and its evals are the source of validated behavior.)

#### Tier 3 Messages

- **FR-014**: The engineer MUST produce Tier 3 (LLM-synthesized) messages for: on-demand PTT driver queries, pit lane entry briefing, safety car briefing, and post-sector commentary.
- **FR-015**: Tier 3 messages MUST flow through the existing priority message queue and no-interrupt rules from M4 — they never interrupt an in-progress clip and always queue behind pending Tier 1 alerts.
- **FR-016**: The safety car and other Tier 1 rule-based alerts MUST still fire immediately from the rule engine without waiting on the LLM; the Tier 3 safety car briefing is additive and delivered after (never in place of) the immediate Tier 1 alert.

#### Personality System

- **FR-017**: All five OCEAN-based personality traits — Openness, Warmth, Energy, Conscientiousness, Assertiveness — MUST be behaviorally active on a 1–5 word-anchored scale (see Personality Config in Key Entities) and MUST shape the constructed system prompt and resulting output. Specifically: Energy MUST affect verbosity/frequency and, at level 1 (Tranquil), MUST suppress Tier 2 alerts (replacing M4's Chattiness=Low behavior) and Tier 3 commentary; Warmth MUST affect register / form of address; Assertiveness MUST affect strategic assertiveness of recommendations; Openness MUST affect conventional-vs-visionary framing; Conscientiousness MUST affect spontaneous-vs-meticulous framing.

#### Session Memory, Override Tracking & Adaptive Deference

- **FR-018**: The engineer MUST maintain session memory containing at least: a recommendation log, override outcomes (followed vs. overridden), and fuel model calibration updates; this memory MUST be available to context assembly (FR-011).
- **FR-019**: The engineer MUST detect a driver override — a recommendation whose action window passes with no corresponding driver action — and record the outcome; after an override it MUST stop re-issuing that recommendation within the same window context and MUST frame subsequent related speech around the driver's actual decision. For a pit recommendation, the action window is the recommended lap; the override MUST be recorded when the car completes that lap (start/finish line crossing) without a pit entry.
- **FR-020**: When a recommendation is acted upon within its window, the engineer MUST record the outcome as followed and MUST NOT count it toward deference.
- **FR-021**: After overrides for a given recommendation type reach a configurable threshold within a session (default: 2, counted per recommendation type), the engineer MUST shift that recommendation type to information presentation (deference mode); deference applies per type (overrides of one type do not silence another). A direct PTT request MUST still receive a direct recommendation, and deference state MUST reset at the start of a new session.

#### Auditability & Degradation

- **FR-022**: Every LLM interaction (prompt, response, latency, and outcome) MUST be persisted to a Postgres audit log before the engineer acts on it, satisfying the constitution's M5 requirement to add an `engineer_events` audit table for the LLM-backed engineer path.
- **FR-023**: If the LLM endpoint is unreachable or times out, Tier 3 messages (including PTT answers) MUST be skipped / failed gracefully with a structured log entry (reason and timestamp), while Tier 1 and Tier 2 rule-based alerts continue unaffected; a PTT query during an outage MUST yield a brief canned spoken "reasoning engine unavailable" acknowledgement (produced without an LLM call) plus a structured log entry, and MUST NOT hang past the configured timeout.
- **FR-024**: When the LLM endpoint recovers, Tier 3 synthesis and PTT answers MUST resume automatically without a service restart.
- **FR-025**: The engineer MUST NOT take any automatic car or strategy action from a synthesized message; every Tier 3 output is advice surfaced to the driver only (advise-only guarantee). This is guaranteed by construction: there is no code path from a synthesized message to a car/strategy action — Tier 3 output flows only to TTS/audio — so the prompt-level advise-only rule (FR-013 system prompt) has no action surface to guard.

### Key Entities

- **PTT Query**: A driver-initiated spoken request captured during a PTT hold — audio clip → transcript → assembled context → synthesized answer. Attributes: capture start/end, transcript text, timestamp, resulting message reference (or drop reason).
- **Tier 3 Message**: An LLM-synthesized spoken message. Attributes: type (pit-entry | safety-car | driver-query | post-sector-commentary), trigger source, synthesized text, personality snapshot, delivery/queue outcome.
- **Reasoning Context**: The structured race-state summary sent to the LLM. Attributes: telemetry-derived fields, session-memory excerpt, token budget used, truncation flags.
- **LLM Tool**: A callable capability exposed to the LLM (`get_fuel_status`, `get_tire_status`, extensible). Attributes: name, input schema, output schema, availability state.
- **Personality Config**: Driver-scoped settings, now fully active. Five OCEAN-based traits, each an integer `1–5` with every level anchored to a descriptive word, each mapped to prompt-construction effects:
  - `openness`: 1 Conventional · 2 Cautious · 3 Balanced · 4 Inquisitive · 5 Visionary
  - `warmth`: 1 Detached · 2 Reserved · 3 Cordial · 4 Empathetic · 5 Nurturing *(brief's "Familiarity")*
  - `energy`: 1 Tranquil · 2 Measured · 3 Steady · 4 Animated · 5 Exuberant *(brief's "Chattiness"; level 1 suppresses Tier 2/Tier 3 commentary)*
  - `conscientiousness`: 1 Spontaneous · 2 Flexible · 3 Organized · 4 Methodical · 5 Meticulous
  - `assertiveness`: 1 Deferential · 2 Accommodating · 3 Diplomatic · 4 Confident · 5 Commanding *(brief's "Aggression")*
- **Recommendation Log Entry**: A recommendation the engineer made and its outcome. Attributes: recommendation type, issued-at, action window (for a pit recommendation, the recommended lap), outcome (followed | overridden | pending). A pit recommendation transitions `pending → overridden` when the car completes the recommended lap (start/finish crossing) without a pit entry, or `pending → followed` when a pit entry occurs within the window.
- **Session Memory**: The per-session record consumed by context assembly — recommendation log, override outcomes, fuel-calibration updates, deference state.
- **Engineer Event (audit)**: A persisted record of one LLM interaction. Attributes: prompt, response, latency, tools called, outcome, timestamp — stored in the `engineer_events` Postgres table.
- **PTT Binding**: The configured activation control(s) — hotkey plus hardware / Stream Deck passthrough — including global (unfocused) activation behavior.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For an on-demand PTT query in a live/simulated stint with the LLM reachable, the driver hears the first audio of the synthesized answer within 5 seconds of releasing the PTT control (p95), and the answer is consistent with the current fuel and tire state.
- **SC-002**: In a fuel- or tire-specific query, the spoken answer's fuel/tire figures match the values returned by the corresponding tool in 100% of trials (no fabricated figures).
- **SC-003**: With the LLM endpoint unreachable, 100% of Tier 1 and Tier 2 alerts in a full-stint simulation are delivered exactly as in M4 (zero regressions attributable to the LLM outage), and 100% of Tier 3 triggers are skipped with a structured log.
- **SC-004**: Empty / silence PTT captures produce zero spurious spoken responses across a test set of silent and non-speech captures.
- **SC-005**: Varying each of the five personality traits across its 1–5 range, with the other four traits and race state held constant, produces output that moves in that trait's intended direction (Energy → length/frequency; Warmth → register; Assertiveness → assertiveness; Openness → conventional-to-visionary framing; Conscientiousness → spontaneous-to-meticulous framing) in a representative evaluation set.
- **SC-006**: After a driver overrides a recommendation, the engineer does not re-issue that same recommendation within the same window context (0 repeats) in a full-stint simulation, and subsequent related speech reflects the driver's decision.
- **SC-007**: After overrides reach the configured deference threshold within a session, the engineer's next comparable unsolicited output is in information mode (no directive recommendation), while a direct PTT request in the same state still returns a direct recommendation.
- **SC-008**: 100% of LLM interactions during a session are persisted to the `engineer_events` audit log with prompt, response, and latency, before any action is taken on them.
- **SC-009**: Assembled reasoning context never exceeds the configured token budget ceiling across a full-stint simulation; when truncation is applied, it is recorded in a structured log.
- **SC-010**: In the live deploy test, the driver asks "Do we pit this lap?" verbally and receives a synthesized briefing under 5 seconds, then overrides a pit recommendation and confirms the engineer stops repeating it.

## Assumptions

- **POCs in hand**: POC-0002 (local STT: Whisper `base.en` ~60ms GPU / ~345ms CPU, runs in the Tauri client via `whisper-rs`, Vulkan on the racing PC) and POC-0003 (streaming LLM→TTS halves latency to ~4.3s combined; remote LLM TTFT ~2.7s is the practical floor; keep TTS input to one short sentence; harden the sentence splitter) are the validated basis for M5. POC-0004 (local LLM inference to cut TTFT) has NOT run, so M5 targets the achievable ~5-second budget with the streaming OpenAI-compatible endpoint rather than the aspirational 500ms.
- **Tier 3 latency budget is distinct from Tier 1/2**: The constitution's 3-second voice budget applies to the reactive rule-based path (Tier 1/2), which is unchanged. Tier 3 messages inherently include LLM reasoning in-path, so their budget is ≤5 seconds (time to first audio), justified by the POC-0003 measurements. This distinction is surfaced for the plan's Constitution Check.
- **STT runs in the Tauri client (racing PC)**, in-process, with no network hop, per the POC-0002 decision.
- **The OpenAI-compatible endpoint used for M5 is the existing homelab LLM** (Lemonade-hosted), kept runtime-switchable per the constitution; the Claude API remains a switchable alternative. No provider is hard-coded.
- **The M4 priority message queue, Radio Blackout Zone gating, dedup tracker, TTS/AudioClip delivery, and Chattiness=Low suppression are all operational** and are reused; M5 adds Tier 3 on top rather than replacing them.
- **The M3 race-state engine and fuel model provide the live values** consumed by `get_fuel_status()` / `get_tire_status()` and by context assembly; the engineer performs no fuel math of its own (fuel calibration originates in the M3 model; M5 reads it into session memory).
- **"Recommendation window"** for override detection is defined per recommendation type as the actionable window during which the driver could act. For a pit recommendation the window is the recommended lap, and an override is recorded when the car completes that lap (start/finish crossing) without a pit entry (see FR-019). Windows for any additional recommendation types are a planning detail following the same "window closes without the corresponding telemetry action" pattern.
- **Recommendation types in M5**: pit is the only recommendation type M5 tracks for override detection and deference. Per-type deference (FR-021) is therefore effectively single-type in M5; the per-type design is forward-looking for recommendation types added in later milestones.
- **Deference threshold** is configurable, defaulting to 2 overrides counted per recommendation type within a session; deference applies to the type that reached the threshold and resets each session.
- **Token budget ceiling** and per-field truncation priorities are configurable; the ceiling is chosen to stay comfortably within the chosen model's context window while leaving room for the response.
- **Session memory scope** is per-session for reasoning; the LLM audit trail (`engineer_events`) is persisted to Postgres. Cross-session long-term memory is out of scope for M5.
- **Post-sector commentary cadence** is bounded (not every sector) and governed by the Energy trait so it does not become spammy; Energy level 1 (Tranquil) suppresses it entirely.
- **Personality model**: M5 adopts a five-trait OCEAN-based model (Openness, Warmth, Energy, Conscientiousness, Assertiveness) on a 1–5 word-anchored scale. This supersedes the M4 `chattiness: Low|Default` field; the M4 suppression behavior is preserved via Energy level 1. Trait effects other than Energy's suppression threshold are prompt-shaping (no hard behavioral gates), validated by evaluations per the constitution.
- **PTT binding** may extend the existing Tauri settings PTT field from M4; global (unfocused) activation and Stream Deck passthrough are the new M5 additions.
- **Prompt files and personality prompt construction** are version-controlled and treated as behavioral changes requiring evaluations (not unit tests alone), per the constitution.
