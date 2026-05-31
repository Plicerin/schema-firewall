/**
 * schema-firewall/proxy/src/log.js
 * Append-only JSONL audit log.
 */
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const LOG_DIR = process.env.SCHEMA_FIREWALL_LOG_DIR ?? join(homedir(), '.schema-firewall');
const LOG_FILE = join(LOG_DIR, 'proxy.jsonl');

let ready = false;
async function ensureDir() {
  if (ready) return;
  await mkdir(LOG_DIR, { recursive: true });
  ready = true;
}

export async function logEvent(entry) {
  try {
    await ensureDir();
    await appendFile(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* never crash the caller */ }
}
