/**
 * live-test.js — real-world SchemaFirewall test against GitHub Copilot
 * Run: node live-test.js
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const { token } = JSON.parse(readFileSync(join(homedir(), '.openclaw/credentials/github-copilot.token.json'), 'utf8'));
const BASE = 'http://localhost:18085';
const EXTRA_HEADERS = {
  'Authorization': `Bearer ${token}`,
  'Editor-Version': 'vscode/1.99.0',
  'Copilot-Integration-Id': 'vscode-chat',
};

async function chat(schema, systemPrompt, userPrompt) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Schema': schema, ...EXTRA_HEADERS },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
    }),
  });
  const body = await res.json();
  return {
    sfStatus:  res.headers.get('x-schema-firewall-status'),
    sfRetries: res.headers.get('x-schema-firewall-retries'),
    sfErrors:  res.headers.get('x-schema-firewall-errors'),
    content:   body.choices?.[0]?.message?.content ?? JSON.stringify(body),
    sfMeta:    body.choices?.[0]?.message?.['x-schema-firewall'],
  };
}

function parseContent(content) {
  try { return JSON.parse(content); } catch { return content; }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('SchemaFirewall — Live Test Against GitHub Copilot\n' + '='.repeat(60));

// Register a UserProfile schema at runtime
await fetch(`${BASE}/schemas/UserProfile`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    '$id': 'UserProfile',
    type: 'object',
    properties: {
      name:  { type: 'string' },
      age:   { type: 'integer' },
      email: { type: 'string' },
      active: { type: 'boolean' },
    },
    required: ['name', 'age', 'email'],
    additionalProperties: false,
  }),
});
console.log('Registered UserProfile schema at runtime.\n');

// ── TEST 1: Clean extraction ──────────────────────────────────────────────────
console.log('TEST 1: Clean extraction (expect status=ok)');
console.log('Prompt: "5 blue widgets at $12.99 each, rush delivery"');
const t1 = await chat(
  'OrderSchema',
  'Extract order details. Return ONLY a valid JSON object with fields: item (string), quantity (integer), price_cents (integer — price in cents, so $12.99 = 1299), notes (string, optional). No markdown, no explanation, no trailing text.',
  'I want 5 blue widgets at $12.99 each, rush delivery please'
);
const t1data = parseContent(t1.content);
console.log(`  SF-Status:  ${t1.sfStatus}`);
console.log(`  SF-Retries: ${t1.sfRetries}`);
console.log(`  Parsed:     ${JSON.stringify(t1data)}`);
console.log(`  quantity type: ${typeof t1data?.quantity}  (want: number)`);
console.log();

// ── TEST 2: Coercion — prompt likely to produce string numbers ────────────────
console.log('TEST 2: Coercion stress — ask for "10 items at 5 dollars" (LLM may return strings)');
const t2 = await chat(
  'OrderSchema',
  'Extract order details. Return a JSON object. Fields: item (string), quantity (integer), price_cents (integer), notes (string optional).',
  'get me ten of those gadgets, five bucks each'
);
const t2data = parseContent(t2.content);
console.log(`  SF-Status:  ${t2.sfStatus}`);
console.log(`  SF-Retries: ${t2.sfRetries}`);
console.log(`  Parsed:     ${JSON.stringify(t2data)}`);
console.log(`  quantity type: ${typeof t2data?.quantity}  (want: number)`);
console.log();

// ── TEST 3: UserProfile extraction ───────────────────────────────────────────
console.log('TEST 3: UserProfile — runtime-registered schema');
console.log('Prompt: "Alice Smith, 34, alice@example.com, currently active"');
const t3 = await chat(
  'UserProfile',
  'Extract user profile info. Return ONLY a JSON object: name (string), age (integer), email (string), active (boolean). No markdown.',
  'Alice Smith, 34, alice@example.com, currently active'
);
const t3data = parseContent(t3.content);
console.log(`  SF-Status:  ${t3.sfStatus}`);
console.log(`  SF-Retries: ${t3.sfRetries}`);
console.log(`  Parsed:     ${JSON.stringify(t3data)}`);
console.log(`  active type: ${typeof t3data?.active}  (want: boolean)`);
console.log();

// ── TEST 4: Markdown fence handling ──────────────────────────────────────────
console.log('TEST 4: Force markdown fence — system prompt that encourages ```json blocks');
const t4 = await chat(
  'OrderSchema',
  'You are a helpful assistant. When asked for data, format your response as a JSON code block using markdown (```json ... ```).',
  'Extract this order: 2 keyboards at $89.99 each'
);
const t4data = parseContent(t4.content);
console.log(`  SF-Status:  ${t4.sfStatus}`);
console.log(`  SF-Retries: ${t4.sfRetries}`);
console.log(`  Parsed:     ${JSON.stringify(t4data)}`);
console.log(`  (schema firewall should strip the fences and still validate)`);
console.log();

// ── TEST 5: Passthrough — no schema tag ──────────────────────────────────────
console.log('TEST 5: Passthrough — no X-Schema header (no enforcement)');
const passthroughRes = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...EXTRA_HEADERS },
  body: JSON.stringify({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }],
  }),
});
const ptBody = await passthroughRes.json();
console.log(`  SF-Status header present: ${!!passthroughRes.headers.get('x-schema-firewall-status')}  (want: false)`);
console.log(`  Response: ${ptBody.choices?.[0]?.message?.content}`);
console.log();

// ── Audit log ─────────────────────────────────────────────────────────────────
console.log('='.repeat(60));
console.log('AUDIT LOG (last 5 entries):');
try {
  const { readFileSync } = await import('fs');
  const log = readFileSync('/tmp/sf-live/proxy.jsonl', 'utf8').trim().split('\n').slice(-5);
  log.forEach(l => {
    const e = JSON.parse(l);
    console.log(`  [${e.ts}] schema=${e.schema} status=${e.status} retries=${e.retries} coercions=${e.coercions?.length ?? 0}`);
  });
} catch (e) {
  console.log('  (log not found:', e.message, ')');
}
