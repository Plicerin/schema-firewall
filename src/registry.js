/**
 * schema-firewall/proxy/src/registry.js
 *
 * Schema registry. Schemas are keyed by name and stored in memory.
 * On startup, any .json files in the --schemas-dir are auto-loaded.
 *
 * Schema format (JSON Schema draft-07):
 * {
 *   "$id": "OrderSchema",
 *   "type": "object",
 *   "properties": { ... },
 *   "required": [...]
 * }
 *
 * Schemas can also be registered at runtime via POST /schemas.
 * A request is matched to a schema by the X-Schema header or
 * a "schema" field in the request body's system message.
 */

import { readdir, readFile } from 'fs/promises';
import { join, extname } from 'path';

const registry = new Map(); // name → JSON Schema object

export function registerSchema(name, schema) {
  registry.set(name, schema);
  console.error(`[registry] registered schema: ${name}`);
}

export function getSchema(name) {
  return registry.get(name) ?? null;
}

export function listSchemas() {
  return [...registry.keys()];
}

export async function loadSchemasFromDir(dir) {
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return; // dir doesn't exist — fine
  }
  for (const f of files) {
    if (extname(f) !== '.json') continue;
    const raw = await readFile(join(dir, f), 'utf8');
    const schema = JSON.parse(raw);
    const name = schema['$id'] ?? f.replace('.json', '');
    registerSchema(name, schema);
  }
}
