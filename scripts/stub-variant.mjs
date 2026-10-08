// Test helper: makes a throw-away copy of an AI workflow where the Gemini chain is replaced by a stub that
// returns the JSON given in the request header "x-stub-llm". Everything AFTER the AI step is the real, unchanged
// wiring, so the branches that depend on the AI answer (hot lead, answer vs. handoff, AI outage) can be tested on demand.
// Usage: node scripts/stub-variant.mjs create|delete <workflow-name> <chain-node-name>
import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
const [cmd, name, chainNode] = process.argv.slice(2);
const root = new URL('..', import.meta.url).pathname;
const KEY = execFileSync('node', [process.env.HOME + '/Projects/claude-memory/claude-config/secrets.mjs', 'get', 'N8N_LOCAL_API_KEY'], { encoding: 'utf8' }).trim();
const api = async (m, p, b) => { const r = await fetch('http://localhost:5678' + p, { method: m, headers: { 'X-N8N-API-KEY': KEY, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); if (!r.ok) throw new Error(m + ' ' + p + ' ' + r.status + ' ' + t.slice(0, 300)); return t ? JSON.parse(t) : {}; };
const stubName = name + ' [LLM STUB TEST]';
const existing = (await api('GET', '/api/v1/workflows?limit=250')).data.find((w) => w.name === stubName);
if (existing) { await api('POST', `/api/v1/workflows/${existing.id}/deactivate`).catch(() => {}); await api('DELETE', `/api/v1/workflows/${existing.id}`); }
if (cmd === 'delete') process.exit(0);
const w = JSON.parse(fs.readFileSync(root + 'workflows/' + name + '.json', 'utf8'));
w.name = stubName; delete w.settings.errorWorkflow;
const ai = new Set(['Gemini Chat Model']); for (const n of w.nodes) if (n.type.includes('outputParser')) ai.add(n.name);
w.nodes = w.nodes.filter((n) => !ai.has(n.name));
for (const k of ai) delete w.connections[k];
const chain = w.nodes.find((n) => n.name === chainNode);
// Header value "error" makes the stub fail like an AI outage; the chain keeps onError, so the real fallback runs.
chain.type = 'n8n-nodes-base.code'; chain.typeVersion = 2;
chain.parameters = { mode: 'runOnceForEachItem', jsCode: `const h = $('${w.nodes.find((n) => n.type.endsWith('webhook')).name}').first().json.headers['x-stub-llm']; if (h === 'error') throw new Error('stubbed AI outage'); return { json: { output: JSON.parse(h) } };` };
const wh = w.nodes.find((n) => n.type.endsWith('.webhook')); wh.parameters.path += '-stub'; wh.webhookId = wh.webhookId.replace(/.$/, 'f');
const created = await api('POST', '/api/v1/workflows', w);
await api('POST', `/api/v1/workflows/${created.id}/activate`, {});
await new Promise((r) => setTimeout(r, 3000)); // let the webhook register
console.log(created.id);
