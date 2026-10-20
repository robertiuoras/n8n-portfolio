// Offline checks for the four SMS workflows (mock-sms, sms-stop-handler, review-booster, missed-call-text-back).
// Nothing here starts n8n or calls any service: it reads the generated workflow files, renders the SMS text templates,
// and runs the decision Code nodes against the sample payloads in tests/*-sample.json.
// Run: node --test tests/sms-workflows.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url).pathname;
const read = (f) => JSON.parse(fs.readFileSync(root + f, 'utf8'));
const NAMES = ['mock-sms', 'sms-stop-handler', 'review-booster', 'missed-call-text-back'];
const wf = Object.fromEntries(NAMES.map((n) => [n, read(`workflows/${n}.json`)]));
const BUSINESS = 'Gold Coast Plumbing Co (demo)';
const node = (w, name) => { const n = w.nodes.find((x) => x.name === name); assert.ok(n, `node "${name}" exists`); return n; };
const config = (w) => Object.fromEntries(node(w, 'Config').parameters.assignments.assignments.map((a) => [a.name, a.value]));
// A node without its generated ids (hashes, including the ones inside If conditions), so digits in them are not read as content.
const strip = (n) => JSON.parse(JSON.stringify(n, (k, v) => (k === 'id' && typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v)) || k === 'webhookId' ? undefined : v));
const textOf = (w) => JSON.stringify(w.nodes.map(strip));

// A fake n8n expression: "={{ ... }}" runs with $('Node').first().json answering from `ctx` (unknown fields read as "sample-<field>").
function render(expr, ctx) {
  assert.ok(expr.startsWith('={{') && expr.endsWith('}}'), 'is an expression');
  const json = (name) => new Proxy(ctx[name] || {}, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? 'sample-' + k : undefined) });
  const $ = (name) => ({ first: () => ({ json: json(name) }), all: () => [{ json: json(name) }] });
  return new vm.Script(`(${expr.slice(3, -2)})`).runInNewContext({ $, JSON, String, Number });
}
// Runs a Code node. Each-item nodes return {json}, all-items nodes an array. Same function the workflow runs.
function runCode(n, { json = {}, nodes = {}, input = [] }) {
  const $ = (name) => ({ first: () => (nodes[name] || [{ json: {} }])[0], all: () => nodes[name] || [] });
  const fn = new vm.Script(`(function($json, $, $input){ ${n.parameters.jsCode} })`).runInNewContext({ String, Number, Date, Math });
  return fn(json, $, { all: () => input, first: () => input[0] });
}

test('workflow files parse, node names are unique, every connection points at a real node', () => {
  for (const [name, w] of Object.entries(wf)) {
    assert.equal(w.name, name);
    const names = w.nodes.map((n) => n.name);
    assert.equal(new Set(names).size, names.length, `${name}: duplicate node names`);
    for (const [from, c] of Object.entries(w.connections)) {
      assert.ok(names.includes(from), `${name}: connection from unknown node ${from}`);
      for (const outs of c.main) for (const t of outs) assert.ok(names.includes(t.node), `${name}: ${from} -> unknown node ${t.node}`);
    }
    const ids = w.nodes.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length, `${name}: duplicate node ids`);
  }
});

test('the three SMS-sending workflows each have one Config node with the settings they need', () => {
  const need = {
    'review-booster': ['business_name', 'review_link', 'sender_id', 'alert_recipient', 'delay_seconds', 'sms_api_url'],
    'missed-call-text-back': ['business_name', 'sender_id', 'alert_recipient', 'sms_api_url', 'rate_limit_minutes'],
    'sms-stop-handler': ['business_name', 'sender_id', 'sms_api_url'],
  };
  for (const [name, fields] of Object.entries(need)) {
    const w = wf[name];
    assert.equal(w.nodes.filter((n) => n.name === 'Config').length, 1);
    assert.equal(node(w, 'Config').type, 'n8n-nodes-base.set');
    const c = config(w);
    for (const f of fields) assert.ok(f in c, `${name}: Config has ${f}`);
    assert.equal(c.business_name, BUSINESS);
    assert.equal(c.sms_api_url, 'http://localhost:5678/webhook/mock-sms/messages', 'defaults to the local stand-in');
  }
  assert.equal(config(wf['review-booster']).delay_seconds, 0, 'demo delay is 0');
  assert.equal(config(wf['missed-call-text-back']).rate_limit_minutes, 15);
});

test('every text sent to a customer names the business and says Reply STOP; the opt-out confirmation is the one exception', () => {
  const seen = [];
  for (const name of ['review-booster', 'missed-call-text-back', 'sms-stop-handler']) {
    const w = wf[name]; const cfg = config(w);
    const ctx = { Config: cfg, 'Check Input': { first_name: 'Jamie', phone: '+61491570006' }, 'Check Call': { caller: '+61491570156' }, 'Read Message': { phone: '+61491570110' } };
    for (const n of w.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest' && String(x.parameters.url).includes('sms_api_url'))) {
      const sent = JSON.parse(render(n.parameters.jsonBody, ctx));
      assert.deepEqual(Object.keys(sent).sort(), ['body', 'from', 'to']);
      assert.equal(sent.from, cfg.sender_id);
      assert.match(sent.to, /^\+\d{8,15}$/);
      assert.ok(sent.body.includes(BUSINESS), `${name}/${n.name}: names the business`);
      if (n.name === 'Confirm Opt-Out') { assert.ok(!/Reply STOP/.test(sent.body), 'the confirmation does not ask them to STOP again'); }
      else if (!n.name.startsWith('Alert')) assert.ok(sent.body.includes('Reply STOP to opt out.'), `${name}/${n.name}: says Reply STOP`);
      seen.push(`${name}/${n.name}`);
    }
  }
  assert.deepEqual(seen.sort(), ['missed-call-text-back/Alert Owner SMS', 'missed-call-text-back/Send Missed-Call Text', 'review-booster/Send Review SMS', 'sms-stop-handler/Confirm Opt-Out']);
  // The two example texts from the brief, word for word.
  const r = JSON.parse(render(node(wf['review-booster'], 'Send Review SMS').parameters.jsonBody, { Config: config(wf['review-booster']), 'Check Input': { first_name: 'Jamie', phone: '+61491570006' } }));
  assert.equal(r.body, `Hi Jamie, thanks for choosing ${BUSINESS}. Would you leave us a quick Google review? ${config(wf['review-booster']).review_link} Reply STOP to opt out.`);
  const m = JSON.parse(render(node(wf['missed-call-text-back'], 'Send Missed-Call Text').parameters.jsonBody, { Config: config(wf['missed-call-text-back']), 'Check Call': { caller: '+61491570156' } }));
  assert.equal(m.body, `Hi, it's ${BUSINESS}. Sorry we missed your call. Reply here with what you need and we'll get back to you shortly. Reply STOP to opt out.`);
});

test('review-booster asks every customer: nothing in it can filter by rating, score, sentiment or mood', () => {
  const w = wf['review-booster'];
  const hit = /rating|rate\b|score|sentiment|happy|unhappy|satisf|stars?\b|nps|feedback|mood|positive|negative/i;
  const body = JSON.stringify({ name: w.name, nodes: w.nodes.map(strip), connections: w.connections, settings: w.settings });
  assert.equal(body.match(hit), null, 'forbidden word: ' + (body.match(hit) || [])[0]);
  const notes = w.nodes.filter((n) => n.type === 'n8n-nodes-base.stickyNote');
  assert.ok(notes.some((n) => /every customer is asked/i.test(n.parameters.content) && /google/i.test(n.parameters.content)), 'sticky note says every customer is asked');
  const sendPath = ['Send Review SMS', 'Send Review Email'];
  const ifs = w.nodes.filter((n) => n.type === 'n8n-nodes-base.if').map((n) => n.name);
  assert.deepEqual(ifs.sort(), ['Has Mobile?', 'Is Duplicate?', 'Opted Out?', 'Valid?'], 'the only decisions are: valid, duplicate, opted out, which channel');
  assert.ok(sendPath.every((n) => node(w, n)));
});

test('no credential ids, keys, tokens or real-looking phone numbers anywhere in the four workflows or samples', () => {
  const MOBILES = ['0491570006', '0491570156', '0491570157', '0491570158', '0491570159', '0491570110', '0491570313', '0491570737'];
  const allowed = (digitsOnly) => {
    const d = digitsOnly.replace(/^\+/, '');
    const local = d.startsWith('61') ? '0' + d.slice(2) : d;
    return MOBILES.includes(local) || /^075550\d{4}$/.test(local);
  };
  const files = [...NAMES.map((n) => `workflows/${n}.json`), 'tests/review-booster-sample.json', 'tests/missed-call-sample.json', 'tests/sms-stop-sample.json'];
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(root + f, 'utf8'));
    const text = f.startsWith('workflows/') ? textOf(raw) : JSON.stringify(raw);
    for (const m of text.matchAll(/\+?\d[\d\s().-]{7,}\d/g)) {
      const d = m[0].replace(/\D/g, '');
      if (d.length < 9) continue;
      assert.ok(allowed(d), `${f}: "${m[0]}" is a phone-shaped number outside the fictional ranges`);
    }
    assert.equal(text.match(/\b(sk|pk|rk)[-_][A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[bpas]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s+[A-Za-z0-9._-]{12,}|[A-Fa-f0-9]{32,}/), null, `${f}: looks like a key or token`);
    assert.equal(text.match(/api[_-]?key|secret|password|authorization/i), null, `${f}: mentions a secret field`);
    assert.equal(text.match(/@(?!example\.com)[a-z0-9-]+\.[a-z]{2,}/i), null, `${f}: email outside example.com`);
  }
  for (const w of Object.values(wf)) for (const n of w.nodes) for (const [type, c] of Object.entries(n.credentials || {})) {
    assert.ok(!('id' in c), `${w.name}/${n.name}: credential ${type} has an id`);
    assert.match(c.name, /replace me/i, 'placeholder credential name');
  }
  assert.ok(wf['review-booster'].nodes.some((n) => n.credentials?.smtp), 'the email node carries a placeholder credential');
});

test('mock-sms stores the message and sends nothing: no outbound HTTP, email or SMS node', () => {
  const w = wf['mock-sms'];
  assert.deepEqual(w.nodes.filter((n) => /httpRequest|emailSend/.test(n.type)), []);
  const save = node(w, 'Save To Outbox');
  assert.equal(save.type, 'n8n-nodes-base.dataTable');
  assert.equal(save.parameters.dataTableId.value, 'sms_outbox');
  assert.equal(node(w, 'Send SMS').parameters.path, 'mock-sms/messages');
});

test('webhooks, tables and the checks both workflows share', () => {
  assert.equal(node(wf['review-booster'], 'Job Completed').parameters.path, 'review-booster/job-completed');
  assert.equal(node(wf['missed-call-text-back'], 'Missed Call').parameters.path, 'missed-call/callback');
  assert.equal(node(wf['sms-stop-handler'], 'Inbound SMS').parameters.path, 'sms-inbound/messages');
  const tablesOf = (w) => w.nodes.filter((n) => n.type === 'n8n-nodes-base.dataTable').map((n) => n.parameters.dataTableId.value);
  assert.ok(tablesOf(wf['review-booster']).includes('sms_optout') && tablesOf(wf['review-booster']).includes('review_requests'));
  for (const t of ['sms_optout', 'sms_never_text', 'missed_call_log', 'leads']) assert.ok(tablesOf(wf['missed-call-text-back']).includes(t), t);
  assert.ok(tablesOf(wf['sms-stop-handler']).includes('sms_optout'));
  // setup.mjs creates every table these use and imports every workflow
  const setup = fs.readFileSync(root + 'scripts/setup.mjs', 'utf8');
  for (const w of Object.values(wf)) for (const t of tablesOf(w)) assert.ok(setup.includes(`${t}: {`), `setup.mjs creates ${t}`);
  for (const n of NAMES) assert.ok(setup.includes(`'${n}'`), `setup.mjs imports ${n}`);
});

const cases = (file) => read(file).cases;
test('review-booster Check Input against the sample payloads', () => {
  const n = node(wf['review-booster'], 'Check Input');
  for (const c of cases('tests/review-booster-sample.json')) {
    const r = runCode(n, { json: { body: c.body } }).json;
    assert.equal(r.ok, c.expect.ok, c.name);
    if (c.expect.ok) { assert.equal(r.channel, c.expect.channel, c.name); assert.equal(r.phone, c.expect.phone, c.name); }
    else assert.ok(r.errors.join('; ').includes(c.expect.reason_contains), `${c.name}: ${r.errors}`);
  }
});

test('missed-call Check Call against the sample payloads', () => {
  const n = node(wf['missed-call-text-back'], 'Check Call');
  for (const c of cases('tests/missed-call-sample.json')) {
    const r = runCode(n, { json: { body: c.body } }).json;
    assert.equal(r.ok, c.expect.ok, c.name);
    if (!c.expect.ok) { assert.ok(r.errors.join('; ').includes(c.expect.reason_contains), `${c.name}: ${r.errors}`); continue; }
    for (const k of ['action', 'caller', 'is_mobile', 'reason']) if (k in c.expect) assert.equal(r[k], c.expect[k], `${c.name}: ${k}`);
  }
});

test('missed-call Decide: never-text list, STOP list and one text per caller per 15 minutes', () => {
  const n = node(wf['missed-call-text-back'], 'Decide');
  for (const c of read('tests/missed-call-sample.json').decide_cases) {
    const nodes = { 'Check Call': [{ json: { caller: c.caller, called_at: c.called_at } }], 'Never-Text Lookup': c.never_text.map((json) => ({ json })), 'Opt-Out Lookup': c.stop_list.map((json) => ({ json })),
      Config: [{ json: config(wf['missed-call-text-back']) }] };
    const r = runCode(n, { nodes, input: c.recent.map((json) => ({ json })) })[0].json;
    assert.equal(r.suppress, c.expect.suppress, c.name);
    if (c.expect.reason) assert.equal(r.reason, c.expect.reason, c.name);
  }
});

test('sms-stop-handler Read Message recognises STOP, UNSUBSCRIBE, CANCEL, END, QUIT, STOPALL in any case, and nothing else', () => {
  const n = node(wf['sms-stop-handler'], 'Read Message');
  for (const c of cases('tests/sms-stop-sample.json')) {
    const r = runCode(n, { json: { body: c.body } }).json;
    assert.equal(r.ok, c.expect.ok, c.name);
    if (!c.expect.ok) { assert.ok(r.errors.join('; ').includes(c.expect.reason_contains), c.name); continue; }
    assert.equal(r.is_stop, c.expect.is_stop, c.name);
    if (c.expect.phone) assert.equal(r.phone, c.expect.phone, c.name);
  }
});
