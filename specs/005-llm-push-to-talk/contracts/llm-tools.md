# Contract: LLM Tools (function calling)

Tools are exposed to the LLM via the OpenAI-compatible `tools` param. Implementations read the hub's injected `getRaceState()` snapshot — the same source the rule engine uses (no duplicated fuel/tire math). The engineer MUST call these rather than fabricate values. (FR-007, SC-002)

## `get_fuel_status`
- **Parameters**: none (`{}`).
- **Returns** (`LlmToolResult`):
```json
{ "available": true, "data": { "lapsRemaining": 3.2, "levelLiters": 18.4, "burnRatePerLap": 2.6, "criticalThresholdLaps": 1.0 } }
```
- Values sourced from `FuelModelEngine` / hero state via `getRaceState()`. `lapsRemaining` is the M3-computed value (mirrors M4 FR-014).
- **Not available**: before a valid fuel model exists ⇒ `{ "available": false, "reason": "fuel model not yet calibrated" }`. (FR-008)

## `get_tire_status`
- **Parameters**: none (`{}`).
- **Returns** (`LlmToolResult`):
```json
{ "available": true, "data": { "wearPct": {"LF":0.12,"RF":0.15,"LR":0.10,"RR":0.14}, "tempsC": {"LF":88,"RF":91,"LR":85,"RR":89}, "stintLaps": 7 } }
```
- Values sourced from `TireModelEngine` / hero state via `getRaceState()`.
- **Not available**: before the first flying lap ⇒ `{ "available": false, "reason": "no flying lap yet" }`. (FR-008, edge case)

## Tool-call loop
- `llm-client.ts` runs the standard loop: stream → if a tool call is requested, execute the tool, append the result, continue → until a final assistant message.
- Tool names, params executed, and count are recorded in the `EngineerEvent.toolsCalled` audit field.
- A tool call for an unknown/unavailable capability returns a well-formed `available:false` result so the model can state the gap (never invents data).
- Extensibility: tools are registered in a small map; adding a tool = one entry + one impl (kept minimal per YAGNI — only fuel/tire in M5).
