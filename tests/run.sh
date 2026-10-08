#!/usr/bin/env bash
# End-to-end tests against the local n8n (http://localhost:5678). Every outcome is proven by reading Data Table
# rows back through the n8n API, not just by looking at HTTP codes. Writes tests/RESULTS.md.
# Needs: curl, jq, node, the N8N_LOCAL_API_KEY secret.  Takes about 2 minutes (the timeout cases wait on purpose).
set -u
cd "$(dirname "$0")/.."
BASE=http://localhost:5678
SECRETS=$HOME/Projects/claude-memory/claude-config/secrets.mjs
KEY=$(node "$SECRETS" get N8N_LOCAL_API_KEY)
RUN=$(date +%s)
OUT=tests/RESULTS.md
PASS=0; FAIL=0; ROWS=""
H='content-type: application/json'

TIDS=$(curl -s -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables?limit=250" | jq -r '.data[]|"\(.name) \(.id)"')
tid() { awk -v n="$1" '$1==n{print $2}' <<<"$TIDS"; }

# rows <table> <column> <value>  -> JSON array of matching rows
rows() { curl -s -G -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables/$(tid "$1")/rows" \
  --data-urlencode "filter={\"type\":\"and\",\"filters\":[{\"columnName\":\"$2\",\"condition\":\"eq\",\"value\":\"$3\"}]}" | jq -c '.data'; }
count() { rows "$@" | jq 'length'; }
# record <name> <PASS|FAIL> <evidence>
record() {
  if [ "$2" = PASS ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
  ROWS+="| $1 | $2 | ${3//|/\\|} |"$'\n'
  printf '%-4s %s\n' "$2" "$1"
}
# expect <name> <jq-bool-expr over $in> <evidence-string> ; $in provided via env var IN
expect() { if [ "$2" = "true" ]; then record "$1" PASS "$3"; else record "$1" FAIL "$3"; fi; }

post() { # post <url> <json> [header...]  -> sets CODE and BODY, TIME
  local url=$1 body=$2; shift 2; local hargs=(); for h in "$@"; do hargs+=(-H "$h"); done
  local t0=$(date +%s)
  local resp; resp=$(curl -s -m 120 -w '\n%{http_code}' -X POST "$url" -H "$H" ${hargs[@]+"${hargs[@]}"} -d "$body")
  TIME=$(( $(date +%s) - t0 )); CODE=${resp##*$'\n'}; BODY=${resp%$'\n'*}
}
chat() { # chat <conv> <email> [approved] [header]
  jq -nc --arg c "$1" --arg e "$2" --argjson a "${3:-true}" '{conversation_id:$c,approved:$a,customer:{name:"Test Person",email:$e,phone:"0400 000 000",company:"Demo Co"},summary:"Asked about a quote for a 6.6 kW system",request_type:"quote"}'
}
hash() { printf '%s' "$1$(echo "$2" | tr A-Z a-z)" | shasum -a 256 | cut -d' ' -f1; }
CHAT=$BASE/webhook/chatbot-summary

echo "== chatbot-to-crm"
E1="happy-$RUN@demo.test"; C1="conv-$RUN-1"
post $CHAT "$(chat $C1 "$E1")"
K1=$(hash $C1 $E1)
sent=$(count crm_sent key $K1); contacts=$(count mock_crm_contacts email $E1)
expect "chatbot: happy path creates the contact" "$([ "$CODE" = 200 ] && [ "$(jq -r .status <<<"$BODY")" = synced ] && [ "$(jq -r .crm_action <<<"$BODY")" = created ] && [ "$sent" = 1 ] && [ "$contacts" = 1 ] && echo true)" "HTTP $CODE, body $(jq -c '{status,crm_action,attempts}' <<<"$BODY"); crm_sent rows for key=$sent, mock CRM contacts for email=$contacts"
calls_before=$(count mock_crm_log email $E1)
post $CHAT "$(chat $C1 "$E1")"
calls_after=$(count mock_crm_log email $E1)
expect "chatbot: same payload again is a duplicate and the CRM is not called" "$([ "$CODE" = 200 ] && [ "$(jq -r .status <<<"$BODY")" = duplicate ] && [ "$calls_before" = "$calls_after" ] && [ "$(count crm_sent key $K1)" = 1 ] && echo true)" "HTTP $CODE status=$(jq -r .status <<<"$BODY"); CRM calls before=$calls_before after=$calls_after; crm_sent rows still $(count crm_sent key $K1)"
C1b="conv-$RUN-1b"; E1u=$(echo "$E1" | tr a-z A-Z | sed 's/@DEMO.TEST/@demo.test/')
post $CHAT "$(chat $C1b "$E1")"
ver=$(rows mock_crm_contacts email $E1 | jq -r '.[0].version'); n=$(count mock_crm_contacts email $E1)
expect "chatbot: existing email is updated, not created again" "$([ "$CODE" = 200 ] && [ "$(jq -r .crm_action <<<"$BODY")" = updated ] && [ "$(jq -r .existed_before <<<"$BODY")" = true ] && [ "$n" = 1 ] && [ "$ver" = 2 ] && echo true)" "HTTP $CODE crm_action=$(jq -r .crm_action <<<"$BODY") existed_before=$(jq -r .existed_before <<<"$BODY"); contact rows for email=$n, version=$ver"
E2="unapproved-$RUN@demo.test"
post $CHAT "$(chat conv-$RUN-2 $E2 false)"
expect "chatbot: unapproved summary is ignored (202)" "$([ "$CODE" = 202 ] && [ "$(count mock_crm_log email $E2)" = 0 ] && [ "$(count mock_crm_contacts email $E2)" = 0 ] && echo true)" "HTTP $CODE status=$(jq -r .status <<<"$BODY"); CRM calls for email=$(count mock_crm_log email $E2), contacts=$(count mock_crm_contacts email $E2)"
post $CHAT '{"conversation_id":"x","approved":true,"customer":{"name":"No Email"},"summary":"s","request_type":"q"}'
expect "chatbot: missing email is rejected (400) with a reason" "$([ "$CODE" = 400 ] && jq -e '.reasons|map(test("email"))|any' <<<"$BODY" >/dev/null && echo true)" "HTTP $CODE reasons=$(jq -c .reasons <<<"$BODY")"
E3="retry2-$RUN@demo.test"; C3=conv-$RUN-3
post $CHAT "$(chat $C3 $E3)" "x-fail: 500x2"
log=$(rows mock_crm_log email $E3 | jq -c '[.[].outcome]')
expect "chatbot: CRM fails twice (500) then succeeds on the third try" "$([ "$CODE" = 200 ] && [ "$(jq -r .attempts <<<"$BODY")" = 3 ] && [ "$(jq -r .status <<<"$BODY")" = synced ] && [ "$log" = '["injected_500x2","injected_500x2","ok"]' ] && [ "$(count crm_sent key $(hash $C3 $E3))" = 1 ] && echo true)" "HTTP $CODE attempts=$(jq -r .attempts <<<"$BODY") in ${TIME}s; CRM call log outcomes=$log; crm_sent rows=$(count crm_sent key $(hash $C3 $E3))"
E4="bad400-$RUN@demo.test"; C4=conv-$RUN-4
post $CHAT "$(chat $C4 $E4)" "x-fail: 400"
err=$(rows crm_errors key $(hash $C4 $E4))
expect "chatbot: CRM answers 400 -> no retry, error logged, caller gets 502" "$([ "$CODE" = 502 ] && [ "$(jq -r .attempts <<<"$BODY")" = 1 ] && [ "$(count mock_crm_log email $E4)" = 1 ] && [ "$(jq -r '.[0].http_status' <<<"$err")" = 400 ] && [ "$(jq 'length' <<<"$err")" = 1 ] && [ "$(count crm_sent key $(hash $C4 $E4))" = 0 ] && echo true)" "HTTP $CODE attempts=$(jq -r .attempts <<<"$BODY"); CRM calls=$(count mock_crm_log email $E4); crm_errors row: step=$(jq -r '.[0].step' <<<"$err") http_status=$(jq -r '.[0].http_status' <<<"$err") payload.email=$(jq -r '.[0].payload|fromjson|.email' <<<"$err")"
E5="timeout-$RUN@demo.test"; C5=conv-$RUN-5
post $CHAT "$(chat $C5 $E5)" "x-fail: timeout"
err=$(rows crm_errors key $(hash $C5 $E5))
expect "chatbot: CRM hangs (timeout) -> retried 3 times, then logged, caller gets 502" "$([ "$CODE" = 502 ] && [ "$(jq -r .attempts <<<"$BODY")" = 3 ] && [ "$(count mock_crm_log email $E5)" = 3 ] && [ "$(jq 'length' <<<"$err")" = 1 ] && [ "$TIME" -ge 30 ] && echo true)" "HTTP $CODE attempts=$(jq -r .attempts <<<"$BODY") in ${TIME}s; CRM calls=$(count mock_crm_log email $E5); crm_errors error=\"$(jq -r '.[0].error' <<<"$err")\""
E6="rate429-$RUN@demo.test"; C6=conv-$RUN-6
post $CHAT "$(chat $C6 $E6)" "x-fail: 429"
err=$(rows crm_errors key $(hash $C6 $E6))
expect "chatbot: CRM answers 429 -> retried 3 times, then logged" "$([ "$CODE" = 502 ] && [ "$(count mock_crm_log email $E6)" = 3 ] && [ "$(jq -r '.[0].http_status' <<<"$err")" = 429 ] && echo true)" "HTTP $CODE; CRM calls=$(count mock_crm_log email $E6); crm_errors http_status=$(jq -r '.[0].http_status' <<<"$err")"
E7="srv500-$RUN@demo.test"; C7=conv-$RUN-7
post $CHAT "$(chat $C7 $E7)" "x-fail: 500"
expect "chatbot: CRM answers 500 every time -> 3 tries, then logged" "$([ "$CODE" = 502 ] && [ "$(count mock_crm_log email $E7)" = 3 ] && [ "$(count crm_errors key $(hash $C7 $E7))" = 1 ] && echo true)" "HTTP $CODE; CRM calls=$(count mock_crm_log email $E7); crm_errors rows=$(count crm_errors key $(hash $C7 $E7))"

echo "== mock CRM"
r=$(curl -s -w '\n%{http_code}' "$BASE/webhook/mock-crm/contacts?email=$E1"); c=${r##*$'\n'}; b=${r%$'\n'*}
expect "mock CRM: GET finds an existing contact" "$([ "$c" = 200 ] && [ "$(jq -r .found <<<"$b")" = true ] && echo true)" "HTTP $c $(jq -c '.contact|{email,version}' <<<"$b")"
r=$(curl -s -w '\n%{http_code}' "$BASE/webhook/mock-crm/contacts?email=nobody-$RUN@demo.test"); c=${r##*$'\n'}
expect "mock CRM: GET on an unknown email is 404" "$([ "$c" = 404 ] && echo true)" "HTTP $c"

echo "== ai-lead-qualify"
LEAD=$BASE/webhook/lead
post $LEAD '{"name":"No Email"}'
expect "lead: invalid input is rejected (400)" "$([ "$CODE" = 400 ] && echo true)" "HTTP $CODE reasons=$(jq -c .reasons <<<"$BODY")"
GEM=$(node "$SECRETS" get GEMINI_API_KEY 2>/dev/null || true)
EL="lead-live-$RUN@demo.test"
post $LEAD "$(jq -nc --arg e $EL '{name:"Live Lead",email:$e,message:"Hi, we run 3 clinics and want to automate booking reminders. Budget around $4k, hoping to start this month.",source:"web"}')"
if [ -n "$GEM" ]; then
  expect "lead: REAL Gemini call returns a valid qualification" "$([ "$CODE" = 200 ] && [ "$(jq -r .used_fallback <<<"$BODY")" = false ] && echo true)" "HTTP $CODE $(jq -c '.qualification' <<<"$BODY")"
else
  expect "lead: AI unavailable (no Gemini key) -> falls back to needs_human=true, still saved to CRM, no hot-lead alert" "$([ "$CODE" = 200 ] && [ "$(jq -r .used_fallback <<<"$BODY")" = true ] && [ "$(jq -r .qualification.needs_human <<<"$BODY")" = true ] && [ "$(count mock_crm_contacts email $EL)" = 1 ] && [ "$(count notifications email $EL)" = 0 ] && echo true)" "HTTP $CODE used_fallback=$(jq -r .used_fallback <<<"$BODY") reason=\"$(jq -r .fallback_reason <<<"$BODY")\"; CRM contacts=$(count mock_crm_contacts email $EL), notifications=$(count notifications email $EL)"
fi
# AI-dependent branches: Gemini chain replaced by a stub that returns the JSON in header x-stub-llm. Everything after it is the real wiring.
node scripts/stub-variant.mjs create ai-lead-qualify "Qualify Lead" >/dev/null
STUB=$BASE/webhook/lead-stub
EH="hot-$RUN@demo.test"
post $STUB "$(jq -nc --arg e $EH '{name:"Hot Hana",email:$e,message:"x"}')" 'x-stub-llm: {"intent":"buy","budget_mentioned":"20k","urgency":"high","score":92,"summary":"Ready to buy","needs_human":false}'
expect "lead (AI stubbed): score 92 -> hot-lead notification row written" "$([ "$CODE" = 200 ] && [ "$(count notifications email $EH)" = 1 ] && [ "$(rows notifications email $EH | jq -r '.[0].score')" = 92 ] && [ "$(count mock_crm_contacts email $EH)" = 1 ] && echo true)" "HTTP $CODE hot_lead_notified=$(jq -r .hot_lead_notified <<<"$BODY"); notifications rows=$(count notifications email $EH) score=$(rows notifications email $EH | jq -r '.[0].score'); CRM contacts=$(count mock_crm_contacts email $EH)"
EC="cold-$RUN@demo.test"
post $STUB "$(jq -nc --arg e $EC '{name:"Cold Cal",email:$e,message:"just browsing"}')" 'x-stub-llm: {"intent":"browse","budget_mentioned":null,"urgency":"low","score":30,"summary":"Just browsing","needs_human":false}'
expect "lead (AI stubbed): score 30 -> saved to CRM, no notification" "$([ "$CODE" = 200 ] && [ "$(count notifications email $EC)" = 0 ] && [ "$(count mock_crm_contacts email $EC)" = 1 ] && echo true)" "HTTP $CODE; notifications rows=$(count notifications email $EC); CRM contacts=$(count mock_crm_contacts email $EC)"
EB="garbage-$RUN@demo.test"
post $STUB "$(jq -nc --arg e $EB '{name:"Garbled",email:$e,message:"???"}')" 'x-stub-llm: {"intent":"?","urgency":"extreme","score":"lots"}'
expect "lead (AI stubbed): unusable AI output -> needs_human=true fallback instead of an error" "$([ "$CODE" = 200 ] && [ "$(jq -r .used_fallback <<<"$BODY")" = true ] && [ "$(jq -r .qualification.needs_human <<<"$BODY")" = true ] && [ "$(count notifications email $EB)" = 0 ] && echo true)" "HTTP $CODE used_fallback=$(jq -r .used_fallback <<<"$BODY") reason=$(jq -r .fallback_reason <<<"$BODY")"
EF="leadfail-$RUN@demo.test"
post $STUB "$(jq -nc --arg e $EF '{name:"Fail Fay",email:$e,message:"hello there"}')" 'x-stub-llm: {"intent":"buy","budget_mentioned":null,"urgency":"high","score":80,"summary":"s","needs_human":false}' "x-fail: 500x2"
expect "lead (AI stubbed): CRM fails twice then succeeds (same retry pattern)" "$([ "$CODE" = 200 ] && [ "$(count mock_crm_log email $EF)" = 3 ] && [ "$(count notifications email $EF)" = 1 ] && echo true)" "HTTP $CODE; CRM calls=$(count mock_crm_log email $EF); notifications=$(count notifications email $EF)"
node scripts/stub-variant.mjs delete ai-lead-qualify "Qualify Lead" >/dev/null

echo "== support-bot-with-fallback"
SUP=$BASE/webhook/support
post $SUP '{}'
expect "support: missing question is rejected (400)" "$([ "$CODE" = 400 ] && echo true)" "HTTP $CODE"
Q1="How long does the install take? ($RUN)"
post $SUP "$(jq -nc --arg q "$Q1" '{question:$q}')"
if [ -n "$GEM" ]; then
  expect "support: REAL Gemini answers an in-FAQ question with a source" "$([ "$(jq -r .answered <<<"$BODY")" = true ] && echo true)" "HTTP $CODE $(jq -c . <<<"$BODY")"
else
  expect "support: AI unavailable (no Gemini key) -> honest refusal and a handoff row" "$([ "$CODE" = 200 ] && [ "$(jq -r .answered <<<"$BODY")" = false ] && [ "$(jq -r .reason <<<"$BODY")" = ai_unavailable ] && [ "$(count handoffs question "$Q1")" = 1 ] && echo true)" "HTTP $CODE answered=$(jq -r .answered <<<"$BODY") reason=$(jq -r .reason <<<"$BODY"); handoffs rows=$(count handoffs question "$Q1")"
fi
node scripts/stub-variant.mjs create support-bot-with-fallback "Answer From FAQ" >/dev/null
SS=$BASE/webhook/support-stub
Qa="Stub: how long is an install? $RUN"
post $SS "$(jq -nc --arg q "$Qa" '{question:$q}')" 'x-stub-llm: {"answer":"One to two days.","supported":true,"confidence":0.92,"source_faq_ids":["faq-03"]}'
expect "support (AI stubbed): supported, confident, valid source -> answered, no handoff" "$([ "$(jq -r .answered <<<"$BODY")" = true ] && [ "$(jq -r '.sources[0]' <<<"$BODY")" = faq-03 ] && [ "$(count handoffs question "$Qa")" = 0 ] && echo true)" "HTTP $CODE $(jq -c '{answered,sources,confidence}' <<<"$BODY"); handoffs rows=$(count handoffs question "$Qa")"
Qb="Stub: bitcoin price? $RUN"
post $SS "$(jq -nc --arg q "$Qb" '{question:$q}')" 'x-stub-llm: {"answer":"","supported":false,"confidence":0.1,"source_faq_ids":[]}'
expect "support (AI stubbed): supported=false -> refusal + handoff row" "$([ "$(jq -r .answered <<<"$BODY")" = false ] && [ "$(rows handoffs question "$Qb" | jq -r '.[0].reason')" = not_in_faq ] && echo true)" "answered=$(jq -r .answered <<<"$BODY"); handoffs row reason=$(rows handoffs question "$Qb" | jq -r '.[0].reason')"
Qc="Stub: maybe finance? $RUN"
post $SS "$(jq -nc --arg q "$Qc" '{question:$q}')" 'x-stub-llm: {"answer":"Perhaps.","supported":true,"confidence":0.4,"source_faq_ids":["faq-07"]}'
expect "support (AI stubbed): confidence 0.4 (< 0.6) -> refusal + handoff row" "$([ "$(jq -r .answered <<<"$BODY")" = false ] && [ "$(rows handoffs question "$Qc" | jq -r '.[0].reason')" = low_confidence ] && echo true)" "answered=$(jq -r .answered <<<"$BODY"); handoffs row reason=$(rows handoffs question "$Qc" | jq -r '.[0].reason') confidence=$(rows handoffs question "$Qc" | jq -r '.[0].confidence')"
Qd="Stub: invented source? $RUN"
post $SS "$(jq -nc --arg q "$Qd" '{question:$q}')" 'x-stub-llm: {"answer":"Yes.","supported":true,"confidence":0.95,"source_faq_ids":["faq-99"]}'
expect "support (AI stubbed): confident answer citing a FAQ id that does not exist -> refused" "$([ "$(jq -r .answered <<<"$BODY")" = false ] && [ "$(rows handoffs question "$Qd" | jq -r '.[0].reason')" = no_valid_source ] && echo true)" "answered=$(jq -r .answered <<<"$BODY"); handoffs row reason=$(rows handoffs question "$Qd" | jq -r '.[0].reason')"
node scripts/stub-variant.mjs delete support-bot-with-fallback "Answer From FAQ" >/dev/null

echo "== error-handler"
curl -s "$BASE/webhook/error-demo" >/dev/null
got=0; for i in $(seq 1 15); do got=$(rows workflow_errors workflow_name error-demo | jq 'length'); [ "$got" -ge 1 ] && break; sleep 1; done
row=$(rows workflow_errors workflow_name error-demo | jq -c '.[-1]')
expect "error-handler: an unexpected crash in another workflow is logged" "$([ "$got" -ge 1 ] && echo true)" "workflow_errors row: workflow=$(jq -r .workflow_name <<<"$row") node=$(jq -r .node <<<"$row") message=\"$(jq -r .message <<<"$row")\" execution_id=$(jq -r .execution_id <<<"$row")"

echo "== support eval (20 questions)"
EVAL_ID=$(jq -r '.["support-bot-eval"]' data/ids.json)
before=$(curl -s -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables/$(tid eval_runs)/rows" | jq '.data|length')
n8n execute --id "$EVAL_ID" >/dev/null 2>&1
after=$(curl -s -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables/$(tid eval_runs)/rows" | jq '.data|length')
last=$(curl -s -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables/$(tid eval_runs)/rows" | jq -c '.data|last|del(.details)')
expect "eval: runs the 20-question set against the bot and writes a row to eval_runs" "$([ "$after" -eq $((before+1)) ] && [ "$(jq -r .total <<<"$last")" = 20 ] && echo true)" "eval_runs rows $before -> $after; $last; AI key present: $([ -n "$GEM" ] && echo yes || echo NO, so every question fell back to a handoff)"

{
  echo "# Test results"
  echo
  echo "- Run: $(date '+%Y-%m-%d %H:%M %Z') (run id $RUN)"
  echo "- n8n version: $(n8n --version 2>/dev/null)"
  echo "- Gemini key available: $([ -n "$GEM" ] && echo yes || echo 'no (AI paths marked below)')"
  echo "- Result: **$PASS passed, $FAIL failed**"
  echo "- Every case reads the outcome back from the Data Tables through the n8n API; the evidence column is the measured value."
  echo "- \"AI stubbed\" cases replace only the Gemini step with a fixed answer (header x-stub-llm); every node after it is the real workflow."
  echo
  echo "| Case | Result | Evidence |"
  echo "|---|---|---|"
  printf '%s' "$ROWS"
} > $OUT
echo "PASS=$PASS FAIL=$FAIL -> $OUT"
[ "$FAIL" = 0 ]
