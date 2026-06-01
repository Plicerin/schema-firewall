import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const { token } = JSON.parse(readFileSync(join(homedir(), '.openclaw/credentials/github-copilot.token.json'), 'utf8'));

const COERCE_BASE = 'http://localhost:18086';
const STRICT_BASE = 'http://localhost:18087';
const COPILOT_HEADERS = {
  Authorization: `Bearer ${token}`,
  'Editor-Version': 'vscode/1.99.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'Content-Type': 'application/json',
};

async function registerSchema(base, name, schema) {
  const res = await fetch(`${base}/schemas/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(schema),
  });
  return { status: res.status, body: await res.text() };
}

async function post(base, schemaName, messages) {
  const headers = { ...COPILOT_HEADERS };
  if (schemaName) headers['X-Schema'] = schemaName;
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'gpt-4o',
      messages,
    }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return {
    httpStatus: res.status,
    sfStatus: res.headers.get('x-schema-firewall-status'),
    sfRetries: res.headers.get('x-schema-firewall-retries'),
    sfErrors: res.headers.get('x-schema-firewall-errors'),
    body,
    raw: text,
  };
}

function extractContent(body) {
  return body?.choices?.[0]?.message?.content;
}

function parseMaybeJson(text) {
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch { return text; }
}

function printBlock(title, data) {
  console.log(`\n=== ${title} ===`);
  for (const [k, v] of Object.entries(data)) {
    console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
}

const impossibleSchema = {
  $id: 'ImpossibleOrder',
  type: 'object',
  properties: {
    quantity: { type: 'integer', minimum: 10, maximum: 5 },
  },
  required: ['quantity'],
  additionalProperties: false,
};

const orderSchema = {
  $id: 'OrderSchema',
  type: 'object',
  properties: {
    item: { type: 'string' },
    quantity: { type: 'integer' },
    price_cents: { type: 'integer' },
    notes: { type: 'string' },
  },
  required: ['item', 'quantity', 'price_cents'],
  additionalProperties: false,
};

await registerSchema(COERCE_BASE, 'ImpossibleOrder', impossibleSchema);
await registerSchema(STRICT_BASE, 'ImpossibleOrder', impossibleSchema);
await registerSchema(COERCE_BASE, 'OrderSchema', orderSchema);
await registerSchema(STRICT_BASE, 'OrderSchema', orderSchema);

const coercion = await post(COERCE_BASE, 'OrderSchema', [
  {
    role: 'system',
    content: 'Return ONLY a JSON object with fields: item, quantity, price_cents, notes. IMPORTANT: encode quantity and price_cents as JSON strings, not numbers. No markdown.',
  },
  {
    role: 'user',
    content: 'I want 5 blue widgets at $12.99 each, rush delivery please',
  },
]);

const coercionContent = extractContent(coercion.body);
printBlock('COERCION', {
  httpStatus: coercion.httpStatus,
  sfStatus: coercion.sfStatus,
  sfRetries: coercion.sfRetries,
  returnedContent: coercionContent,
  parsed: parseMaybeJson(coercionContent),
  firewallMeta: coercion.body?.choices?.[0]?.message?.['x-schema-firewall'],
});

const retry = await post(COERCE_BASE, 'OrderSchema', [
  {
    role: 'system',
    content: 'Respond as a markdown ```json fenced block. Include an extra field named explanation. Do not apologize.',
  },
  {
    role: 'user',
    content: 'Extract this order: 2 keyboards at $89.99 each',
  },
]);

const retryContent = extractContent(retry.body);
printBlock('RETRY RECOVERY', {
  httpStatus: retry.httpStatus,
  sfStatus: retry.sfStatus,
  sfRetries: retry.sfRetries,
  sfErrors: retry.sfErrors,
  returnedContent: retryContent,
  parsed: parseMaybeJson(retryContent),
  firewallMeta: retry.body?.choices?.[0]?.message?.['x-schema-firewall'],
});

const strictFail = await post(STRICT_BASE, 'ImpossibleOrder', [
  {
    role: 'system',
    content: 'Return ONLY a JSON object with field quantity as an integer. No markdown.',
  },
  {
    role: 'user',
    content: 'Give me any quantity you like.',
  },
]);

printBlock('STRICT FAILURE', {
  httpStatus: strictFail.httpStatus,
  sfStatus: strictFail.sfStatus,
  sfRetries: strictFail.sfRetries,
  sfErrors: strictFail.sfErrors,
  rawBody: strictFail.body,
});
