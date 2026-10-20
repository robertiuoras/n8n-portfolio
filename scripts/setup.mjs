// Idempotent: creates Data Tables, the Gemini credential (if a key exists), imports + activates every workflow.
// Usage: node scripts/setup.mjs   (needs N8N_LOCAL_API_KEY in the environment; n8n running on :5678)
import crypto from 'node:crypto';
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
  rag_chunks: { chunk_id: S, doc_id: S, title: S, section: S, text: S, embedding: S, model: S, ingested_at: S },
  rag_handoff_log: { question: S, reason: S, confidence: N, top_score: N, at: S },
  rag_eval_scores: { run_at: S, total: N, answerable: N, unanswerable: N, retrieval_hit_rate: N, answer_accuracy: N, correct_refusal_rate: N, wrong_answers: N, missed_answers: N, ai_unavailable: N, details: S },
  agent_bookings: { booking_id: S, customer_email: S, status: S, install_date: S, paid_amount: N, refunded_amount: N, updated_at: S },
  agent_approvals: { approval_id: S, booking_id: S, customer_email: S, amount: N, request: S, status: S, approver: S, created_at: S, decided_at: S },
  agent_audit: { customer_email: S, message: S, proposed: S, decision: S, reason: S, booking_id: S, approval_id: S, dry_run: S, at: S },
  agent_eval_scores: { run_at: S, total: N, valid_requests: N, decision_accuracy: N, unsafe_actions: N, over_blocked: N, wrong_action: N, ai_unavailable: N, details: S },
  voice_callers: { phone: S, customer_email: S },
  voice_calls: { call_id: S, phone: S, customer_email: S, started_at: S, duration_s: N, cost: N, ended_reason: S, outcome: S, follow_up: S, follow_up_reason: S, summary: S, ai_status: S, at: S },
  voice_callbacks: { call_id: S, phone: S, customer_email: S, reason: S, source: S, status: S, created_at: S },
  ops_checks: { run_id: S, check: S, url: S, expected: N, status: N, ok: S, ms: N, error: S, checked_at: S, checked_ms: N },
  ops_alerts: { alert_id: S, check: S, status: S, opened_at: S, closed_at: S, last_error: S },
  voice_eval_scores: { run_at: S, total: N, needs_call_back: N, outcome_accuracy: N, missed_call_backs: N, extra_call_backs: N, ai_unavailable: N, details: S },
  invoices: { invoice_key: S, supplier_name: S, supplier_abn: S, invoice_number: S, invoice_date: S, due_date: S, currency: S, subtotal: N, tax: N, total: N, line_items: S, file_name: S, status: S, entered_at: S },
  invoice_review: { file_name: S, reasons: S, extracted: S, text_excerpt: S, status: S, created_at: S },
  email_triage: { message_id: S, from_email: S, subject: S, category: S, urgency: S, route: S, summary: S, reasons: S, ai_status: S, at: S },
  email_drafts: { message_id: S, to_email: S, subject: S, body: S, faq_ids: S, status: S, created_at: S },
  email_scores: { run_at: S, total: N, category_accuracy: N, route_accuracy: N, missed_urgent: N, false_urgent: N, unsafe_drafts: N, ai_unavailable: N, details: S },
  invoice_scores: { run_at: S, total: N, routing_accuracy: N, field_accuracy: N, right_reason: S, wrong_auto_entries: N, unneeded_reviews: N, ai_unavailable: N, details: S },
  wa_messages: { wa_message_id: S, phone: S, direction: S, type: S, text: S, reason: S, at: S },
  wa_outbox: { to: S, text: S, wamid: S, at: S },
  sms_outbox: { to: S, sender: S, body: S, sms_id: S, at: S },
  sms_optout: { phone: S, keyword: S, source: S, at: S },
  sms_never_text: { phone: S, note: S },
  review_requests: { job_id: S, customer_name: S, contact: S, channel: S, status: S, detail: S, at: S },
  missed_call_log: { caller: S, called_at: S, status: S, reason: S, at: S },
  leads: { caller: S, time: S, status: S, note: S },
  wa_scores: { run_at: S, total: N, turn_accuracy: N, follow_ups_correct: S, wrong_answers: N, unneeded_handoffs: N, ai_unavailable: N, details: S },
};
const have = new Set((await api('GET', '/api/v1/data-tables?limit=250')).data.map((t) => t.name));
// The Data Table node finds a table "by name" with a substring match and takes the first hit, so a table called
// rag_handoffs silently captured every write meant for handoffs (2026-10-17). Refuse any name that sits inside another.
const allNames = [...new Set([...have, ...Object.keys(tables)])];
const clash = allNames.flatMap((a) => allNames.filter((b) => a !== b && b.includes(a)).map((b) => `"${a}" is inside "${b}"`));
if (clash.length) throw new Error('Data Table names must not contain one another (n8n looks tables up by substring): ' + clash.join(', '));
for (const [name, cols] of Object.entries(tables)) {
  if (have.has(name)) continue;
  await api('POST', '/api/v1/data-tables', { name, columns: Object.entries(cols).map(([n, type]) => ({ name: n, type })) });
  console.log('table created', name);
}
// Gemini credential "Gemini free tier" (only if the key exists); re-saved with the current key on every run.
let credId = process.env.GEMINI_CRED_ID || null;
const gem = secret('GEMINI_API_KEY');
if (!credId && gem) {
  const cred = { name: 'Gemini free tier', type: 'googlePalmApi', data: { host: 'https://generativelanguage.googleapis.com', apiKey: gem } };
  const found = (await api('GET', '/api/v1/credentials?limit=250')).data.find((c) => c.name === cred.name && c.type === cred.type);
  if (found) { await api('PATCH', `/api/v1/credentials/${found.id}`, { name: cred.name, data: cred.data }); credId = found.id; console.log('credential updated', credId); }
  else { credId = (await api('POST', '/api/v1/credentials', cred)).id; console.log('credential created', credId); }
}
// Synthetic bookings the guarded-agent eval runs against (dry runs, so they never change). Seeded once.
const tableId = async (name) => (await api('GET', '/api/v1/data-tables?limit=250')).data.find((t) => t.name === name).id;
const bookingsId = await tableId('agent_bookings');
if (!(await api('GET', `/api/v1/data-tables/${bookingsId}/rows?limit=1`)).data.length) {
  const d = new Date(); d.setDate(d.getDate() + 10); while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1);
  const soon = d.toISOString().slice(0, 10);
  const seed = [['B-1001', 'alex@demo.test', 'scheduled', soon, 4990], ['B-1004', 'alex@demo.test', 'completed', '2026-08-12', 1200],
    ['B-1002', 'sam@demo.test', 'scheduled', soon, 6990], ['B-1003', 'jo@demo.test', 'completed', '2026-07-30', 890]];
  await api('POST', `/api/v1/data-tables/${bookingsId}/rows`, { data: seed.map(([booking_id, customer_email, status, install_date, paid_amount]) =>
    ({ booking_id, customer_email, status, install_date, paid_amount, refunded_amount: 0, updated_at: new Date().toISOString() })) });
  console.log('seeded agent_bookings');
}
// Which phone number belongs to which demo customer (numbers from the 0491 570 range Australia reserves for fiction).
const callersId = await tableId('voice_callers');
if (!(await api('GET', `/api/v1/data-tables/${callersId}/rows?limit=1`)).data.length) {
  await api('POST', `/api/v1/data-tables/${callersId}/rows`, { data: [['+61491570156', 'alex@demo.test'], ['+61491570157', 'sam@demo.test'], ['+61491570158', 'jo@demo.test']]
    .map(([phone, customer_email]) => ({ phone, customer_email })) });
  console.log('seeded voice_callers');
}
// One invoice already entered, so the invoice eval can prove a second copy is caught as a duplicate.
const invoicesId = await tableId('invoices');
if (!(await api('GET', `/api/v1/data-tables/${invoicesId}/rows?limit=1`)).data.length) {
  await api('POST', `/api/v1/data-tables/${invoicesId}/rows`, { data: [{ invoice_key: '86330635407|INV-0007690', supplier_name: 'GreenCable Wholesale', supplier_abn: '86330635407',
    invoice_number: 'INV-0007690', invoice_date: '2026-09-22', due_date: '2026-10-22', currency: 'AUD', subtotal: 447, tax: 44.7, total: 491.7,
    line_items: JSON.stringify([{ description: 'Solar cable 4mm2, 100 m roll', quantity: 3, unit_price: 149, amount: 447 }]), file_name: 'seed', status: 'entered', entered_at: new Date().toISOString() }] });
  console.log('seeded invoices');
}
// Header key for approving refunds (credential "Agent approver key"). The value lives only in data/approver-key.txt
// (git-ignored) and in n8n; it is made once and re-saved on every run.
const keyFile = path.join(root, 'data', 'approver-key.txt');
fs.mkdirSync(path.dirname(keyFile), { recursive: true });
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
// Saves a credential by name and type: updates the one already there, otherwise creates it. Returns its id.
const upsertCred = async (cred) => {
  const found = (await api('GET', '/api/v1/credentials?limit=250')).data.find((x) => x.name === cred.name && x.type === cred.type);
  return found ? (await api('PATCH', `/api/v1/credentials/${found.id}`, { name: cred.name, data: cred.data }), found.id) : (await api('POST', '/api/v1/credentials', cred)).id;
};
const approverId = await upsertCred({ name: 'Agent approver key', type: 'httpHeaderAuth', data: { name: 'x-approver-key', value: fs.readFileSync(keyFile, 'utf8').trim() } });
// Shared secret Vapi sends in the x-vapi-secret header (a Vapi Bearer credential with that header name and no prefix).
// Same handling as the approver key: data/voice-secret.txt (git-ignored) and the n8n credential "Voice server secret".
const voiceFile = path.join(root, 'data', 'voice-secret.txt');
if (!fs.existsSync(voiceFile)) fs.writeFileSync(voiceFile, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
const voiceId = await upsertCred({ name: 'Voice server secret', type: 'httpHeaderAuth', data: { name: 'x-vapi-secret', value: fs.readFileSync(voiceFile, 'utf8').trim() } });
// The dashboard reads n8n's execution log with the same local API key the scripts use (credential "n8n API (local)"),
// and its page sits behind a login: user "ops", password made once into data/dashboard-password.txt.
const apiCredId = await upsertCred({ name: 'n8n API (local)', type: 'httpHeaderAuth', data: { name: 'X-N8N-API-KEY', value: KEY } });
const dashFile = path.join(root, 'data', 'dashboard-password.txt');
if (!fs.existsSync(dashFile)) fs.writeFileSync(dashFile, crypto.randomBytes(18).toString('base64url'), { mode: 0o600 });
const dashId = await upsertCred({ name: 'Dashboard login', type: 'httpBasicAuth', data: { user: 'ops', password: fs.readFileSync(dashFile, 'utf8').trim() } });
// WhatsApp: the access token the bot sends with every reply (checked by the mock Graph API), the app secret Meta signs
// each webhook with (a Crypto credential, so the HMAC check never puts it in the workflow) and the verify token for the
// one-time URL check. Made once into data/ (git-ignored); the public workflow files hold only placeholders.
const madeOnce = (file, bytes) => { const f = path.join(root, 'data', file); if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(bytes).toString('hex'), { mode: 0o600 }); return fs.readFileSync(f, 'utf8').trim(); };
const waTokenId = await upsertCred({ name: 'WhatsApp access token', type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer ' + madeOnce('whatsapp-token.txt', 32) } });
const waSecretId = await upsertCred({ name: 'WhatsApp app secret', type: 'crypto', data: { hmacSecret: madeOnce('whatsapp-app-secret.txt', 16) } });
const waVerify = madeOnce('whatsapp-verify-token.txt', 16);
const wfs = (await api('GET', '/api/v1/workflows?limit=250')).data;
const idOf = (name) => wfs.find((w) => w.name === name)?.id;
const order = ['error-handler', 'mock-crm', 'error-demo', 'chatbot-to-crm', 'ai-lead-qualify', 'support-bot-with-fallback', 'support-bot-eval', 'rag-ingest', 'rag-ask', 'rag-eval', 'guarded-agent', 'guarded-agent-approve', 'guarded-agent-eval', 'voice-agent', 'voice-eval', 'ops-uptime', 'ops-dashboard', 'invoice-extract', 'invoice-eval', 'email-triage', 'email-eval', 'mock-whatsapp', 'whatsapp-bot', 'whatsapp-eval', 'mock-sms', 'sms-stop-handler', 'review-booster', 'missed-call-text-back'];
const ids = {};
for (const name of order) {
  let txt = fs.readFileSync(path.join(root, 'workflows', name + '.json'), 'utf8');
  if (ids['error-handler']) txt = txt.replaceAll('__ERROR_WORKFLOW_ID__', ids['error-handler']);
  if (credId) txt = txt.replaceAll('__GEMINI_CRED_ID__', credId);
  txt = txt.replaceAll('__APPROVER_CRED_ID__', approverId).replaceAll('__VOICE_CRED_ID__', voiceId)
    .replaceAll('__N8N_API_CRED_ID__', apiCredId).replaceAll('__DASH_CRED_ID__', dashId)
    .replaceAll('__WA_TOKEN_CRED_ID__', waTokenId).replaceAll('__WA_SECRET_CRED_ID__', waSecretId).replaceAll('__WA_VERIFY_TOKEN__', waVerify);
  const def = JSON.parse(txt);
  if (def.settings.errorWorkflow === '__ERROR_WORKFLOW_ID__') delete def.settings.errorWorkflow;
  const existing = wfs.find((w) => w.name === name) || null;
  let wf;
  if (existing) { await api('POST', `/api/v1/workflows/${existing.id}/deactivate`).catch(() => {}); wf = await api('PUT', `/api/v1/workflows/${existing.id}`, def); }
  else wf = await api('POST', '/api/v1/workflows', def);
  ids[name] = wf.id;
  let act = 'n/a (no trigger)';
  if (!name.endsWith('-eval')) { try { await api('POST', `/api/v1/workflows/${wf.id}/activate`, {}); act = 'active'; } catch (e) { act = 'ACTIVATE FAILED: ' + e.message; } }
  console.log(name.padEnd(28), wf.id, act);
}
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'ids.json'), JSON.stringify(ids, null, 2));
