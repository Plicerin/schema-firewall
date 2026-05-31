/**
 * schema-firewall/proxy/src/server.js
 *
 * Drop-in OpenAI-compatible HTTP proxy with schema enforcement.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node src/server.js [--port 8080] [--upstream https://api.openai.com] [--schemas-dir ./schemas] [--mode coerce] [--max-retries 2]
 *
 * Your app:
 *   OPENAI_BASE_URL=http://localhost:8080/v1
 *
 * Per-request schema selection (pick one):
 *   1. Header:          X-Schema: MySchemaName
 *   2. System message:  {"role":"system","content":"... [schema:MySchemaName] ..."}
 *
 * Schema management:
 *   GET  /schemas            → list registered schemas
 *   GET  /schemas/:name      → get schema JSON
 *   POST /schemas/:name      → register/update schema (body = JSON Schema)
 *   GET  /health             → {"ok":true}
 */

import { createServer } from 'http';
import { getSchema, listSchemas, registerSchema, loadSchemasFromDir } from './registry.js';
import { validate } from './validator.js';
import { coerce } from './coerce.js';
import { logEvent } from './log.js';

// ── Config ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const arg = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };

const PORT         = Number(arg('--port', process.env.PORT ?? '8080'));
const UPSTREAM     = arg('--upstream', process.env.OPENAI_BASE_URL_UPSTREAM ?? 'https://api.openai.com');
const SCHEMAS_DIR  = arg('--schemas-dir', process.env.SCHEMA_FIREWALL_SCHEMAS_DIR ?? './schemas');
const MODE         = arg('--mode', process.env.SCHEMA_FIREWALL_MODE ?? 'coerce');   // coerce | strict
const MAX_RETRIES  = Number(arg('--max-retries', process.env.SCHEMA_FIREWALL_MAX_RETRIES ?? '2'));

// ── Helpers ──────────────────────────────────────────────────────────────────

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function extractSchemaName(reqHeaders, bodyObj) {
  // 1. Explicit header
  if (reqHeaders['x-schema']) return reqHeaders['x-schema'];
  // 2. System message tag: [schema:Name]
  const messages = bodyObj?.messages ?? [];
  for (const m of messages) {
    if (m.role === 'system' && typeof m.content === 'string') {
      const match = m.content.match(/\[schema:([^\]]+)\]/);
      if (match) return match[1];
    }
  }
  return null;
}

function extractJson(text) {
  if (!text) return null;
  // Strip markdown fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1];
  try { return JSON.parse(text.trim()); } catch { return null; }
}

// ── Upstream call ────────────────────────────────────────────────────────────

async function callUpstream(path, method, headers, body) {
  const url = `${UPSTREAM}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': headers['authorization'] ?? '',
      'OpenAI-Organization': headers['openai-organization'] ?? '',
      ...(headers['anthropic-version'] ? { 'anthropic-version': headers['anthropic-version'] } : {}),
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, text, headers: Object.fromEntries(res.headers.entries()) };
}

// ── Enforcement ──────────────────────────────────────────────────────────────

function buildRetryMessages(originalMessages, errors) {
  return [
    ...originalMessages,
    {
      role: 'assistant',
      content: '<previous response omitted — failed schema validation>',
    },
    {
      role: 'user',
      content: `Your previous response failed schema validation. Errors:\n${errors.map(e => `  - ${e}`).join('\n')}\n\nPlease respond again with a valid JSON object only. No markdown, no explanation.`,
    },
  ];
}

async function enforceSchema(schema, completionJson, originalBody, reqHeaders, retryCount = 0) {
  const choice = completionJson?.choices?.[0];
  const rawContent = choice?.message?.content ?? '';
  const parsed = extractJson(rawContent);

  if (parsed === null) {
    return {
      status: 'parse_failed',
      errors: ['response content is not valid JSON'],
      coercions: [],
      retries: retryCount,
      data: null,
      completion: completionJson,
    };
  }

  let data = parsed;
  let coercions = [];

  if (MODE === 'coerce') {
    const result = coerce(data, schema);
    data = result.data;
    coercions = result.coercions;
  }

  const { valid, errors } = validate(data, schema);

  if (valid) {
    return { status: coercions.length ? 'coerced' : 'ok', errors: [], coercions, retries: retryCount, data, completion: completionJson };
  }

  // Failed — retry?
  if (retryCount < MAX_RETRIES) {
    const bodyObj = JSON.parse(originalBody);
    const retryMessages = buildRetryMessages(bodyObj.messages, errors);
    const retryBody = JSON.stringify({ ...bodyObj, messages: retryMessages });
    const upstream = await callUpstream('/v1/chat/completions', 'POST', reqHeaders, retryBody);

    if (upstream.status !== 200) {
      return { status: 'failed', errors, coercions, retries: retryCount + 1, data: null, completion: completionJson };
    }

    let retryJson;
    try { retryJson = JSON.parse(upstream.text); } catch {
      return { status: 'failed', errors, coercions, retries: retryCount + 1, data: null, completion: completionJson };
    }

    return enforceSchema(schema, retryJson, originalBody, reqHeaders, retryCount + 1);
  }

  return { status: 'failed', errors, coercions, retries: retryCount, data: null, completion: completionJson };
}

// ── Request handler ──────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const { method, url, headers } = req;

  // ── Health ──
  if (url === '/health') {
    return json(res, 200, { ok: true, schemas: listSchemas(), mode: MODE, maxRetries: MAX_RETRIES });
  }

  // ── Schema management ──
  if (url === '/schemas') {
    return json(res, 200, { schemas: listSchemas() });
  }
  const schemaMatch = url.match(/^\/schemas\/([^/?]+)$/);
  if (schemaMatch) {
    const name = decodeURIComponent(schemaMatch[1]);
    if (method === 'GET') {
      const schema = getSchema(name);
      if (!schema) return json(res, 404, { error: `schema '${name}' not found` });
      return json(res, 200, schema);
    }
    if (method === 'POST') {
      const body = await readBody(req);
      let schema;
      try { schema = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid JSON' }); }
      registerSchema(name, schema);
      return json(res, 201, { registered: name });
    }
  }

  // ── Proxy: only chat/completions ──
  if (!url.startsWith('/v1/')) {
    return json(res, 404, { error: 'not found' });
  }

  const body = await readBody(req);

  // Passthrough non-POST or non-chat paths
  if (method !== 'POST' || !url.includes('/chat/completions')) {
    const upstream = await callUpstream(url, method, headers, body || undefined);
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    return res.end(upstream.text);
  }

  let bodyObj;
  try { bodyObj = JSON.parse(body); } catch {
    return json(res, 400, { error: 'invalid JSON in request body' });
  }

  const schemaName = extractSchemaName(headers, bodyObj);
  const schema = schemaName ? getSchema(schemaName) : null;

  // No schema → pure passthrough
  if (!schema) {
    const upstream = await callUpstream(url, method, headers, body);
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    return res.end(upstream.text);
  }

  // Call upstream
  const upstream = await callUpstream(url, method, headers, body);
  let completionJson;
  try { completionJson = JSON.parse(upstream.text); } catch {
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    return res.end(upstream.text);
  }

  if (upstream.status !== 200) {
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    return res.end(upstream.text);
  }

  const t0 = Date.now();
  const enforcement = await enforceSchema(schema, completionJson, body, headers);
  const durationMs = Date.now() - t0;

  // Log
  await logEvent({
    schema: schemaName,
    status: enforcement.status,
    retries: enforcement.retries,
    errors: enforcement.errors,
    coercions: enforcement.coercions,
    duration_ms: durationMs,
    model: bodyObj.model,
  });

  // Mutate the completion's message content with the coerced/validated data
  const responseObj = { ...completionJson };
  if (enforcement.data !== null && responseObj.choices?.[0]?.message) {
    responseObj.choices[0].message.content = JSON.stringify(enforcement.data);
    responseObj.choices[0].message['x-schema-firewall'] = {
      status: enforcement.status,
      schema: schemaName,
      retries: enforcement.retries,
      coercions: enforcement.coercions,
    };
  }

  // Add enforcement headers
  res.setHeader('X-Schema-Firewall-Status', enforcement.status);
  res.setHeader('X-Schema-Firewall-Schema', schemaName);
  res.setHeader('X-Schema-Firewall-Retries', String(enforcement.retries));
  if (enforcement.errors.length) {
    res.setHeader('X-Schema-Firewall-Errors', enforcement.errors.join('; '));
  }

  if (enforcement.status === 'failed' && MODE === 'strict') {
    return json(res, 422, {
      error: {
        type: 'schema_enforcement_failed',
        message: 'LLM response did not match schema after all retry attempts',
        errors: enforcement.errors,
        retries: enforcement.retries,
        schema: schemaName,
      }
    });
  }

  return json(res, 200, responseObj);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

await loadSchemasFromDir(SCHEMAS_DIR);

const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error('[proxy] unhandled error:', err);
    if (!res.headersSent) json(res, 500, { error: 'internal proxy error', detail: err.message });
  }
});

server.listen(PORT, () => {
  console.error(`[schema-firewall] proxy listening on http://localhost:${PORT}`);
  console.error(`[schema-firewall] upstream: ${UPSTREAM}`);
  console.error(`[schema-firewall] mode: ${MODE} | max-retries: ${MAX_RETRIES}`);
  console.error(`[schema-firewall] schemas loaded: ${listSchemas().join(', ') || '(none)'}`);
  console.error(`[schema-firewall] set OPENAI_BASE_URL=http://localhost:${PORT}/v1 in your app`);
});

export { server };
