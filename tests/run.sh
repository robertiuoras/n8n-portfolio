#!/usr/bin/env bash
# End-to-end tests against the local n8n (http://localhost:5678). Every outcome is proven by reading Data Table
# rows back through the n8n API, not just by looking at HTTP codes. Writes tests/RESULTS.md.
# Needs: curl, jq, node, the N8N_LOCAL_API_KEY secret.  Takes about 9 minutes (the timeout cases wait on purpose and
# both evals pace one question every 8 s for the Gemini free tier).
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
rows() { local f; f=$(jq -rn --arg c "$2" --arg v "$3" '{type:"and",filters:[{columnName:$c,condition:"eq",value:$v}]}|tojson|@uri')
  curl -s -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables/$(tid "$1")/rows?filter=$f" | jq -c '.data'; }
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
  expect "lead: REAL Gemini call returns a valid qualification and the lead is saved" "$([ "$CODE" = 200 ] && [ "$(jq -r .used_fallback <<<"$BODY")" = false ] && [ "$(jq -r '.qualification.score|type' <<<"$BODY")" = number ] && [ "$(count mock_crm_contacts email $EL)" = 1 ] && echo true)" "HTTP $CODE in ${TIME}s $(jq -c '{qualification,hot_lead_notified}' <<<"$BODY"); CRM contacts=$(count mock_crm_contacts email $EL), notifications=$(count notifications email $EL)"
else
  expect "lead: AI unavailable (no Gemini key) -> falls back to needs_human=true, still saved to CRM, no hot-lead alert" "$([ "$CODE" = 200 ] && [ "$(jq -r .used_fallback <<<"$BODY")" = true ] && [ "$(jq -r .qualification.needs_human <<<"$BODY")" = true ] && [ "$(count mock_crm_contacts email $EL)" = 1 ] && [ "$(count notifications email $EL)" = 0 ] && echo true)" "HTTP $CODE used_fallback=$(jq -r .used_fallback <<<"$BODY") reason=\"$(jq -r .fallback_reason <<<"$BODY")\"; CRM contacts=$(count mock_crm_contacts email $EL), notifications=$(count notifications email $EL)"
fi
# AI-dependent branches: Gemini chain replaced by a stub that returns the JSON in header x-stub-llm. Everything after it is the real wiring.
node scripts/stub-variant.mjs create ai-lead-qualify "Qualify Lead" >/dev/null
STUB=$BASE/webhook/lead-stub
EH="hot-$RUN@demo.test"
post $STUB "$(jq -nc --arg e $EH '{name:"Hot Hana",email:$e,message:"Need it now, budget 20k"}')" 'x-stub-llm: {"intent":"buy","budget_mentioned":"20k","urgency":"high","score":92,"summary":"Ready to buy","needs_human":false}'
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
EO="outage-$RUN@demo.test"
post $STUB "$(jq -nc --arg e $EO '{name:"Outage Olly",email:$e,message:"Please call me about a quote"}')" 'x-stub-llm: error'
expect "lead (AI stubbed): AI outage -> needs_human=true fallback, still saved to CRM, no hot-lead alert" "$([ "$CODE" = 200 ] && [ "$(jq -r .used_fallback <<<"$BODY")" = true ] && [ "$(jq -r .qualification.needs_human <<<"$BODY")" = true ] && [ "$(count mock_crm_contacts email $EO)" = 1 ] && [ "$(count notifications email $EO)" = 0 ] && echo true)" "HTTP $CODE used_fallback=$(jq -r .used_fallback <<<"$BODY") reason=\"$(jq -r .fallback_reason <<<"$BODY")\"; CRM contacts=$(count mock_crm_contacts email $EO), notifications=$(count notifications email $EO)"
node scripts/stub-variant.mjs delete ai-lead-qualify "Qualify Lead" >/dev/null

echo "== support-bot-with-fallback"
SUP=$BASE/webhook/support
post $SUP '{}'
expect "support: missing question is rejected (400)" "$([ "$CODE" = 400 ] && echo true)" "HTTP $CODE"
Q1="How long does the install take? ($RUN)"
post $SUP "$(jq -nc --arg q "$Q1" '{question:$q}')"
if [ -n "$GEM" ]; then
  expect "support: REAL Gemini answers an in-FAQ question from the right FAQ entry" "$([ "$(jq -r .answered <<<"$BODY")" = true ] && [ "$(jq -r '.sources|index("faq-03") != null' <<<"$BODY")" = true ] && [ "$(count handoffs question "$Q1")" = 0 ] && echo true)" "HTTP $CODE in ${TIME}s $(jq -c . <<<"$BODY"); handoffs rows=$(count handoffs question "$Q1")"
  Q2="What will the weather be in Sydney tomorrow? ($RUN)"
  post $SUP "$(jq -nc --arg q "$Q2" '{question:$q}')"
  h2=$(rows handoffs question "$Q2" | jq -r '.[0].reason')
  expect "support: REAL Gemini refuses a question the FAQ does not cover and hands it off" "$([ "$(jq -r .answered <<<"$BODY")" = false ] && [ "$(count handoffs question "$Q2")" = 1 ] && [ "${h2#ai_}" = "$h2" ] && echo true)" "HTTP $CODE answered=$(jq -r .answered <<<"$BODY"); handoffs row reason=$h2"
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
Qe="Stub: outage? $RUN"
post $SS "$(jq -nc --arg q "$Qe" '{question:$q}')" 'x-stub-llm: error'
expect "support (AI stubbed): AI outage -> honest refusal and a handoff row" "$([ "$CODE" = 200 ] && [ "$(jq -r .answered <<<"$BODY")" = false ] && [ "$(rows handoffs question "$Qe" | jq -r '.[0].reason')" = ai_unavailable ] && echo true)" "HTTP $CODE answered=$(jq -r .answered <<<"$BODY"); handoffs row reason=$(rows handoffs question "$Qe" | jq -r '.[0].reason')"
node scripts/stub-variant.mjs delete support-bot-with-fallback "Answer From FAQ" >/dev/null

echo "== rag-docs (RAG over documents)"
ING=$BASE/webhook/rag/ingest; ASK=$BASE/webhook/rag/ask
# ingest <doc_id> <file> [url]: posts a markdown file from docs/ as {doc_id, title, text}
ingest() { post "${3:-$ING}" "$(jq -nc --arg d "$1" --arg t "$(head -1 "$2" | sed 's/^# //')" --rawfile x "$2" '{doc_id:$d,title:$t,text:$x}')"; }
post $ING '{"doc_id":"Bad Id!","title":"","text":""}'
expect "rag ingest: invalid document is rejected (400) with reasons" "$([ "$CODE" = 400 ] && [ "$(jq '.reasons|length' <<<"$BODY")" = 3 ] && echo true)" "HTTP $CODE reasons=$(jq -c .reasons <<<"$BODY")"
ok=true; ev=""
for f in docs/*.md; do d=$(basename "$f" .md); ingest "$d" "$f"
  n=$(jq -r .chunks <<<"$BODY"); stored=$(rows rag_chunks doc_id "$d"); s=$(jq 'length' <<<"$stored"); u=$(jq '[.[].chunk_id]|unique|length' <<<"$stored")
  { [ "$CODE" = 200 ] && [ "$s" = "$n" ] && [ "$u" = "$n" ]; } || ok=false; ev+="$d: HTTP $CODE, $n chunks, $s rows stored ($u distinct); "; done
expect "rag ingest: every document re-ingested; each is stored once, the old copy replaced, not doubled" "$ok" "$ev"
before=$(rows rag_chunks doc_id price-sheet | jq -c '[length, (map(.ingested_at)|unique)]')
node scripts/stub-variant.mjs create rag-ingest "Embed Chunk" >/dev/null
ingest price-sheet docs/price-sheet.md $BASE/webhook/rag/ingest-stub
node scripts/stub-variant.mjs delete rag-ingest "Embed Chunk" >/dev/null
after=$(rows rag_chunks doc_id price-sheet | jq -c '[length, (map(.ingested_at)|unique)]')
expect "rag ingest (embeddings API down): 502 and the stored copy of the document is left untouched" "$([ "$CODE" = 502 ] && [ "$before" = "$after" ] && echo true)" "HTTP $CODE failed chunks=$(jq '.failed|length' <<<"$BODY") first error status=$(jq -r '.failed[0].status' <<<"$BODY"); price-sheet rows [count, ingested_at] before=$before after=$after"
post $ASK '{}'
expect "rag ask: missing question is rejected (400)" "$([ "$CODE" = 400 ] && echo true)" "HTTP $CODE"
if [ -n "$GEM" ]; then
  R1="How much is the 8.8 kW system? ($RUN)"
  post $ASK "$(jq -nc --arg q "$R1" '{question:$q}')"
  expect "rag ask: REAL Gemini answers from the price sheet, quotes the figure and cites the chunk it used" "$([ "$(jq -r .answered <<<"$BODY")" = true ] && jq -e '[.citations[].chunk_id|startswith("price-sheet#")]|any' <<<"$BODY" >/dev/null && jq -e '.answer|test("6,?990")' <<<"$BODY" >/dev/null && [ "$(count rag_handoffs question "$R1")" = 0 ] && echo true)" "HTTP $CODE in ${TIME}s $(jq -c '{answer,citations:[.citations[].chunk_id],confidence,top:.retrieved[0]}' <<<"$BODY"); handoffs rows=$(count rag_handoffs question "$R1")"
  R2="What is the capital of France? ($RUN)"
  post $ASK "$(jq -nc --arg q "$R2" '{question:$q}')"
  h=$(rows rag_handoffs question "$R2" | jq -r '.[0].reason')
  expect "rag ask: REAL Gemini refuses a question the documents do not cover and hands it off" "$([ "$(jq -r .answered <<<"$BODY")" = false ] && [ "$(count rag_handoffs question "$R2")" = 1 ] && [ "${h#ai_}" = "$h" ] && [ "$h" != retrieval_unavailable ] && echo true)" "HTTP $CODE answered=$(jq -r .answered <<<"$BODY"); handoffs row reason=$h top_score=$(rows rag_handoffs question "$R2" | jq -r '.[0].top_score')"
fi
node scripts/stub-variant.mjs create rag-ask "Embed Question" >/dev/null
R3="Embeddings down: warranty? $RUN"
post $BASE/webhook/rag/ask-stub "$(jq -nc --arg q "$R3" '{question:$q}')"
node scripts/stub-variant.mjs delete rag-ask "Embed Question" >/dev/null
expect "rag ask (embeddings API down): honest refusal and a handoff row, the AI is never asked" "$([ "$CODE" = 200 ] && [ "$(jq -r .answered <<<"$BODY")" = false ] && [ "$(rows rag_handoffs question "$R3" | jq -r '.[0].reason')" = retrieval_unavailable ] && echo true)" "HTTP $CODE answered=$(jq -r .answered <<<"$BODY"); handoffs row reason=$(rows rag_handoffs question "$R3" | jq -r '.[0].reason')"
node scripts/stub-variant.mjs create rag-ask "Answer From Docs" >/dev/null
RS=$BASE/webhook/rag/ask-stub
Ra="How much is the 8.8 kW system? stub $RUN"
post $RS "$(jq -nc --arg q "$Ra" '{question:$q}')" 'x-stub-llm: {"answer":"It is $6,990.","supported":true,"confidence":0.95,"cited_chunk_ids":["price-sheet#2"]}'
expect "rag ask (AI stubbed): supported, confident, cites a retrieved chunk -> answered with that citation" "$([ "$(jq -r .answered <<<"$BODY")" = true ] && [ "$(jq -r '.citations[0].chunk_id' <<<"$BODY")" = price-sheet#2 ] && [ "$(count rag_handoffs question "$Ra")" = 0 ] && echo true)" "HTTP $CODE $(jq -c '{answered,citations,retrieved:[.retrieved[].chunk_id]}' <<<"$BODY")"
Rb="How much is the 8.8 kW system? cite-check $RUN"
post $RS "$(jq -nc --arg q "$Rb" '{question:$q}')" 'x-stub-llm: {"answer":"It is $6,990.","supported":true,"confidence":0.95,"cited_chunk_ids":["warranty-terms#3"]}'
expect "rag ask (AI stubbed): cites a real chunk that was NOT retrieved for this question -> refused" "$([ "$(jq -r .answered <<<"$BODY")" = false ] && [ "$(rows rag_handoffs question "$Rb" | jq -r '.[0].reason')" = citation_not_retrieved ] && echo true)" "answered=$(jq -r .answered <<<"$BODY"); retrieved=$(jq -c '[.retrieved[].chunk_id]' <<<"$BODY"); handoffs row reason=$(rows rag_handoffs question "$Rb" | jq -r '.[0].reason')"
Rc="Panel output after 25 years? lowconf $RUN"
post $RS "$(jq -nc --arg q "$Rc" '{question:$q}')" 'x-stub-llm: {"answer":"Maybe 80 percent.","supported":true,"confidence":0.4,"cited_chunk_ids":["warranty-terms#3"]}'
expect "rag ask (AI stubbed): confidence 0.4 (< 0.6) -> refusal + handoff row" "$([ "$(jq -r .answered <<<"$BODY")" = false ] && [ "$(rows rag_handoffs question "$Rc" | jq -r '.[0].reason')" = low_confidence ] && echo true)" "answered=$(jq -r .answered <<<"$BODY"); handoffs row reason=$(rows rag_handoffs question "$Rc" | jq -r '.[0].reason') confidence=$(rows rag_handoffs question "$Rc" | jq -r '.[0].confidence')"
Rd="EV charger price? unsupported $RUN"
post $RS "$(jq -nc --arg q "$Rd" '{question:$q}')" 'x-stub-llm: {"answer":"","supported":false,"confidence":0.1,"cited_chunk_ids":[]}'
expect "rag ask (AI stubbed): supported=false -> refusal + handoff row" "$([ "$(jq -r .answered <<<"$BODY")" = false ] && [ "$(rows rag_handoffs question "$Rd" | jq -r '.[0].reason')" = not_in_docs ] && echo true)" "answered=$(jq -r .answered <<<"$BODY"); handoffs row reason=$(rows rag_handoffs question "$Rd" | jq -r '.[0].reason')"
Re="Warranty? outage $RUN"
post $RS "$(jq -nc --arg q "$Re" '{question:$q}')" 'x-stub-llm: error'
expect "rag ask (AI stubbed): AI outage -> honest refusal and a handoff row" "$([ "$CODE" = 200 ] && [ "$(jq -r .answered <<<"$BODY")" = false ] && [ "$(rows rag_handoffs question "$Re" | jq -r '.[0].reason')" = ai_unavailable ] && echo true)" "HTTP $CODE answered=$(jq -r .answered <<<"$BODY"); handoffs row reason=$(rows rag_handoffs question "$Re" | jq -r '.[0].reason')"
node scripts/stub-variant.mjs delete rag-ask "Answer From Docs" >/dev/null

echo "== error-handler"
curl -s "$BASE/webhook/error-demo" >/dev/null
got=0; for i in $(seq 1 15); do got=$(rows workflow_errors workflow_name error-demo | jq 'length'); [ "$got" -ge 1 ] && break; sleep 1; done
row=$(rows workflow_errors workflow_name error-demo | jq -c '.[-1]')
expect "error-handler: an unexpected crash in another workflow is logged" "$([ "$got" -ge 1 ] && echo true)" "workflow_errors row: workflow=$(jq -r .workflow_name <<<"$row") node=$(jq -r .node <<<"$row") message=\"$(jq -r .message <<<"$row")\" execution_id=$(jq -r .execution_id <<<"$row")"

echo "== support eval (20 questions)"
EVAL_ID=$(jq -r '.["support-bot-eval"]' data/ids.json)
before=$(curl -s -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables/$(tid eval_runs)/rows" | jq '.data|length')
node scripts/run-manual.mjs support-bot-eval "Run Eval" >/dev/null 2>&1
for i in $(seq 1 150); do c=$(curl -s -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables/$(tid eval_runs)/rows" | jq '.data|length'); [ "$c" -gt "$before" ] && break; sleep 2; done
after=$(curl -s -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables/$(tid eval_runs)/rows" | jq '.data|length')
last=$(curl -s -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables/$(tid eval_runs)/rows" | jq -c '.data|last|del(.details)')
if [ -n "$GEM" ]; then
  expect "eval: 20-question set against the REAL bot, every question reached Gemini, row written to eval_runs" "$([ "$after" -eq $((before+1)) ] && [ "$(jq -r .total <<<"$last")" = 20 ] && [ "$(jq -r .ai_unavailable <<<"$last")" = 0 ] && echo true)" "eval_runs rows $before -> $after; $last"
  EVAL_DETAILS=$(curl -s -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables/$(tid eval_runs)/rows" | jq -r '.data|last|.details|fromjson|.[]|"| \(.n) | \(.q) | \(.verdict) | \(.reason // "") |"')
else
  expect "eval: runs the 20-question set against the bot and writes a row to eval_runs" "$([ "$after" -eq $((before+1)) ] && [ "$(jq -r .total <<<"$last")" = 20 ] && echo true)" "eval_runs rows $before -> $after; $last; AI key present: NO, so every question fell back to a handoff"
fi

echo "== rag eval (20 questions)"
rb=$(curl -s -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables/$(tid rag_eval_runs)/rows" | jq '.data|length')
node scripts/run-manual.mjs rag-eval "Run Eval" >/dev/null 2>&1
for i in $(seq 1 150); do c=$(curl -s -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables/$(tid rag_eval_runs)/rows" | jq '.data|length'); [ "$c" -gt "$rb" ] && break; sleep 2; done
ra=$(curl -s -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables/$(tid rag_eval_runs)/rows" | jq '.data|length')
rlast=$(curl -s -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables/$(tid rag_eval_runs)/rows" | jq -c '.data|last|del(.details,.createdAt,.updatedAt)')
if [ -n "$GEM" ]; then
  expect "rag eval: 20 questions against the REAL pipeline, none lost to an outage, row written to rag_eval_runs" "$([ "$ra" -eq $((rb+1)) ] && [ "$(jq -r .total <<<"$rlast")" = 20 ] && [ "$(jq -r .ai_unavailable <<<"$rlast")" = 0 ] && echo true)" "rag_eval_runs rows $rb -> $ra; $rlast"
  RAG_DETAILS=$(curl -s -H "X-N8N-API-KEY: $KEY" "$BASE/api/v1/data-tables/$(tid rag_eval_runs)/rows" | jq -r '.data|last|.details|fromjson|.[]|"| \(.n) | \(.q) | \(.kind) | \(if .retrieval_hit == null then "" else (.retrieval_hit|tostring) end) | \(.top_score) | \(.verdict) | \(.reason // "") |"')
else
  expect "rag eval: runs the 20-question set and writes a row to rag_eval_runs" "$([ "$ra" -eq $((rb+1)) ] && [ "$(jq -r .total <<<"$rlast")" = 20 ] && echo true)" "rag_eval_runs rows $rb -> $ra; $rlast; AI key present: NO"
fi

{
  echo "# Test results"
  echo
  echo "- Run: $(date '+%Y-%m-%d %H:%M %Z') (run id $RUN)"
  echo "- n8n version: $(n8n --version 2>/dev/null)"
  echo "- Gemini key available: $([ -n "$GEM" ] && echo "yes (free tier, model $(node -e "import('./scripts/lib.mjs').then(m=>console.log(m.LLM_MODEL))"))" || echo 'no (AI paths marked below)')"
  echo "- Result: **$PASS passed, $FAIL failed**"
  echo "- Every case reads the outcome back from the Data Tables through the n8n API; the evidence column is the measured value."
  echo "- \"AI stubbed\" cases replace only the Gemini step with a fixed answer (header x-stub-llm); every node after it is the real workflow."
  echo
  echo "| Case | Result | Evidence |"
  echo "|---|---|---|"
  printf '%s' "$ROWS"
  if [ -n "${EVAL_DETAILS:-}" ]; then
    echo; echo "## Eval answers (latest run, real Gemini)"; echo
    echo "| # | Question | Verdict | Bot reason |"; echo "|---|---|---|---|"
    printf '%s\n' "$EVAL_DETAILS"
  fi
  if [ -n "${RAG_DETAILS:-}" ]; then
    echo; echo "## RAG eval answers (latest run, real Gemini)"; echo
    echo "Retrieval hit = a chunk from the expected document was in the top 4. Top score = cosine similarity of the best chunk."; echo
    echo "| # | Question | Kind | Retrieval hit | Top score | Verdict | Bot reason |"; echo "|---|---|---|---|---|---|---|"
    printf '%s\n' "$RAG_DETAILS"
  fi
} > $OUT
echo "PASS=$PASS FAIL=$FAIL -> $OUT"
[ "$FAIL" = 0 ]
