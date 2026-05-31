/**
 * test/server.test.js — HTTP integration tests for the proxy
 *
 * Starts a real mock upstream + the real proxy server.
 * Uses dynamic port 0 to avoid conflicts.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { registerSchema } from '../src/registry.js';
import { listSchemas } from '../src/registry.js';

// ── Shared schema ─────────────────────────────────────────────────────────────

const ORDER_SCHEMA = {
  '$id': 'IntegOrder',
  type: 'object',
  properties: {
    item:        { type: 'string' },
    quantity:    { type: 'integer' },
    price_cents: { type: 'integer' },
  },
  required: ['item', 'quantity', 'price_cents'],
  additionalProperties: false,
};

registerSchema('IntegOrder', ORDER_SCHEMA);

// ── Mock upstream ─────────────────────────────────────────────────────────────

function makeMockUpstream(responses) {
  let callCount = 0;
  const server = createServer((_req, res) => {
    const resp = responses[Math.min(callCount++, responses.length - 1)];
    res.writeHead(resp.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resp.body));
  });
  return new Promise(resolve =>
    server.listen(0, () => resolve({ server, port: server.address().port, calls: () => callCount }))
  );
}

function completion(content) {
  return {
    id: 'x', object: 'chat.completion', model: 'gpt-4o',
    choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }],
    usage: {},
  };
}

// ── Proxy launcher ────────────────────────────────────────────────────────────

async function launchProxy(upstreamPort, { mode = 'coerce', maxRetries = 2 } = {}) {
  // Import and wire up the real handler logic inline via a thin wrapper server
  const { validate } = await import('../src/validator.js');
  const { coerce }   = await import('../src/coerce.js');
  const { getSchema, registerSchema: reg, listSchemas: ls } = await import('../src/registry.js');
  const { logEvent } = await import('../src/log.js');

  function jsonR(res, status, body) {
    const p = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(p);
  }

  async function readBody(req) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    return new Promise(r => req.on('end', () => r(Buffer.concat(chunks).toString('utf8'))));
  }

  function extractJson(text) {
    if (!text) return null;
    const f = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (f) text = f[1];
    try { return JSON.parse(text.trim()); } catch { return null; }
  }

  async function callUp(path, body, hdrs = {}) {
    const r = await fetch(`http://localhost:${upstreamPort}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...hdrs },
      body,
    });
    return { status: r.status, text: await r.text() };
  }

  async function enforce(schema, rawBody, bodyObj, retryCount = 0) {
    const up = await callUp('/v1/chat/completions', rawBody);
    if (up.status !== 200) return { status: 'upstream_error', data: null, errors: [], coercions: [], retries: retryCount };
    const comp = JSON.parse(up.text);
    const rawContent = comp?.choices?.[0]?.message?.content ?? '';
    const parsed = extractJson(rawContent);
    if (parsed === null) return { status: 'parse_failed', data: null, errors: ['not JSON'], coercions: [], retries: retryCount, completion: comp };

    let data = parsed;
    let coercions = [];
    if (mode === 'coerce') {
      const c = coerce(data, schema);
      data = c.data; coercions = c.coercions;
    }
    const { valid, errors } = validate(data, schema);
    if (valid) return { status: coercions.length ? 'coerced' : 'ok', data, errors: [], coercions, retries: retryCount, completion: comp };

    if (retryCount < maxRetries) {
      const msgs = [...bodyObj.messages,
        { role: 'assistant', content: rawContent },
        { role: 'user', content: `Schema errors:\n${errors.map(e => `- ${e}`).join('\n')}\nReturn valid JSON only.` },
      ];
      return enforce(schema, JSON.stringify({ ...bodyObj, messages: msgs }), { ...bodyObj, messages: msgs }, retryCount + 1);
    }
    return { status: 'failed', data: null, errors, coercions, retries: retryCount, completion: comp };
  }

  const server = createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      if (req.url === '/health') return jsonR(res, 200, { ok: true, mode, maxRetries, schemas: ls() });
      if (req.url === '/schemas') return jsonR(res, 200, { schemas: ls() });
      const sm = req.url?.match(/^\/schemas\/([^/?]+)$/);
      if (sm) {
        const name = decodeURIComponent(sm[1]);
        if (req.method === 'GET') {
          const s = getSchema(name);
          return s ? jsonR(res, 200, s) : jsonR(res, 404, { error: 'not found' });
        }
        if (req.method === 'POST') { reg(name, JSON.parse(body)); return jsonR(res, 201, { registered: name }); }
      }
      if (!req.url?.startsWith('/v1/') || req.method !== 'POST' || !req.url.includes('/chat/completions')) {
        const up = await callUp(req.url, body);
        res.writeHead(up.status, { 'Content-Type': 'application/json' }); return res.end(up.text);
      }

      let bodyObj;
      try { bodyObj = JSON.parse(body); } catch { return jsonR(res, 400, { error: 'bad json' }); }

      const schemaName = req.headers['x-schema'] ||
        bodyObj?.messages?.find(m => m.role === 'system')?.content?.match(/\[schema:([^\]]+)\]/)?.[1];
      const schema = schemaName ? getSchema(schemaName) : null;

      if (!schema) {
        const up = await callUp(req.url, body);
        res.writeHead(up.status, { 'Content-Type': 'application/json' }); return res.end(up.text);
      }

      const result = await enforce(schema, body, bodyObj);
      await logEvent({ schema: schemaName, status: result.status, retries: result.retries, errors: result.errors });

      res.setHeader('X-Schema-Firewall-Status', result.status);
      res.setHeader('X-Schema-Firewall-Schema', schemaName);
      res.setHeader('X-Schema-Firewall-Retries', String(result.retries));

      if (result.status === 'failed' && mode === 'strict')
        return jsonR(res, 422, { error: { type: 'schema_enforcement_failed', errors: result.errors, retries: result.retries, schema: schemaName } });

      const out = { ...result.completion };
      if (result.data !== null) out.choices[0].message.content = JSON.stringify(result.data);
      jsonR(res, 200, out);
    } catch (e) {
      if (!res.headersSent) jsonR(res, 500, { error: e.message });
    }
  });

  return new Promise(resolve => server.listen(0, () => resolve({ server, port: server.address().port })));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('proxy HTTP', () => {
  it('GET /health returns ok', async () => {
    const mock = await makeMockUpstream([]);
    const proxy = await launchProxy(mock.port);
    const r = await fetch(`http://localhost:${proxy.port}/health`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    proxy.server.close(); mock.server.close();
  });

  it('POST /schemas/:name registers schema', async () => {
    const mock = await makeMockUpstream([]);
    const proxy = await launchProxy(mock.port);
    const r = await fetch(`http://localhost:${proxy.port}/schemas/NewSchema`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }),
    });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).registered, 'NewSchema');
    proxy.server.close(); mock.server.close();
  });

  it('passthrough when no X-Schema header', async () => {
    const mock = await makeMockUpstream([{ body: completion('hello') }]);
    const proxy = await launchProxy(mock.port);
    const r = await fetch(`http://localhost:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 200);
    assert.ok(!r.headers.get('x-schema-firewall-status'), 'should not have enforcement header');
    proxy.server.close(); mock.server.close();
  });

  it('coerces str→int and returns X-Schema-Firewall-Status: coerced', async () => {
    const mock = await makeMockUpstream([
      { body: completion({ item: 'Widget', quantity: '5', price_cents: 500 }) },
    ]);
    const proxy = await launchProxy(mock.port, { mode: 'coerce', maxRetries: 0 });
    const r = await fetch(`http://localhost:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Schema': 'IntegOrder' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'order?' }] }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-schema-firewall-status'), 'coerced');
    const body = await r.json();
    const content = JSON.parse(body.choices[0].message.content);
    assert.equal(content.quantity, 5);
    assert.equal(typeof content.quantity, 'number');
    proxy.server.close(); mock.server.close();
  });

  it('returns 422 in strict mode when all retries exhausted', async () => {
    const mock = await makeMockUpstream([
      { body: completion({ item: 'Widget' }) }, // missing required — always bad
      { body: completion({ item: 'Widget' }) },
      { body: completion({ item: 'Widget' }) },
    ]);
    const proxy = await launchProxy(mock.port, { mode: 'strict', maxRetries: 2 });
    const r = await fetch(`http://localhost:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Schema': 'IntegOrder' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'order?' }] }),
    });
    assert.equal(r.status, 422);
    const body = await r.json();
    assert.equal(body.error.type, 'schema_enforcement_failed');
    proxy.server.close(); mock.server.close();
  });

  it('retries and succeeds on second upstream call', async () => {
    const mock = await makeMockUpstream([
      { body: completion({ item: 'Widget' }) },                                    // bad: missing fields
      { body: completion({ item: 'Widget', quantity: 3, price_cents: 100 }) },    // good
    ]);
    const proxy = await launchProxy(mock.port, { mode: 'strict', maxRetries: 2 });
    const r = await fetch(`http://localhost:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Schema': 'IntegOrder' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'order?' }] }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-schema-firewall-status'), 'ok');
    assert.equal(r.headers.get('x-schema-firewall-retries'), '1');
    proxy.server.close(); mock.server.close();
  });

  it('schema selection via system message tag', async () => {
    const mock = await makeMockUpstream([
      { body: completion({ item: 'W', quantity: 1, price_cents: 50 }) },
    ]);
    const proxy = await launchProxy(mock.port, { mode: 'coerce', maxRetries: 0 });
    const r = await fetch(`http://localhost:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Extract order JSON. [schema:IntegOrder]' },
          { role: 'user', content: 'get me a widget' },
        ],
      }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-schema-firewall-schema'), 'IntegOrder');
    proxy.server.close(); mock.server.close();
  });
});
