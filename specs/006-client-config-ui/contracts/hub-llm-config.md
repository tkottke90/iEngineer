# Contract: hub:config:llm — LLM Runtime Config (Redis KV)

**Purpose**: Define the Redis key written by Tauri on config save and read by the hub LLM client at request time. Enables runtime LLM model/endpoint changes without hub restart.

---

## Redis Key

```
hub:config:llm
```

**Type**: String (JSON-encoded)

**Written by**: Tauri `save_config()` command whenever `llm_base_url` or `llm_model` changes.

**Read by**: Hub `llm-client.ts` at the start of each LLM synthesis request (per-request read; no caching).

---

## Schema

```json
{
  "baseUrl": "https://lemonade.tdkottke.com/v1",
  "model": "user.Ornith-1.0-35B-GGUF"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `baseUrl` | string | OpenAI-compatible API base URL |
| `model` | string | Model identifier passed in the `model` field of each completion request |

**`apiKey` is intentionally absent** from this Redis key. The API key stays in the Tauri client's local AppConfig and is not written to Redis (Redis is not a secure credential store). If an API key is needed for the configured endpoint, it is out of scope for M10 — the current Lemonade endpoint is unauthenticated. A future milestone will add secure key passing (e.g., via hub environment config or Tauri stronghold).

---

## Absent Key Behavior (Hub)

If `hub:config:llm` does not exist in Redis:
1. Hub reads `llm.baseUrl` and `llm.model` from `apps/hub-server/config/engineer-config.json`.
2. Emits one `warn` structured log: `{ event: "llm-config-fallback", reason: "hub:config:llm absent" }`.
3. Proceeds with defaults — no error, no crash.

If the key exists but is malformed JSON:
1. Hub falls back to `engineer-config.json` defaults.
2. Emits one `warn` structured log: `{ event: "llm-config-malformed", raw: <first 200 chars> }`.

---

## Update Timing

The hub reads this key **per request** (at the top of `tier3-synthesizer.ts` before each LLM call). There is no subscription or watch — the next Tier 3 message after a config save will use the new values. This satisfies SC-002 (no restart required).

---

## Write Contract (Tauri Side)

```rust
// Written inside save_config() Tauri command
let llm_config = serde_json::json!({
    "baseUrl": config.llm_base_url,
    "model": config.llm_model,
    // apiKey intentionally excluded
});
redis_client.set("hub:config:llm", llm_config.to_string()).await?;
```

Written in the same async task that writes `hub:config:personality` — both are best-effort (hub sync failure does not fail the local save).
