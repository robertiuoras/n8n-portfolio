// Generates workflows/*.json. Run: node scripts/gen-workflows.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './lib.mjs';
const { WF, webhook, respond, code, iff, sw, dtGet, dtGetAll, dtDelete, dtInsert, dtUpdate, httpReq, wait, geminiModel, parser, chain, retryBlock, BASE, EMBED_MODEL, EMBED_DIMS, EMBED_URL } = L;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = (file, w) => fs.writeFileSync(path.join(root, 'workflows', file), JSON.stringify(w.json(), null, 2) + '\n');
const NOW = '={{ $now.toISO() }}';
const J = (o) => `={{ JSON.stringify(${o}) }}`;
const faq = JSON.parse(fs.readFileSync(path.join(root, 'faq.json'), 'utf8'));
const evalSet = JSON.parse(fs.readFileSync(path.join(root, 'tests/support-eval.json'), 'utf8'));
const ragEvalSet = JSON.parse(fs.readFileSync(path.join(root, 'tests/rag-eval.json'), 'utf8'));
const ERR_WF = '__ERROR_WORKFLOW_ID__';

// ---------- 0. error handler ----------
{
  const w = new WF('error-handler');
  w.add({ name: 'Error Trigger', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, parameters: {} });
  w.add(dtInsert('Log Error', 'workflow_errors', {
    workflow_name: '={{ $json.workflow.name }}', node: '={{ $json.execution.lastNodeExecuted }}',
    message: '={{ $json.execution.error.message }}', execution_id: '={{ $json.execution.id }}', at: NOW }));
  w.link('Error Trigger', 'Log Error');
  out('error-handler.json', w);
}
// ---------- 0b. error demo (proves #error-handler fires) ----------
{
  const w = new WF('error-demo', { errorWorkflow: ERR_WF });
  w.add({ ...webhook('Trigger', 'GET', 'error-demo'), parameters: { httpMethod: 'GET', path: 'error-demo', responseMode: 'onReceived', options: {} } });
  w.add(code('Always Fails', `throw new Error('Deliberate demo failure: this is how an unexpected crash is caught and logged');`));
  w.link('Trigger', 'Always Fails');
  out('error-demo.json', w);
}

// ---------- mock CRM ----------
{
  const w = new WF('mock-crm');
  // POST upsert
  w.add(webhook('POST Contact', 'POST', 'mock-crm/contacts'), [0, 0]);
  w.add(dtGet('Fail History', 'mock_crm_log', { email: '={{ $json.body.email }}', outcome: 'injected_500x2' }), [260, 0]);
  w.add(code('Decide', `
const req = $('POST Contact').first().json;
const b = req.body || {};
const fail = String(req.headers['x-fail'] || '').toLowerCase();
const prior = $input.all().filter(i => i.json.id !== undefined && i.json.id !== null).length;
let mode = 'ok', message = '';
if (!b.email || typeof b.email !== 'string') { mode = 'bad_request'; message = 'email is required'; }
else if (fail === '500') mode = '500';
else if (fail === '429') mode = '429';
else if (fail === '400') mode = '400';
else if (fail === 'timeout') mode = 'timeout';
else if (fail === '500x2') mode = prior < 2 ? '500x2_fail' : 'ok';
return [{ json: { mode, message, prior_500x2_failures: prior, x_fail: fail, email: (b.email || '').toLowerCase(), contact: b } }];`, 'runOnceForAllItems'), [520, 0]);
  w.add(dtInsert('Log Call', 'mock_crm_log', {
    email: '={{ $json.email }}', method: 'POST', x_fail: '={{ $json.x_fail }}',
    outcome: `={{ $json.mode === '500x2_fail' ? 'injected_500x2' : ($json.mode === 'ok' ? 'ok' : 'injected_' + $json.mode) }}`, at: NOW }), [780, 0]);
  const modes = ['ok', '500', '429', '400', 'timeout', '500x2_fail', 'bad_request'];
  w.add(sw('Route', modes, `$('Decide').first().json.mode`), [1040, 0]);
  w.add(respond('Respond 500', J(`{ error: 'injected server error (x-fail)' }`), 500), [1300, 100]);
  w.add(respond('Respond 429', J(`{ error: 'injected rate limit (x-fail)' }`), 429), [1300, 260]);
  w.add(respond('Respond 400', J(`{ error: 'injected bad request (x-fail)' }`), 400), [1300, 420]);
  w.add(wait('Stall 15s', 15), [1300, 580]);
  w.add(respond('Respond Late', J(`{ late: true, note: 'answered after the caller gave up' }`), 200), [1560, 580]);
  w.add(respond('Respond Bad Input', J(`{ error: $('Decide').first().json.message }`), 400), [1300, 720]);
  w.add(dtGet('Find Contact', 'mock_crm_contacts', { email: `={{ $('Decide').first().json.email }}` }), [1300, -120]);
  w.add(iff('Exists?', `={{ $json.id !== undefined && $json.id !== null }}`), [1560, -120]);
  const c = (k) => `={{ $('Decide').first().json.contact.${k} ?? '' }}`;
  const common = { name: c('name'), phone: c('phone'), company: c('company'), summary: c('summary'), extra: `={{ JSON.stringify($('Decide').first().json.contact) }}` };
  w.add(dtUpdate('Update Contact', 'mock_crm_contacts', { email: `={{ $('Decide').first().json.email }}` },
    { ...common, updated_at: NOW, version: `={{ ($('Find Contact').first().json.version || 1) + 1 }}` }), [1820, -240]);
  w.add(dtInsert('Create Contact', 'mock_crm_contacts', { email: `={{ $('Decide').first().json.email }}`, ...common, created_at: NOW, updated_at: NOW, version: 1 }), [1820, 0]);
  w.add(respond('Respond Updated', J(`{ id: $('Find Contact').first().json.id, action: 'updated', version: ($('Find Contact').first().json.version || 1) + 1 }`)), [2080, -240]);
  w.add(respond('Respond Created', J(`{ id: $('Create Contact').first().json.id, action: 'created', version: 1 }`)), [2080, 0]);
  w.link('POST Contact', 'Fail History'); w.link('Fail History', 'Decide'); w.link('Decide', 'Log Call'); w.link('Log Call', 'Route');
  w.link('Route', 'Find Contact', { out: 0 });
  w.link('Route', 'Respond 500', { out: 1 }); w.link('Route', 'Respond 429', { out: 2 }); w.link('Route', 'Respond 400', { out: 3 });
  w.link('Route', 'Stall 15s', { out: 4 }); w.link('Stall 15s', 'Respond Late');
  w.link('Route', 'Respond 500', { out: 5 }); w.link('Route', 'Respond Bad Input', { out: 6 });
  w.link('Find Contact', 'Exists?'); w.link('Exists?', 'Update Contact', { out: 0 }); w.link('Exists?', 'Create Contact', { out: 1 });
  w.link('Update Contact', 'Respond Updated'); w.link('Create Contact', 'Respond Created');
  // GET lookup
  w.add(webhook('GET Contact', 'GET', 'mock-crm/contacts'), [0, 960]);
  w.add(dtGet('Lookup', 'mock_crm_contacts', { email: `={{ String($json.query.email || '').toLowerCase() }}` }), [260, 960]);
  w.add(iff('Found?', `={{ $json.id !== undefined && $json.id !== null }}`), [520, 960]);
  w.add(respond('Respond Found', J(`{ found: true, contact: { id: $json.id, email: $json.email, name: $json.name, company: $json.company, version: $json.version } }`)), [780, 900]);
  w.add(respond('Respond Not Found', J(`{ found: false }`), 404), [780, 1040]);
  w.link('GET Contact', 'Lookup'); w.link('Lookup', 'Found?'); w.link('Found?', 'Respond Found', { out: 0 }); w.link('Found?', 'Respond Not Found', { out: 1 });
  out('mock-crm.json', w);
}

// ---------- 1. chatbot-to-crm ----------
{
  const w = new WF('chatbot-to-crm', { errorWorkflow: ERR_WF });
  w.add(webhook('Chatbot Summary', 'POST', 'chatbot-summary'), [0, 300]);
  w.add(code('Validate', `
const b = $json.body || {};
const errs = [];
if (!b.conversation_id || typeof b.conversation_id !== 'string') errs.push('conversation_id is required');
if (typeof b.approved !== 'boolean') errs.push('approved must be true or false');
const c = b.customer || {};
if (!c.email || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(String(c.email))) errs.push('customer.email is missing or not a valid email');
if (!c.name) errs.push('customer.name is required');
if (!b.summary) errs.push('summary is required');
if (!b.request_type) errs.push('request_type is required');
return { json: { valid: errs.length === 0, errors: errs, approved: b.approved === true, body: b, xfail: String($json.headers['x-fail'] || '') } };`), [260, 300]);
  w.add(iff('Valid?', '={{ $json.valid }}'), [520, 300]);
  w.add(respond('Respond 400', J(`{ status: 'rejected', reasons: $('Validate').first().json.errors }`), 400), [780, 460]);
  w.add(iff('Approved?', '={{ $json.approved }}'), [780, 300]);
  w.add(respond('Respond Ignored', J(`{ status: 'ignored', reason: 'summary not approved, nothing sent to the CRM' }`), 202), [1040, 460]);
  w.add({ name: 'Make Key', type: 'n8n-nodes-base.crypto', typeVersion: 2, parameters: { action: 'hash', type: 'SHA256', value: `={{ $json.body.conversation_id + $json.body.customer.email.toLowerCase() }}`, dataPropertyName: 'key', encoding: 'hex' } }, [1040, 300]);
  w.add(dtGet('Already Sent?', 'crm_sent', { key: '={{ $json.key }}' }), [1300, 300]);
  w.add(iff('Is Duplicate?', `={{ $json.id !== undefined && $json.id !== null }}`), [1560, 300]);
  w.add(respond('Respond Duplicate', J(`{ status: 'duplicate', key: $('Make Key').first().json.key }`)), [1820, 160]);
  w.add(httpReq('CRM Lookup', 'GET', `${BASE}/webhook/mock-crm/contacts`, { query: { email: `={{ $('Make Key').first().json.body.customer.email.toLowerCase() }}` } }), [1820, 400]);
  w.add(code('Prepare', `
const v = $('Validate').first().json; const b = v.body; const c = b.customer;
const exists = $json.statusCode === 200 && $json.body && $json.body.found === true;
return { json: { exists, lookup_status: $json.statusCode ?? null, key: $('Make Key').first().json.key, xfail: v.xfail,
  payload: { email: c.email.toLowerCase(), name: c.name, phone: c.phone || '', company: c.company || '', summary: b.summary, request_type: b.request_type, conversation_id: b.conversation_id } } };`), [2080, 400]);
  retryBlock(w, { upsertName: 'CRM Upsert', classifyName: 'Classify Result', routeName: 'Outcome', waitName: 'Backoff Wait',
    payloadExpr: `={{ JSON.stringify($('Prepare').first().json.payload) }}`, xfailExpr: `={{ $('Prepare').first().json.xfail }}` });
  w.add(dtInsert('Remember Sent', 'crm_sent', { key: `={{ $('Prepare').first().json.key }}`, conversation_id: `={{ $('Validate').first().json.body.conversation_id }}`,
    crm_action: `={{ $('Classify Result').first().json.crm?.action ?? '' }}`, crm_id: `={{ $('Classify Result').first().json.crm?.id ?? 0 }}`, at: NOW }));
  w.add(respond('Respond Synced', J(`{ status: 'synced', crm_action: $('Classify Result').first().json.crm.action, crm_id: $('Classify Result').first().json.crm.id, attempts: $('Classify Result').last().json.attempt, existed_before: $('Prepare').first().json.exists }`)));
  w.add(dtInsert('Log Failure', 'crm_errors', { key: `={{ $('Prepare').first().json.key }}`, step: `={{ $json.step }}`, http_status: `={{ $json.status ?? 0 }}`,
    error: `={{ $json.error }}`, payload: `={{ JSON.stringify($('Prepare').first().json.payload) }}`, at: NOW }));
  w.add(respond('Respond 502', J(`{ status: 'failed', reason: 'The CRM could not be updated (' + $('Classify Result').last().json.error + '). The summary was saved to the error log for follow-up.', attempts: $('Classify Result').last().json.attempt }`), 502));
  w.link('Chatbot Summary', 'Validate'); w.link('Validate', 'Valid?'); w.link('Valid?', 'Approved?', { out: 0 }); w.link('Valid?', 'Respond 400', { out: 1 });
  w.link('Approved?', 'Make Key', { out: 0 }); w.link('Approved?', 'Respond Ignored', { out: 1 });
  w.link('Make Key', 'Already Sent?'); w.link('Already Sent?', 'Is Duplicate?');
  w.link('Is Duplicate?', 'Respond Duplicate', { out: 0 }); w.link('Is Duplicate?', 'CRM Lookup', { out: 1 });
  w.link('CRM Lookup', 'Prepare'); w.link('Prepare', 'CRM Upsert');
  w.link('Outcome', 'Remember Sent', { out: 0 }); w.link('Remember Sent', 'Respond Synced');
  w.link('Outcome', 'Log Failure', { out: 2 }); w.link('Log Failure', 'Respond 502');
  // layout tidy
  const pos = { 'CRM Upsert': [2340, 400], 'Classify Result': [2600, 400], 'Outcome': [2860, 400], 'Backoff Wait': [2600, 620], 'Remember Sent': [3120, 300], 'Respond Synced': [3380, 300], 'Log Failure': [3120, 520], 'Respond 502': [3380, 520] };
  for (const n of w.nodes) if (pos[n.name]) n.position = pos[n.name];
  out('chatbot-to-crm.json', w);
}

// ---------- 2. ai-lead-qualify ----------
{
  const w = new WF('ai-lead-qualify', { errorWorkflow: ERR_WF });
  w.add(webhook('Lead', 'POST', 'lead'), [0, 300]);
  w.add(code('Validate', `
const b = $json.body || {}; const errs = [];
if (!b.name) errs.push('name is required');
if (!b.email || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(String(b.email))) errs.push('email is missing or not valid');
if (!b.message || String(b.message).length < 3) errs.push('message is required');
return { json: { valid: errs.length === 0, errors: errs, body: b, xfail: String($json.headers['x-fail'] || '') } };`), [260, 300]);
  w.add(iff('Valid?', '={{ $json.valid }}'), [520, 300]);
  w.add(respond('Respond 400', J(`{ status: 'rejected', reasons: $('Validate').first().json.errors }`), 400), [520, 520]);
  w.add(chain('Qualify Lead',
    `=Lead name: {{ $json.body.name }}\nSource: {{ $json.body.source || 'unknown' }}\nMessage:\n{{ $json.body.message }}`,
    `You qualify inbound sales leads for a small business. Read the message and return only the requested fields. intent: one short phrase. budget_mentioned: the budget as written, or null if none. urgency: low, medium or high, based only on what the person says. score: 0 to 100, how likely this is a real, ready-to-buy lead (100 = clear need, budget and timeline). summary: one sentence. needs_human: true if the message is unclear, abusive, off-topic, or you are not confident. Never invent facts.`), [780, 300]);
  w.add(geminiModel('Gemini Chat Model'), [740, 560]);
  w.add(parser('Lead Fields', { type: 'object', properties: {
    intent: { type: 'string' }, budget_mentioned: { type: ['string', 'null'] }, urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
    score: { type: 'number', minimum: 0, maximum: 100 }, summary: { type: 'string' }, needs_human: { type: 'boolean' } },
    required: ['intent', 'budget_mentioned', 'urgency', 'score', 'summary', 'needs_human'] }), [900, 560]);
  w.link('Gemini Chat Model', 'Qualify Lead', { type: 'ai_languageModel' });
  w.link('Lead Fields', 'Qualify Lead', { type: 'ai_outputParser' });
  w.add(code('Check AI Answer', `
const v = $('Validate').first().json; const lead = v.body;
let o = $json.output; let reason = '';
const okShape = o && typeof o === 'object' && ['low','medium','high'].includes(o.urgency) && typeof o.score === 'number' && o.score >= 0 && o.score <= 100 && typeof o.intent === 'string' && typeof o.summary === 'string' && typeof o.needs_human === 'boolean';
if ($json.error) reason = 'ai_unavailable: ' + (typeof $json.error === 'string' ? $json.error : ($json.error.message || 'error'));
else if (!okShape) reason = 'ai_output_unusable';
let fallback = !!reason;
if (fallback) o = { intent: 'unknown', budget_mentioned: null, urgency: 'medium', score: 0, summary: String(lead.message).slice(0, 200), needs_human: true };
return { json: { fallback, reason, qualification: o, xfail: v.xfail,
  payload: { email: lead.email.toLowerCase(), name: lead.name, phone: '', company: '', summary: o.summary, source: lead.source || '', qualification: o } } };`), [1240, 300]);
  retryBlock(w, { upsertName: 'CRM Upsert', classifyName: 'Classify Result', routeName: 'Outcome', waitName: 'Backoff Wait',
    payloadExpr: `={{ JSON.stringify($('Check AI Answer').first().json.payload) }}`, xfailExpr: `={{ $('Check AI Answer').first().json.xfail }}` });
  w.add(iff('Hot Lead?', `={{ $('Check AI Answer').first().json.qualification.score >= 70 }}`));
  w.add(dtInsert('Notify Team', 'notifications', { kind: 'hot_lead', name: `={{ $('Validate').first().json.body.name }}`, email: `={{ $('Validate').first().json.body.email }}`,
    score: `={{ $('Check AI Answer').first().json.qualification.score }}`, summary: `={{ $('Check AI Answer').first().json.qualification.summary }}`, at: NOW }));
  w.add(respond('Respond OK', J(`{ status: 'processed', qualification: $('Check AI Answer').first().json.qualification, used_fallback: $('Check AI Answer').first().json.fallback, fallback_reason: $('Check AI Answer').first().json.reason, crm_action: $('Classify Result').last().json.crm.action, crm_id: $('Classify Result').last().json.crm.id, hot_lead_notified: $('Check AI Answer').first().json.qualification.score >= 70 }`)));
  w.add(dtInsert('Log Failure', 'crm_errors', { key: `={{ 'lead:' + $('Validate').first().json.body.email.toLowerCase() }}`, step: `={{ $json.step }}`, http_status: `={{ $json.status ?? 0 }}`,
    error: `={{ $json.error }}`, payload: `={{ JSON.stringify($('Check AI Answer').first().json.payload) }}`, at: NOW }));
  w.add(respond('Respond 502', J(`{ status: 'failed', reason: 'The lead was scored but the CRM could not be updated (' + $('Classify Result').last().json.error + '). Saved to the error log.' }`), 502));
  w.link('Lead', 'Validate'); w.link('Validate', 'Valid?'); w.link('Valid?', 'Qualify Lead', { out: 0 }); w.link('Valid?', 'Respond 400', { out: 1 });
  w.link('Qualify Lead', 'Check AI Answer'); w.link('Check AI Answer', 'CRM Upsert');
  w.link('Outcome', 'Hot Lead?', { out: 0 }); w.link('Hot Lead?', 'Notify Team', { out: 0 }); w.link('Hot Lead?', 'Respond OK', { out: 1 }); w.link('Notify Team', 'Respond OK');
  w.link('Outcome', 'Log Failure', { out: 2 }); w.link('Log Failure', 'Respond 502');
  const pos = { 'CRM Upsert': [1500, 300], 'Classify Result': [1760, 300], 'Outcome': [2020, 300], 'Backoff Wait': [1760, 520], 'Hot Lead?': [2280, 220], 'Notify Team': [2540, 140], 'Respond OK': [2800, 220], 'Log Failure': [2280, 460], 'Respond 502': [2540, 460] };
  for (const n of w.nodes) if (pos[n.name]) n.position = pos[n.name];
  out('ai-lead-qualify.json', w);
}

// ---------- 3. support-bot-with-fallback ----------
{
  const w = new WF('support-bot-with-fallback', { errorWorkflow: ERR_WF });
  w.add(webhook('Support Question', 'POST', 'support'), [0, 300]);
  w.add(code('Validate', `
const q = ($json.body || {}).question;
const errs = [];
if (!q || typeof q !== 'string' || q.trim().length < 3) errs.push('question is required');
else if (q.length > 500) errs.push('question must be 500 characters or fewer');
return { json: { valid: errs.length === 0, errors: errs, question: typeof q === 'string' ? q.trim() : '' } };`), [260, 300]);
  w.add(iff('Valid?', '={{ $json.valid }}'), [520, 300]);
  w.add(respond('Respond 400', J(`{ answered: false, reasons: $('Validate').first().json.errors }`), 400), [520, 520]);
  const faqText = faq.map((f) => `[${f.id}] Q: ${f.q}\nA: ${f.a}`).join('\n');
  w.add(chain('Answer From FAQ', `=Customer question: {{ $json.question }}`,
    `You are the support assistant for Acme Solar, a fictional home-solar installer. Answer ONLY using the FAQ below. If the FAQ does not clearly contain the answer, set supported=false, confidence low, and leave source_faq_ids empty. Never use outside knowledge. When supported, answer in one or two plain sentences and list the FAQ ids you used. confidence is 0 to 1.\n\nFAQ:\n${faqText}`), [780, 300]);
  w.add(geminiModel('Gemini Chat Model'), [740, 560]);
  w.add(parser('Answer Fields', { type: 'object', properties: {
    answer: { type: 'string' }, supported: { type: 'boolean' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, source_faq_ids: { type: 'array', items: { type: 'string' } } },
    required: ['answer', 'supported', 'confidence', 'source_faq_ids'] }), [900, 560]);
  w.link('Gemini Chat Model', 'Answer From FAQ', { type: 'ai_languageModel' });
  w.link('Answer Fields', 'Answer From FAQ', { type: 'ai_outputParser' });
  w.add(code('Decide', `
const ids = ${JSON.stringify(faq.map((f) => f.id))};
const question = $('Validate').first().json.question;
const o = $json.output; let reason = '';
const shape = o && typeof o === 'object' && typeof o.answer === 'string' && typeof o.supported === 'boolean' && typeof o.confidence === 'number' && Array.isArray(o.source_faq_ids);
if ($json.error) reason = 'ai_unavailable';
else if (!shape) reason = 'ai_output_unusable';
else if (!o.supported) reason = 'not_in_faq';
else if (o.confidence < 0.6) reason = 'low_confidence';
else if (o.source_faq_ids.length === 0 || !o.source_faq_ids.every(i => ids.includes(i))) reason = 'no_valid_source';
const answered = reason === '';
return { json: { answered, reason: answered ? 'answered' : reason, question,
  answer: answered ? o.answer : "I can't answer that reliably. I've passed your question to our team and they will reply by email.",
  confidence: shape ? o.confidence : 0, sources: answered ? o.source_faq_ids : [] } };`), [1240, 300]);
  w.add(iff('Answered?', '={{ $json.answered }}'), [1500, 300]);
  w.add(respond('Respond Answer', J(`{ answered: true, answer: $json.answer, sources: $json.sources, confidence: $json.confidence }`)), [1760, 220]);
  w.add(dtInsert('Create Handoff', 'handoffs', { question: '={{ $json.question }}', reason: '={{ $json.reason }}', confidence: '={{ $json.confidence }}', at: NOW }), [1760, 420]);
  w.add(respond('Respond Handoff', J(`{ answered: false, handoff: true, reason: $('Decide').first().json.reason, message: $('Decide').first().json.answer }`)), [2020, 420]);
  w.link('Support Question', 'Validate'); w.link('Validate', 'Valid?'); w.link('Valid?', 'Answer From FAQ', { out: 0 }); w.link('Valid?', 'Respond 400', { out: 1 });
  w.link('Answer From FAQ', 'Decide'); w.link('Decide', 'Answered?'); w.link('Answered?', 'Respond Answer', { out: 0 }); w.link('Answered?', 'Create Handoff', { out: 1 });
  w.link('Create Handoff', 'Respond Handoff');
  out('support-bot-with-fallback.json', w);
}

// ---------- 3b. support eval ----------
{
  const w = new WF('support-bot-eval', { errorWorkflow: ERR_WF });
  w.add({ name: 'Run Eval', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }, [0, 300]);
  w.add(code('Test Set', `return ${JSON.stringify(evalSet)}.map((t, i) => ({ json: { n: i + 1, ...t } }));`, 'runOnceForAllItems'), [260, 300]);
  // One question every 8 s keeps the eval under the Gemini free tier's per-minute limit (6 s still drew rate limits).
  w.add(httpReq('Ask Bot', 'POST', `${BASE}/webhook/support`, { body: `={{ JSON.stringify({ question: $json.q }) }}`, timeout: 60000, batch: { batchSize: 1, batchInterval: 8000 } }), [520, 300]);
  w.add(code('Score', `
const tests = $('Test Set').all().map(i => i.json);
const res = $input.all().map(i => i.json);
let correct = 0, refusedRight = 0, wrong = 0, missed = 0, aiDown = 0; const details = [];
tests.forEach((t, i) => {
  const r = (res[i] && res[i].body) || {};
  const answered = r.answered === true;
  if (r.reason === 'ai_unavailable' || r.reason === 'ai_output_unusable') aiDown++;
  let verdict;
  if (t.answerable) {
    if (!answered) { missed++; verdict = 'missed (refused)'; }
    else if ((r.sources || []).includes(t.expect_faq)) { correct++; verdict = 'correct'; }
    else { wrong++; verdict = 'wrong source'; }
  } else {
    if (!answered) { refusedRight++; verdict = 'correct refusal'; } else { wrong++; verdict = 'WRONG: answered unanswerable'; }
  }
  details.push({ n: t.n, q: t.q, verdict, reason: r.reason || null });
});
const answerable = tests.filter(t => t.answerable).length, unanswerable = tests.length - answerable;
return [{ json: { run_at: new Date().toISOString(), total: tests.length, answerable, unanswerable,
  accuracy: Math.round(((correct + refusedRight) / tests.length) * 1000) / 1000,
  correct_refusal_rate: Math.round((refusedRight / unanswerable) * 1000) / 1000,
  wrong_answers: wrong, missed_answers: missed, ai_unavailable: aiDown, details: JSON.stringify(details) } }];`, 'runOnceForAllItems'), [780, 300]);
  w.add(dtInsert('Save Run', 'eval_runs', Object.fromEntries(['run_at', 'total', 'answerable', 'unanswerable', 'accuracy', 'correct_refusal_rate', 'wrong_answers', 'missed_answers', 'ai_unavailable', 'details'].map((k) => [k, `={{ $json.${k} }}`]))), [1040, 300]);
  w.link('Run Eval', 'Test Set'); w.link('Test Set', 'Ask Bot'); w.link('Ask Bot', 'Score'); w.link('Score', 'Save Run');
  out('support-bot-eval.json', w);
}
// ---------- 4. rag-docs: ingest ----------
// POST { doc_id, title, text } (markdown). Splits on "## " headings, embeds every chunk, and only when ALL chunks
// embedded does it replace that document's old chunks, so a failed re-ingest never leaves a half-empty index.
{
  const w = new WF('rag-ingest', { errorWorkflow: ERR_WF });
  w.add(webhook('Document', 'POST', 'rag/ingest'), [0, 300]);
  w.add(code('Validate', `
const b = $json.body || {}; const errs = [];
if (typeof b.doc_id !== 'string' || !/^[a-z0-9-]{2,60}$/.test(b.doc_id)) errs.push('doc_id is required: 2-60 lowercase letters, digits or dashes');
if (typeof b.title !== 'string' || !b.title.trim()) errs.push('title is required');
if (typeof b.text !== 'string' || b.text.trim().length < 20) errs.push('text is required (the document in markdown)');
else if (b.text.length > 100000) errs.push('text must be 100,000 characters or fewer');
return { json: { valid: errs.length === 0, errors: errs, doc_id: b.doc_id, title: (b.title || '').trim(), text: b.text } };`), [260, 300]);
  w.add(iff('Valid?', '={{ $json.valid }}'), [520, 300]);
  w.add(respond('Respond 400', J(`{ status: 'rejected', reasons: $('Validate').first().json.errors }`), 400), [520, 520]);
  w.add(code('Chunk', `
const { doc_id, title, text } = $('Validate').first().json;
const MAX = 1500; // characters per chunk; a longer section is split between paragraphs
const sections = []; let cur = { section: 'Introduction', lines: [] };
for (const line of text.split('\\n')) {
  const m = line.match(/^##\\s+(.*)/);
  if (m) { if (cur.lines.join('').trim()) sections.push(cur); cur = { section: m[1].trim(), lines: [] }; }
  else if (!/^#\\s/.test(line)) cur.lines.push(line);
}
if (cur.lines.join('').trim()) sections.push(cur);
const chunks = [];
for (const s of sections) {
  let buf = '';
  // Gemini silently cuts off long input instead of failing, so a paragraph longer than MAX is split by sentence.
  const pieces = s.lines.join('\\n').split(/\\n\\s*\\n/).map((x) => x.trim()).filter(Boolean)
    .flatMap((p) => p.length <= MAX ? [p] : (p.match(/[^.!?]+[.!?]*\\s*/g) || [p]).flatMap((x) => x.match(new RegExp('[\\\\s\\\\S]{1,' + MAX + '}', 'g'))));
  for (const p of pieces) {
    if (buf && buf.length + p.length > MAX) { chunks.push({ section: s.section, body: buf }); buf = ''; }
    buf += (buf ? '\\n\\n' : '') + p;
  }
  if (buf) chunks.push({ section: s.section, body: buf });
}
return chunks.map((c, i) => ({ json: { chunk_id: doc_id + '#' + (i + 1), doc_id, title, section: c.section, text: title + ' > ' + c.section + '\\n' + c.body } }));`, 'runOnceForAllItems'), [780, 300]);
  // One request per chunk, 0.7 s apart: under the free tier's 100 a minute.
  w.add(httpReq('Embed Chunk', 'POST', EMBED_URL, { cred: 'googlePalmApi', timeout: 30000, batch: { batchSize: 1, batchInterval: 700 },
    body: `={{ JSON.stringify({ content: { parts: [{ text: $json.text }] }, taskType: 'RETRIEVAL_DOCUMENT', title: $json.title, outputDimensionality: ${EMBED_DIMS} }) }}` }), [1040, 300]);
  w.add(code('Check Embeddings', `
const chunks = $('Chunk').all().map((i) => i.json);
const res = $input.all().map((i) => i.json);
const failed = [], rows = [], at = new Date().toISOString();
chunks.forEach((c, i) => {
  const r = res[i] || {}; const v = r.body && r.body.embedding && r.body.embedding.values;
  if (r.statusCode !== 200 || !Array.isArray(v) || v.length !== ${EMBED_DIMS}) {
    failed.push({ chunk_id: c.chunk_id, status: r.statusCode ?? null, error: r.error ? (r.error.message || String(r.error)) : JSON.stringify(r.body || '').slice(0, 200) });
    return;
  }
  rows.push({ ...c, embedding: JSON.stringify(v.map((x) => Math.round(x * 1e6) / 1e6)), model: '${EMBED_MODEL}', ingested_at: at });
});
return [{ json: { ok: failed.length === 0 && rows.length > 0, doc_id: chunks[0].doc_id, chunks: chunks.length, failed, rows } }];`, 'runOnceForAllItems'), [1300, 300]);
  w.add(iff('All Embedded?', '={{ $json.ok }}'), [1560, 300]);
  w.add(dtDelete('Delete Old Chunks', 'rag_chunks', { doc_id: '={{ $json.doc_id }}' }), [1820, 220]);
  w.add(code('Rows', `return $('Check Embeddings').first().json.rows.map((r) => ({ json: r }));`, 'runOnceForAllItems'), [2080, 220]);
  w.add(dtInsert('Store Chunk', 'rag_chunks', Object.fromEntries(['chunk_id', 'doc_id', 'title', 'section', 'text', 'embedding', 'model', 'ingested_at'].map((k) => [k, `={{ $json.${k} }}`]))), [2340, 220]);
  w.add(respond('Respond Ingested', J(`{ status: 'ingested', doc_id: $('Check Embeddings').first().json.doc_id, chunks: $('Check Embeddings').first().json.chunks, model: '${EMBED_MODEL}', dimensions: ${EMBED_DIMS} }`)), [2600, 220]);
  w.add(respond('Respond 502', J(`{ status: 'failed', reason: 'Some chunks could not be embedded, so the stored copy of this document was left unchanged.', failed: $json.failed }`), 502), [1820, 440]);
  w.link('Document', 'Validate'); w.link('Validate', 'Valid?'); w.link('Valid?', 'Chunk', { out: 0 }); w.link('Valid?', 'Respond 400', { out: 1 });
  w.link('Chunk', 'Embed Chunk'); w.link('Embed Chunk', 'Check Embeddings'); w.link('Check Embeddings', 'All Embedded?');
  w.link('All Embedded?', 'Delete Old Chunks', { out: 0 }); w.link('All Embedded?', 'Respond 502', { out: 1 });
  w.link('Delete Old Chunks', 'Rows'); w.link('Rows', 'Store Chunk'); w.link('Store Chunk', 'Respond Ingested');
  out('rag-ingest.json', w);
}

// ---------- 4b. rag-docs: ask ----------
{
  const TOP_K = 4;
  // Below this best-chunk similarity the question is handed off without asking the AI (saves a free-tier request).
  // Measured 2026-10-17 on the 20-question eval: answerable questions 0.701-0.848, near-misses 0.706-0.770 (those
  // need the AI's own refusal), off-topic 0.536-0.573. 0.6 sits between off-topic and the lowest answerable.
  const MIN_SCORE = 0.6;
  const w = new WF('rag-ask', { errorWorkflow: ERR_WF });
  w.add(webhook('Question', 'POST', 'rag/ask'), [0, 300]);
  w.add(code('Validate', `
const q = ($json.body || {}).question;
const errs = [];
if (!q || typeof q !== 'string' || q.trim().length < 3) errs.push('question is required');
else if (q.length > 500) errs.push('question must be 500 characters or fewer');
return { json: { valid: errs.length === 0, errors: errs, question: typeof q === 'string' ? q.trim() : '' } };`), [260, 300]);
  w.add(iff('Valid?', '={{ $json.valid }}'), [520, 300]);
  w.add(respond('Respond 400', J(`{ answered: false, reasons: $('Validate').first().json.errors }`), 400), [520, 520]);
  w.add(httpReq('Embed Question', 'POST', EMBED_URL, { cred: 'googlePalmApi', timeout: 30000,
    body: `={{ JSON.stringify({ content: { parts: [{ text: $json.question }] }, taskType: 'RETRIEVAL_QUERY', outputDimensionality: ${EMBED_DIMS} }) }}` }), [780, 300]);
  w.add(dtGetAll('Load Chunks', 'rag_chunks'), [1040, 300]);
  // Brute-force cosine similarity in a Code node: fine for a few thousand chunks. Past that, the same step becomes a
  // query to a vector database (pgvector, Qdrant) and nothing else in the workflow changes.
  w.add(code('Retrieve', `
const question = $('Validate').first().json.question;
const e = $('Embed Question').first().json;
const qv = e.body && e.body.embedding && e.body.embedding.values;
const none = (reason) => [{ json: { ok: false, reason, question, top: [], top_score: 0 } }];
if (e.statusCode !== 200 || !Array.isArray(qv)) return none('retrieval_unavailable');
const rows = $input.all().map((i) => i.json).filter((r) => r.chunk_id && r.embedding);
if (!rows.length) return none('no_documents');
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const qn = Math.sqrt(dot(qv, qv));
const top = rows.map((r) => { const v = JSON.parse(r.embedding); return { chunk_id: r.chunk_id, doc_id: r.doc_id, title: r.title, section: r.section, text: r.text, score: dot(qv, v) / (qn * Math.sqrt(dot(v, v))) }; })
  .sort((a, b) => b.score - a.score).slice(0, ${TOP_K});
const top_score = Math.round(top[0].score * 1000) / 1000;
const slim = top.map(({ text, ...c }) => ({ ...c, score: Math.round(c.score * 1000) / 1000 }));
if (top_score < ${MIN_SCORE}) return [{ json: { ok: false, reason: 'nothing_relevant', question, top: slim, top_score } }];
return [{ json: { ok: true, reason: '', question, top: slim, top_score, context: top.map((c) => '[' + c.chunk_id + '] ' + c.text).join('\\n\\n') } }];`, 'runOnceForAllItems'), [1300, 300]);
  w.add(iff('Found Extracts?', '={{ $json.ok }}'), [1560, 300]);
  w.add(chain('Answer From Docs', `=Customer question: {{ $json.question }}\n\nDocument extracts:\n{{ $json.context }}`,
    `You are the support assistant for Acme Solar, a fictional home-solar installer. Answer ONLY from the document extracts in the user message. Each extract starts with its id in square brackets, for example [price-sheet#2]. If the extracts do not clearly contain the answer, set supported=false, confidence low, and leave cited_chunk_ids empty. Do not guess and do not use outside knowledge, even when the question is close to something the extracts cover. When supported, answer in one to three plain sentences, include the exact figures from the extracts, and list the ids of the extracts you used in cited_chunk_ids. confidence is 0 to 1.`), [1820, 220]);
  w.add(geminiModel('Gemini Chat Model'), [1780, 480]);
  w.add(parser('Answer Fields', { type: 'object', properties: {
    answer: { type: 'string' }, supported: { type: 'boolean' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, cited_chunk_ids: { type: 'array', items: { type: 'string' } } },
    required: ['answer', 'supported', 'confidence', 'cited_chunk_ids'] }), [1940, 480]);
  w.link('Gemini Chat Model', 'Answer From Docs', { type: 'ai_languageModel' });
  w.link('Answer Fields', 'Answer From Docs', { type: 'ai_outputParser' });
  w.add(code('Decide', `
const r = $('Retrieve').first().json;
let reason = r.reason || '', o = null;
if (r.ok) {
  o = $json.output;
  const shape = o && typeof o === 'object' && typeof o.answer === 'string' && typeof o.supported === 'boolean' && typeof o.confidence === 'number' && Array.isArray(o.cited_chunk_ids);
  const retrieved = r.top.map((c) => c.chunk_id);
  if ($json.error) reason = 'ai_unavailable';
  else if (!shape) reason = 'ai_output_unusable';
  else if (!o.supported) reason = 'not_in_docs';
  else if (o.confidence < 0.6) reason = 'low_confidence';
  else if (o.cited_chunk_ids.length === 0 || !o.cited_chunk_ids.every((id) => retrieved.includes(id))) reason = 'citation_not_retrieved';
}
const answered = reason === '';
return { json: { answered, reason: answered ? 'answered' : reason, question: r.question,
  answer: answered ? o.answer : "I can't answer that reliably from our documents. I've passed your question to our team and they will reply by email.",
  confidence: o && typeof o.confidence === 'number' ? o.confidence : 0,
  citations: answered ? r.top.filter((c) => o.cited_chunk_ids.includes(c.chunk_id)).map((c) => ({ chunk_id: c.chunk_id, title: c.title, section: c.section })) : [],
  retrieved: r.top.map((c) => ({ chunk_id: c.chunk_id, doc_id: c.doc_id, score: c.score })), top_score: r.top_score } };`), [2080, 300]);
  w.add(iff('Answered?', '={{ $json.answered }}'), [2340, 300]);
  w.add(respond('Respond Answer', J(`{ answered: true, answer: $json.answer, citations: $json.citations, confidence: $json.confidence, retrieved: $json.retrieved }`)), [2600, 220]);
  w.add(dtInsert('Create Handoff', 'rag_handoff_log', { question: '={{ $json.question }}', reason: '={{ $json.reason }}', confidence: '={{ $json.confidence }}', top_score: '={{ $json.top_score }}', at: NOW }), [2600, 420]);
  w.add(respond('Respond Handoff', J(`{ answered: false, handoff: true, reason: $('Decide').first().json.reason, message: $('Decide').first().json.answer, retrieved: $('Decide').first().json.retrieved }`)), [2860, 420]);
  w.link('Question', 'Validate'); w.link('Validate', 'Valid?'); w.link('Valid?', 'Embed Question', { out: 0 }); w.link('Valid?', 'Respond 400', { out: 1 });
  w.link('Embed Question', 'Load Chunks'); w.link('Load Chunks', 'Retrieve'); w.link('Retrieve', 'Found Extracts?');
  w.link('Found Extracts?', 'Answer From Docs', { out: 0 }); w.link('Found Extracts?', 'Decide', { out: 1 }); w.link('Answer From Docs', 'Decide');
  w.link('Decide', 'Answered?'); w.link('Answered?', 'Respond Answer', { out: 0 }); w.link('Answered?', 'Create Handoff', { out: 1 }); w.link('Create Handoff', 'Respond Handoff');
  out('rag-ask.json', w);
}

// ---------- 4c. rag-docs: eval ----------
{
  const w = new WF('rag-eval', { errorWorkflow: ERR_WF });
  w.add({ name: 'Run Eval', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }, [0, 300]);
  w.add(code('Test Set', `return ${JSON.stringify(ragEvalSet)}.map((t, i) => ({ json: { n: i + 1, ...t } }));`, 'runOnceForAllItems'), [260, 300]);
  // Same pacing as support-bot-eval: one question every 8 s stays under the free tier's 15 answers a minute.
  w.add(httpReq('Ask', 'POST', `${BASE}/webhook/rag/ask`, { body: `={{ JSON.stringify({ question: $json.q }) }}`, timeout: 90000, batch: { batchSize: 1, batchInterval: 8000 } }), [520, 300]);
  w.add(code('Score', `
const tests = $('Test Set').all().map((i) => i.json);
const res = $input.all().map((i) => i.json);
let hits = 0, correct = 0, refusedRight = 0, wrong = 0, missed = 0, aiDown = 0; const details = [];
tests.forEach((t, i) => {
  const r = (res[i] && res[i].body) || {};
  const answered = r.answered === true;
  if (['ai_unavailable', 'ai_output_unusable', 'retrieval_unavailable'].includes(r.reason)) aiDown++;
  const retrievedDocs = (r.retrieved || []).map((c) => c.doc_id);
  let verdict, hit = null;
  if (t.answerable) {
    hit = t.expect_docs.some((d) => retrievedDocs.includes(d)); if (hit) hits++;
    const citedDocs = (r.citations || []).map((c) => c.chunk_id.split('#')[0]);
    const fact = t.expect_any.some((k) => String(r.answer || '').toLowerCase().includes(k.toLowerCase()));
    if (!answered) { missed++; verdict = 'missed (refused)'; }
    else if (!citedDocs.some((d) => t.expect_docs.includes(d))) { wrong++; verdict = 'WRONG: cited the wrong document'; }
    else if (!fact) { wrong++; verdict = 'WRONG: expected fact missing'; }
    else { correct++; verdict = 'correct'; }
  } else if (!answered) { refusedRight++; verdict = 'correct refusal'; }
  else { wrong++; verdict = 'WRONG: answered an unanswerable question'; }
  details.push({ n: t.n, q: t.q, kind: t.kind || 'answerable', verdict, reason: r.reason || null, retrieval_hit: hit, top_score: r.retrieved && r.retrieved[0] ? r.retrieved[0].score : null, answer: answered ? r.answer : null });
});
const answerable = tests.filter((t) => t.answerable).length, unanswerable = tests.length - answerable;
const r3 = (x) => Math.round(x * 1000) / 1000;
return [{ json: { run_at: new Date().toISOString(), total: tests.length, answerable, unanswerable,
  retrieval_hit_rate: r3(hits / answerable), answer_accuracy: r3((correct + refusedRight) / tests.length),
  correct_refusal_rate: r3(refusedRight / unanswerable), wrong_answers: wrong, missed_answers: missed, ai_unavailable: aiDown, details: JSON.stringify(details) } }];`, 'runOnceForAllItems'), [780, 300]);
  w.add(dtInsert('Save Run', 'rag_eval_scores', Object.fromEntries(['run_at', 'total', 'answerable', 'unanswerable', 'retrieval_hit_rate', 'answer_accuracy', 'correct_refusal_rate', 'wrong_answers', 'missed_answers', 'ai_unavailable', 'details'].map((k) => [k, `={{ $json.${k} }}`]))), [1040, 300]);
  w.link('Run Eval', 'Test Set'); w.link('Test Set', 'Ask'); w.link('Ask', 'Score'); w.link('Score', 'Save Run');
  out('rag-eval.json', w);
}
console.log('workflows written');
