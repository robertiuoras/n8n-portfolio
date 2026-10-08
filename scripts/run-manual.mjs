// Starts a workflow that has a Manual Trigger, the same way the "Execute workflow" button does.
// Usage: node scripts/run-manual.mjs <workflow-name> <trigger-node-name>
import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
const [name, trig] = process.argv.slice(2);
const root = new URL('..', import.meta.url).pathname;
const pw = execFileSync('node', [process.env.HOME + '/Projects/claude-memory/claude-config/secrets.mjs', 'get', 'N8N_LOCAL_OWNER_PASSWORD'], { encoding: 'utf8' }).trim();
const login = await fetch('http://localhost:5678/rest/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emailOrLdapLoginId: 'robertiuoras@gmail.com', password: pw }) });
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const ids = JSON.parse(fs.readFileSync(root + 'data/ids.json', 'utf8'));
const wd = (await (await fetch('http://localhost:5678/rest/workflows/' + ids[name], { headers: { cookie } })).json()).data;
const r = await fetch('http://localhost:5678/rest/workflows/' + wd.id + '/run', { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ workflowData: wd, triggerToStartFrom: { name: trig } }) });
console.log(r.status, await r.text());
