# Test results

- Run: 2026-10-17 21:08 AEST (run id 1792234840)
- n8n version: 2.42.5
- Gemini key available: yes (free tier, model models/gemini-3.5-flash-lite)
- Result: **42 passed, 0 failed**
- Every case reads the outcome back from the Data Tables through the n8n API; the evidence column is the measured value.
- "AI stubbed" cases replace only the Gemini step with a fixed answer (header x-stub-llm); every node after it is the real workflow.

| Case | Result | Evidence |
|---|---|---|
| chatbot: happy path creates the contact | PASS | HTTP 200, body {"status":"synced","crm_action":"created","attempts":1}; crm_sent rows for key=1, mock CRM contacts for email=1 |
| chatbot: same payload again is a duplicate and the CRM is not called | PASS | HTTP 200 status=duplicate; CRM calls before=1 after=1; crm_sent rows still 1 |
| chatbot: existing email is updated, not created again | PASS | HTTP 200 crm_action=updated existed_before=true; contact rows for email=1, version=2 |
| chatbot: unapproved summary is ignored (202) | PASS | HTTP 202 status=ignored; CRM calls for email=0, contacts=0 |
| chatbot: missing email is rejected (400) with a reason | PASS | HTTP 400 reasons=["customer.email is missing or not a valid email"] |
| chatbot: CRM fails twice (500) then succeeds on the third try | PASS | HTTP 200 attempts=3 in 3s; CRM call log outcomes=["injected_500x2","injected_500x2","ok"]; crm_sent rows=1 |
| chatbot: CRM answers 400 -> no retry, error logged, caller gets 502 | PASS | HTTP 502 attempts=1; CRM calls=1; crm_errors row: step=crm_upsert http_status=400 payload.email=bad400-1792234840@demo.test |
| chatbot: CRM hangs (timeout) -> retried 3 times, then logged, caller gets 502 | PASS | HTTP 502 attempts=3 in 33s; CRM calls=3; crm_errors error="timeout of 10000ms exceeded" |
| chatbot: CRM answers 429 -> retried 3 times, then logged | PASS | HTTP 502; CRM calls=3; crm_errors http_status=429 |
| chatbot: CRM answers 500 every time -> 3 tries, then logged | PASS | HTTP 502; CRM calls=3; crm_errors rows=1 |
| mock CRM: GET finds an existing contact | PASS | HTTP 200 {"email":"happy-1792234840@demo.test","version":2} |
| mock CRM: GET on an unknown email is 404 | PASS | HTTP 404 |
| lead: invalid input is rejected (400) | PASS | HTTP 400 reasons=["email is missing or not valid","message is required"] |
| lead: REAL Gemini call returns a valid qualification and the lead is saved | PASS | HTTP 200 in 1s {"qualification":{"intent":"Automate booking reminders","budget_mentioned":"$4k","urgency":"high","score":95,"summary":"A clinic operator with a $4k budget wants to start automating booking reminders this month.","needs_human":false},"hot_lead_notified":true}; CRM contacts=1, notifications=1 |
| lead (AI stubbed): score 92 -> hot-lead notification row written | PASS | HTTP 200 hot_lead_notified=true; notifications rows=1 score=92; CRM contacts=1 |
| lead (AI stubbed): score 30 -> saved to CRM, no notification | PASS | HTTP 200; notifications rows=0; CRM contacts=1 |
| lead (AI stubbed): unusable AI output -> needs_human=true fallback instead of an error | PASS | HTTP 200 used_fallback=true reason=ai_output_unusable |
| lead (AI stubbed): CRM fails twice then succeeds (same retry pattern) | PASS | HTTP 200; CRM calls=3; notifications=1 |
| lead (AI stubbed): AI outage -> needs_human=true fallback, still saved to CRM, no hot-lead alert | PASS | HTTP 200 used_fallback=true reason="ai_unavailable: stubbed AI outage [line 1]"; CRM contacts=1, notifications=0 |
| support: missing question is rejected (400) | PASS | HTTP 400 |
| support: REAL Gemini answers an in-FAQ question from the right FAQ entry | PASS | HTTP 200 in 1s {"answered":true,"answer":"A typical home system is installed in one to two days after approvals are in place.","sources":["faq-03"],"confidence":1}; handoffs rows=0 |
| support: REAL Gemini refuses a question the FAQ does not cover and hands it off | PASS | HTTP 200 answered=false; handoffs row reason=not_in_faq |
| support (AI stubbed): supported, confident, valid source -> answered, no handoff | PASS | HTTP 200 {"answered":true,"sources":["faq-03"],"confidence":0.92}; handoffs rows=0 |
| support (AI stubbed): supported=false -> refusal + handoff row | PASS | answered=false; handoffs row reason=not_in_faq |
| support (AI stubbed): confidence 0.4 (< 0.6) -> refusal + handoff row | PASS | answered=false; handoffs row reason=low_confidence confidence=0.4 |
| support (AI stubbed): confident answer citing a FAQ id that does not exist -> refused | PASS | answered=false; handoffs row reason=no_valid_source |
| support (AI stubbed): AI outage -> honest refusal and a handoff row | PASS | HTTP 200 answered=false; handoffs row reason=ai_unavailable |
| rag ingest: invalid document is rejected (400) with reasons | PASS | HTTP 400 reasons=["doc_id is required: 2-60 lowercase letters, digits or dashes","title is required","text is required (the document in markdown)"] |
| rag ingest: every document re-ingested; each is stored once, the old copy replaced, not doubled | PASS | installation-guide: HTTP 200, 8 chunks, 8 rows stored (8 distinct); price-sheet: HTTP 200, 8 chunks, 8 rows stored (8 distinct); privacy-policy: HTTP 200, 8 chunks, 8 rows stored (8 distinct); warranty-terms: HTTP 200, 9 chunks, 9 rows stored (9 distinct);  |
| rag ingest (embeddings API down): 502 and the stored copy of the document is left untouched | PASS | HTTP 502 failed chunks=8 first error status=404; price-sheet rows [count, ingested_at] before=[8,["2026-10-17T11:02:18.326Z"]] after=[8,["2026-10-17T11:02:18.326Z"]] |
| rag ask: missing question is rejected (400) | PASS | HTTP 400 |
| rag ask: REAL Gemini answers from the price sheet, quotes the figure and cites the chunk it used | PASS | HTTP 200 in 2s {"answer":"The 8.8 kW system is priced at $6,990.","citations":["price-sheet#2"],"confidence":1,"top":{"chunk_id":"price-sheet#2","doc_id":"price-sheet","score":0.778}}; handoffs rows=0 |
| rag ask: REAL Gemini refuses a question the documents do not cover and hands it off | PASS | HTTP 200 answered=false; handoffs row reason=nothing_relevant top_score=0.551 |
| rag ask (embeddings API down): honest refusal and a handoff row, the AI is never asked | PASS | HTTP 200 answered=false; handoffs row reason=retrieval_unavailable |
| rag ask (AI stubbed): supported, confident, cites a retrieved chunk -> answered with that citation | PASS | HTTP 200 {"answered":true,"citations":[{"chunk_id":"price-sheet#2","title":"Acme Solar Price Sheet","section":"1. Solar packages"}],"retrieved":["price-sheet#2","price-sheet#3","price-sheet#1","price-sheet#8"]} |
| rag ask (AI stubbed): cites a real chunk that was NOT retrieved for this question -> refused | PASS | answered=false; retrieved=["price-sheet#2","price-sheet#3","price-sheet#1","price-sheet#8"]; handoffs row reason=citation_not_retrieved |
| rag ask (AI stubbed): confidence 0.4 (< 0.6) -> refusal + handoff row | PASS | answered=false; handoffs row reason=low_confidence confidence=0.4 |
| rag ask (AI stubbed): supported=false -> refusal + handoff row | PASS | answered=false; handoffs row reason=not_in_docs |
| rag ask (AI stubbed): AI outage -> honest refusal and a handoff row | PASS | HTTP 200 answered=false; handoffs row reason=ai_unavailable |
| error-handler: an unexpected crash in another workflow is logged | PASS | workflow_errors row: workflow=error-demo node=Always Fails message="Deliberate demo failure: this is how an unexpected crash is caught and logged [line 1]" execution_id=654 |
| eval: 20-question set against the REAL bot, every question reached Gemini, row written to eval_runs | PASS | eval_runs rows 6 -> 7; {"run_at":"2026-10-17T11:05:43.821Z","total":20,"answerable":14,"unanswerable":6,"accuracy":1,"correct_refusal_rate":1,"wrong_answers":0,"missed_answers":0,"ai_unavailable":0,"id":7,"createdAt":"2026-10-17T11:05:43.832Z","updatedAt":"2026-10-17T11:05:43.832Z"} |
| rag eval: 20 questions against the REAL pipeline, none lost to an outage, row written to rag_eval_scores | PASS | rag_eval_scores rows 0 -> 1; {"run_at":"2026-10-17T11:08:18.274Z","total":20,"answerable":14,"unanswerable":6,"retrieval_hit_rate":1,"answer_accuracy":1,"correct_refusal_rate":1,"wrong_answers":0,"missed_answers":0,"ai_unavailable":0,"id":1} |

## Eval answers (latest run, real Gemini)

| # | Question | Verdict | Bot reason |
|---|---|---|---|
| 1 | How long does a typical home solar installation take? | correct |  |
| 2 | What warranty comes with the panels? | correct |  |
| 3 | Do you offer finance or payment plans? | correct |  |
| 4 | Will my system still work during a blackout? | correct |  |
| 5 | How do I get a quote? | correct |  |
| 6 | What are your support hours? | correct |  |
| 7 | Can I add a battery to an existing system later? | correct |  |
| 8 | Which areas do you install in? | correct |  |
| 9 | How much roof space do I need? | correct |  |
| 10 | How often do panels need cleaning? | correct |  |
| 11 | Is there a feed-in tariff paperwork you handle for me? | correct |  |
| 12 | How can I check my system's production? | correct |  |
| 13 | What is the warranty period on the solar panels? | correct |  |
| 14 | Do you serve customers outside the listed regions? | correct |  |
| 15 | What is the price of Bitcoin today? | correct refusal | not_in_faq |
| 16 | Can you install a swimming pool heater with wind turbines? | correct refusal | not_in_faq |
| 17 | Who won the football match last night? | correct refusal | not_in_faq |
| 18 | What is the CEO's home address? | correct refusal | not_in_faq |
| 19 | Do you sell electric cars? | correct refusal | not_in_faq |
| 20 | Can you give me legal advice about my landlord dispute? | correct refusal | not_in_faq |

## RAG eval answers (latest run, real Gemini)

Retrieval hit = a chunk from the expected document was in the top 4. Top score = cosine similarity of the best chunk.

| # | Question | Kind | Retrieval hit | Top score | Verdict | Bot reason |
|---|---|---|---|---|---|---|
| 1 | What happens to my warranty if I sell my house? | answerable | true | 0.804 | correct |  |
| 2 | How much output are the panels guaranteed to keep after 25 years? | answerable | true | 0.842 | correct |  |
| 3 | Can I extend my inverter warranty, and what does it cost? | answerable | true | 0.841 | correct |  |
| 4 | Is hail damage covered by the warranty? | answerable | true | 0.771 | correct |  |
| 5 | What time does the installation team arrive? | answerable | true | 0.737 | correct |  |
| 6 | Will my power be off while you install the system? | answerable | true | 0.808 | correct |  |
| 7 | Can you put panels on a roof that has asbestos in it? | answerable | true | 0.823 | correct |  |
| 8 | How long until my new meter is installed after the panels go in? | answerable | true | 0.844 | correct |  |
| 9 | Do you sell my personal information to anyone? | answerable | true | 0.758 | correct |  |
| 10 | How long do you keep my customer records? | answerable | true | 0.848 | correct |  |
| 11 | How much is the 8.8 kW system? | answerable | true | 0.817 | correct |  |
| 12 | Is there a fee for paying by credit card? | answerable | true | 0.701 | correct |  |
| 13 | Can I get my deposit back if I change my mind after signing? | answerable | true | 0.759 | correct |  |
| 14 | How much does a switchboard upgrade cost? | answerable | true | 0.822 | correct |  |
| 15 | How much does it cost to install an EV charger? | near-miss |  | 0.706 | correct refusal | not_in_docs |
| 16 | What brand of solar panels do you use? | near-miss |  | 0.727 | correct refusal | not_in_docs |
| 17 | How much is a 20 kW commercial system? | near-miss |  | 0.77 | correct refusal | not_in_docs |
| 18 | How long is the warranty on the backup gateway? | near-miss |  | 0.739 | correct refusal | not_in_docs |
| 19 | What is the capital of France? | off-topic |  | 0.536 | correct refusal | nothing_relevant |
| 20 | Can you recommend a good plumber near me? | off-topic |  | 0.573 | correct refusal | nothing_relevant |
