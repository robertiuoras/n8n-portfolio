// Small helpers that emit n8n node JSON (typeVersions checked against n8n 2.42.5).
import crypto from 'node:crypto';
const uid = (s) => { const h = crypto.createHash('md5').update(s).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; };
export const BASE = 'http://localhost:5678';

export class WF {
  constructor(name, settings = {}) { this.name = name; this.nodes = []; this.conn = {}; this.settings = { executionOrder: 'v1', ...settings }; this.x = 0; }
  add(node, pos) {
    node.id = uid(this.name + node.name);
    node.position = pos || [this.x += 260, 300];
    this.nodes.push(node); return node.name;
  }
  link(from, to, { out = 0, type = 'main', idx = 0 } = {}) {
    this.conn[from] ??= {}; this.conn[from][type] ??= [];
    while (this.conn[from][type].length <= out) this.conn[from][type].push([]);
    this.conn[from][type][out].push({ node: to, type, index: idx });
  }
  json() { return { name: this.name, nodes: this.nodes, connections: this.conn, settings: this.settings }; }
}

export const webhook = (name, method, path, extra = {}) => ({
  name, type: 'n8n-nodes-base.webhook', typeVersion: 2.1, webhookId: uid('wh' + name + path),
  parameters: { httpMethod: method, path, responseMode: 'responseNode', options: {} }, ...extra });

export const respond = (name, bodyExpr, code = 200) => ({
  name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.5,
  parameters: { respondWith: 'json', responseBody: bodyExpr, options: { responseCode: code } } });

export const code = (name, js, mode = 'runOnceForEachItem') => ({
  name, type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { mode, jsCode: js } });

export const iff = (name, expr) => ({
  name, type: 'n8n-nodes-base.if', typeVersion: 2.3,
  parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: uid(name + 'c'), leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} } });

export const sw = (name, labels, expr) => ({
  name, type: 'n8n-nodes-base.switch', typeVersion: 3.4,
  parameters: { mode: 'expression', numberOutputs: labels.length, output: `={{ ${JSON.stringify(labels)}.indexOf(${expr}) }}` } });

const tbl = (t) => ({ __rl: true, mode: 'name', value: t });
const eqs = (f) => ({ conditions: Object.entries(f).map(([keyName, keyValue]) => ({ keyName, condition: 'eq', keyValue })) });
export const dtGet = (name, table, filters) => ({
  name, type: 'n8n-nodes-base.dataTable', typeVersion: 1.1, alwaysOutputData: true,
  parameters: { resource: 'row', operation: 'get', dataTableId: tbl(table), matchType: 'allConditions', filters: eqs(filters), returnAll: true } });
const cols = (v) => ({ mappingMode: 'defineBelow', value: v, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: false });
export const dtInsert = (name, table, values) => ({
  name, type: 'n8n-nodes-base.dataTable', typeVersion: 1.1,
  parameters: { resource: 'row', operation: 'insert', dataTableId: tbl(table), columns: cols(values), options: {} } });
export const dtUpdate = (name, table, filters, values) => ({
  name, type: 'n8n-nodes-base.dataTable', typeVersion: 1.1,
  parameters: { resource: 'row', operation: 'update', dataTableId: tbl(table), matchType: 'allConditions', filters: eqs(filters), columns: cols(values), options: {} } });

export const httpReq = (name, method, url, { headers, body, query, timeout = 10000, batch } = {}) => ({
  name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5, onError: 'continueRegularOutput',
  parameters: {
    method, url,
    ...(query ? { sendQuery: true, queryParameters: { parameters: Object.entries(query).map(([n, value]) => ({ name: n, value })) } } : {}),
    ...(headers ? { sendHeaders: true, headerParameters: { parameters: Object.entries(headers).map(([n, value]) => ({ name: n, value })) } } : {}),
    ...(body ? { sendBody: true, specifyBody: 'json', jsonBody: body } : {}),
    options: { timeout, ...(batch ? { batching: { batch } } : {}), response: { response: { fullResponse: true, neverError: true } } } } });

export const wait = (name, secondsExpr) => ({
  name, type: 'n8n-nodes-base.wait', typeVersion: 1.1, webhookId: uid('wait' + name),
  parameters: { resume: 'timeInterval', amount: secondsExpr, unit: 'seconds' } });

// gemini-2.5-flash answers 404 "no longer available to new users" (checked 2026-10-09 against the live model list);
// gemini-3.8-flash answered 503 "high demand" the same morning. 3.5-flash answered on the free tier.
export const LLM_MODEL = 'models/gemini-3.5-flash';
export const geminiModel = (name) => ({
  name, type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', typeVersion: 1,
  parameters: { modelName: LLM_MODEL, options: { temperature: 0 } },
  credentials: { googlePalmApi: { id: '__GEMINI_CRED_ID__', name: 'Gemini free tier' } } });
export const parser = (name, schema) => ({
  name, type: '@n8n/n8n-nodes-langchain.outputParserStructured', typeVersion: 1.3,
  parameters: { schemaType: 'manual', inputSchema: JSON.stringify(schema, null, 1) } });
export const chain = (name, textExpr, system) => ({
  name, type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.9, onError: 'continueRegularOutput',
  parameters: { promptType: 'define', text: textExpr, hasOutputParser: true,
    messages: { messageValues: [{ message: system }] } } });

// Shared retry core: POST to the CRM, classify, retry on 429/5xx/timeout with exponential backoff, max 3 tries.
export function retryBlock(w, { upsertName, classifyName, routeName, waitName, payloadExpr, xfailExpr, upstreamForBody }) {
  w.add(httpReq(upsertName, 'POST', `${BASE}/webhook/mock-crm/contacts`, {
    headers: { 'x-fail': xfailExpr }, body: payloadExpr }));
  w.add(code(classifyName, `
const attempt = $runIndex + 1;
const r = $json;
const status = (r.statusCode === undefined) ? null : r.statusCode;
const ok = status !== null && status >= 200 && status < 300;
const retryable = status === null || status === 429 || status >= 500;
let outcome = 'fail';
if (ok) outcome = 'ok'; else if (retryable && attempt < 3) outcome = 'retry';
const err = r.error ? (typeof r.error === 'string' ? r.error : (r.error.message || JSON.stringify(r.error))) : ('HTTP ' + status + ' ' + JSON.stringify(r.body || '').slice(0, 200));
return { json: { outcome, attempt, status, error: ok ? null : err, backoff: Math.pow(2, attempt - 1), crm: ok ? r.body : null, step: 'crm_upsert' } };`));
  w.add(sw(routeName, ['ok', 'retry', 'fail'], '$json.outcome'));
  w.add(wait(waitName, '={{ $json.backoff }}'));
  w.link(upsertName, classifyName); w.link(classifyName, routeName);
  w.link(routeName, waitName, { out: 1 }); w.link(waitName, upsertName);
}
