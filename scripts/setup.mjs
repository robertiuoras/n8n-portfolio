// Idempotent: creates Data Tables, the Gemini credential (if a key exists), imports + activates every workflow.
// Usage: node scripts/setup.mjs   (needs N8N_LOCAL_API_KEY in the environment; n8n running on :5678)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://localhost:5678';
const secret = (n) => { try { return execFileSync('node', [process.env.HOME + '/Projects/claude-memory/claude-config/secrets.mjs', 'get', n], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const KEY = process.env.N8N_LOCAL_API_KEY || secret('N8N_LOCAL_API_KEY');
const api = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'X-N8N-API-KEY': KEY, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${t.slice(0, 400)}`);
  return j;
};
const S = 'string', N = 'number', B = 'boolean';
const tables = {
  mock_crm_contacts: { email: S, name: S, phone: S, company: S, summary: S, extra: S, created_at: S, updated_at: S, version: N },
  mock_crm_log: { email: S, method: S, x_fail: S, outcome: S, at: S },
  crm_sent: { key: S, conversation_id: S, crm_action: S, crm_id: N, at: S },
  crm_errors: { key: S, step: S, http_status: N, error: S, payload: S, at: S },
  notifications: { kind: S, name: S, email: S, score: N, summary: S, at: S },
  handoffs: { question: S, reason: S, confidence: N, at: S },
  eval_runs: { run_at: S, total: N, answerable: N, unanswerable: N, accuracy: N, correct_refusal_rate: N, wrong_answers: N, missed_answers: N, ai_unavailable: N, details: S },
  workflow_errors: { workflow_name: S, node: S, message: S, execution_id: S, at: S },
};
const have = new Set((await api('GET', '/api/v1/data-tables?limit=250')).data.map((t) => t.name));
for (const [name, cols] of Object.entries(tables)) {
  if (have.has(name)) continue;
  await api('POST', '/api/v1/data-tables', { name, columns: Object.entries(cols).map(([n, type]) => ({ name: n, type })) });
  console.log('table created', name);
}
// Gemini credential (only if the key exists)
let credId = null;
const gem = secret('GEMINI_API_KEY');
if (gem) {
  const r = await fetch(BASE + '/rest/credentials', { headers: { cookie: process.env.N8N_COOKIE || '' } });
  console.log('gemini key present: credential must be created via owner session (see create-credential.mjs)');
}
const wfs = (await api('GET', '/api/v1/workflows?limit=250')).data;
const idOf = (name) => wfs.find((w) => w.name === name)?.id;
const order = ['error-handler', 'mock-crm', 'error-demo', 'chatbot-to-crm', 'ai-lead-qualify', 'support-bot-with-fallback', 'support-bot-eval'];
const ids = {};
for (const name of order) {
  let txt = fs.readFileSync(path.join(root, 'workflows', name + '.json'), 'utf8');
  if (ids['error-handler']) txt = txt.replaceAll('__ERROR_WORKFLOW_ID__', ids['error-handler']);
  if (process.env.GEMINI_CRED_ID) txt = txt.replaceAll('__GEMINI_CRED_ID__', process.env.GEMINI_CRED_ID);
  const def = JSON.parse(txt);
  if (def.settings.errorWorkflow === '__ERROR_WORKFLOW_ID__') delete def.settings.errorWorkflow;
  const existing = wfs.find((w) => w.name === name) || null;
  let wf;
  if (existing) { await api('POST', `/api/v1/workflows/${existing.id}/deactivate`).catch(() => {}); wf = await api('PUT', `/api/v1/workflows/${existing.id}`, def); }
  else wf = await api('POST', '/api/v1/workflows', def);
  ids[name] = wf.id;
  let act = 'n/a (no trigger)';
  if (name !== 'support-bot-eval') { try { await api('POST', `/api/v1/workflows/${wf.id}/activate`, {}); act = 'active'; } catch (e) { act = 'ACTIVATE FAILED: ' + e.message; } }
  console.log(name.padEnd(28), wf.id, act);
}
fs.writeFileSync(path.join(root, 'data', 'ids.json'), JSON.stringify(ids, null, 2));
