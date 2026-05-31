# SchemaFirewall

**Runtime schema enforcement for LLM pipelines — drop-in OpenAI-compatible HTTP proxy.**

No code changes. One env var. Works with every OpenAI-compatible client.

---

## The problem

You tell an LLM to return JSON. It almost does. Then:

- `"quantity": "3"` instead of `3` — your downstream code crashes
- Missing required field — silent `KeyError` three steps later  
- Markdown-fenced response — `JSON.parse` throws
- You upgrade models — output structure shifts slightly — nothing breaks visibly, everything silently corrupts

Existing tools (Instructor, Marvin, Outlines) make you wrap every LLM call in their library. You have to import them, use their patterns, and handle failures yourself in your code.

**SchemaFirewall is infrastructure, not a library.** It sits between your app and the LLM. Your code doesn't change.

---

## How it works

```
Your app ──► http://localhost:8080/v1/chat/completions ──► api.openai.com
                              │
                    SchemaFirewall proxy
                              │
                    1. Forward request upstream
                    2. Receive LLM response
                    3. Strip markdown fences, parse JSON
                    4. Validate against your schema
                    5. Coerce safe type mismatches (str→int, etc.)
                    6. If invalid: retry LLM with errors injected
                    7. Return clean, validated response
                    8. Log every event to ~/.schema-firewall/proxy.jsonl
```

Response headers tell you exactly what happened:

```
X-Schema-Firewall-Status:  coerced        # ok | coerced | retried | failed
X-Schema-Firewall-Schema:  Order
X-Schema-Firewall-Retries: 0
X-Schema-Firewall-Errors:  quantity: expected integer, got string  (only on failure)
```

---

## Quickstart

**1. Start the proxy**

```bash
node src/server.js --port 8080 --schemas-dir ./schemas
```

```
[schema-firewall] proxy listening on http://localhost:8080
[schema-firewall] upstream: https://api.openai.com
[schema-firewall] mode: coerce | max-retries: 2
[schema-firewall] set OPENAI_BASE_URL=http://localhost:8080/v1 in your app
```

**2. Point your app at the proxy**

```bash
export OPENAI_BASE_URL=http://localhost:8080/v1
```

That's it. Your app continues working exactly as before — every request is forwarded to `api.openai.com`. Enforcement only activates when you tag a request with a schema.

**3. Register a schema**

Drop a JSON Schema file in `./schemas/`:

```json
// schemas/Order.json
{
  "$id": "Order",
  "type": "object",
  "properties": {
    "item":        { "type": "string" },
    "quantity":    { "type": "integer" },
    "price_cents": { "type": "integer" },
    "notes":       { "type": "string" }
  },
  "required": ["item", "quantity", "price_cents"],
  "additionalProperties": false
}
```

Or register at runtime:

```bash
curl -X POST http://localhost:8080/schemas/Order \
  -H "Content-Type: application/json" \
  -d @schemas/Order.json
```

**4. Tag your request**

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Schema: Order" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "I need 3 widgets at $19.99"}]
  }'
```

The proxy intercepts the response, validates it, coerces `"3"` → `3` if needed, and returns clean JSON. No changes to your calling code.

---

## Schema selection

Two ways to specify which schema to enforce on a request:

**Option 1 — Request header (explicit):**
```
X-Schema: Order
```

**Option 2 — System message tag (no extra header):**
```json
{
  "role": "system",
  "content": "Extract order data as JSON. [schema:Order]"
}
```

Requests with no schema tag pass through to the upstream unmodified. The proxy is a transparent passthrough for everything else.

---

## Enforcement modes

### `coerce` (default)

Applies safe, lossless type coercions before validation:

| From | To | Example |
|------|----|---------|
| `string` | `integer` | `"3"` → `3` (only if numeric) |
| `string` | `number` | `"3.14"` → `3.14` |
| `integer`/`number` | `string` | `42` → `"42"` |
| `string` | `boolean` | `"true"`, `"1"`, `"yes"` → `true` |
| `float` | `integer` | `3.0` → `3` (lossless only; `3.5` is rejected) |
| extra field | stripped | removed when `additionalProperties: false` |

Coercions are logged. Status becomes `coerced` (not `ok`) so you always know when data was adjusted.

### `strict`

No coercion. Any deviation from the schema triggers the retry protocol. If all retries fail, returns `422` with field-level error details.

```bash
node src/server.js --mode strict --max-retries 3
```

---

## Retry protocol

When validation fails, the proxy retries the LLM automatically by injecting the validation errors back into the conversation:

```
[original messages]

→ assistant: <previous invalid response>

→ user: Your previous response failed schema validation. Errors:
          - quantity: expected integer, got string
          - price_cents: missing required field
        Please respond again with a valid JSON object only. No markdown, no explanation.
```

Up to `--max-retries` attempts (default: 2). If all fail:
- `coerce` mode: returns the original response with `X-Schema-Firewall-Status: failed`  
- `strict` mode: returns `422 Unprocessable Entity`

---

## Management API

```
GET  /health              → proxy status + loaded schemas + config
GET  /schemas             → list all registered schema names
GET  /schemas/:name       → get schema JSON
POST /schemas/:name       → register or update a schema (body = JSON Schema)
```

Example:

```bash
# List schemas
curl http://localhost:8080/schemas
# {"schemas":["Order","UserProfile"]}

# Health check
curl http://localhost:8080/health
# {"ok":true,"schemas":["Order"],"mode":"coerce","maxRetries":2}
```

---

## Audit log

Every enforcement event is appended to `~/.schema-firewall/proxy.jsonl`:

```json
{"ts":"2026-05-31T21:00:00Z","schema":"Order","status":"coerced","retries":0,"errors":[],"coercions":["quantity: coerced str→integer"],"model":"gpt-4o","duration_ms":312}
{"ts":"2026-05-31T21:01:00Z","schema":"Order","status":"retried","retries":1,"errors":[],"coercions":[],"model":"gpt-4o","duration_ms":890}
{"ts":"2026-05-31T21:02:00Z","schema":"Order","status":"failed","retries":2,"errors":["price_cents: missing required field"],"coercions":[],"model":"gpt-4o","duration_ms":1820}
```

This file is the foundation for a future dashboard. All the data is there — failures, coercions, retry counts, models, timing.

---

## Configuration

| CLI flag | Environment variable | Default |
|----------|---------------------|---------|
| `--port 8080` | `PORT` | `8080` |
| `--upstream URL` | `OPENAI_BASE_URL_UPSTREAM` | `https://api.openai.com` |
| `--schemas-dir ./schemas` | `SCHEMA_FIREWALL_SCHEMAS_DIR` | `./schemas` |
| `--mode coerce` | `SCHEMA_FIREWALL_MODE` | `coerce` |
| `--max-retries 2` | `SCHEMA_FIREWALL_MAX_RETRIES` | `2` |
| _(log dir)_ | `SCHEMA_FIREWALL_LOG_DIR` | `~/.schema-firewall` |

---

## Compatibility

Works with any client that speaks the OpenAI `/v1/chat/completions` wire format:

- `openai` Python SDK
- `openai` Node.js SDK  
- LangChain, LlamaIndex
- LiteLLM
- Anthropic (via LiteLLM proxy)
- Any `fetch`/`curl`/`requests` call to the OpenAI API

**Requirements:** Node.js 18+ (uses native `fetch` and ES modules). Zero npm dependencies.

---

## Running tests

```bash
node --test test/
```

```
✔ validator (8 tests)
✔ coerce (7 tests)
✔ proxy HTTP (7 tests)
✔ 22 tests passed
```

---

## JSON Schema support

Supports JSON Schema draft-07 subset:
- `type`, `properties`, `required`, `additionalProperties`
- `minimum`, `maximum`, `minLength`, `maxLength`
- `enum`
- Nested objects (recursive validation)

Not yet supported: `$ref`, `allOf`, `oneOf`, `anyOf`, `if/then/else`.

---

## Limitations (v0)

- **No streaming support** — `stream: true` requests pass through unvalidated
- **Localhost only** — no TLS, designed as a local sidecar
- **No proxy auth** — assumes trusted local network
- **JSON Schema subset** — no `$ref` resolution

---

## Roadmap

- [ ] Team dashboard — visualize failure rates, coercion patterns, model drift across your org
- [ ] Streaming support — validate streaming responses as they complete
- [ ] Docker image — single-command deploy as a sidecar
- [ ] Schema versioning — pin a schema version, detect drift when you update it
- [ ] Webhook alerts — notify on repeated failures

---

## License

MIT
