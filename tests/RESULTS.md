# Test results

- Run: 2026-10-09 09:04 AEST (run id 1791500623)
- n8n version: 2.42.5
- Gemini key available: no (AI paths marked below)
- Result: **25 passed, 1 failed**
- Every case reads the outcome back from the Data Tables through the n8n API; the evidence column is the measured value.
- "AI stubbed" cases replace only the Gemini step with a fixed answer (header x-stub-llm); every node after it is the real workflow.

| Case | Result | Evidence |
|---|---|---|
| chatbot: happy path creates the contact | PASS | HTTP 200, body {"status":"synced","crm_action":"created","attempts":1}; crm_sent rows for key=1, mock CRM contacts for email=1 |
| chatbot: same payload again is a duplicate and the CRM is not called | PASS | HTTP 200 status=duplicate; CRM calls before=1 after=1; crm_sent rows still 1 |
| chatbot: existing email is updated, not created again | PASS | HTTP 200 crm_action=updated existed_before=true; contact rows for email=1, version=2 |
| chatbot: unapproved summary is ignored (202) | PASS | HTTP 202 status=ignored; CRM calls for email=0, contacts=0 |
| chatbot: missing email is rejected (400) with a reason | PASS | HTTP 400 reasons=["customer.email is missing or not a valid email"] |
| chatbot: CRM fails twice (500) then succeeds on the third try | PASS | HTTP 200 attempts=3 in 4s; CRM call log outcomes=["injected_500x2","injected_500x2","ok"]; crm_sent rows=1 |
| chatbot: CRM answers 400 -> no retry, error logged, caller gets 502 | PASS | HTTP 502 attempts=1; CRM calls=1; crm_errors row: step=crm_upsert http_status=400 payload.email=bad400-1791500623@demo.test |
| chatbot: CRM hangs (timeout) -> retried 3 times, then logged, caller gets 502 | PASS | HTTP 502 attempts=3 in 33s; CRM calls=3; crm_errors error="timeout of 10000ms exceeded" |
| chatbot: CRM answers 429 -> retried 3 times, then logged | PASS | HTTP 502; CRM calls=3; crm_errors http_status=429 |
| chatbot: CRM answers 500 every time -> 3 tries, then logged | PASS | HTTP 502; CRM calls=3; crm_errors rows=1 |
| mock CRM: GET finds an existing contact | PASS | HTTP 200 {"email":"happy-1791500623@demo.test","version":2} |
| mock CRM: GET on an unknown email is 404 | PASS | HTTP 404 |
| lead: invalid input is rejected (400) | PASS | HTTP 400 reasons=["email is missing or not valid","message is required"] |
| lead: AI unavailable (no Gemini key) -> falls back to needs_human=true, still saved to CRM, no hot-lead alert | PASS | HTTP 200 used_fallback=true reason="ai_unavailable: Error in sub-node Gemini Chat Model"; CRM contacts=1, notifications=0 |
| lead (AI stubbed): score 92 -> hot-lead notification row written | FAIL | HTTP 400 hot_lead_notified=null; notifications rows=0 score=null; CRM contacts=0 |
| lead (AI stubbed): score 30 -> saved to CRM, no notification | PASS | HTTP 200; notifications rows=0; CRM contacts=1 |
| lead (AI stubbed): unusable AI output -> needs_human=true fallback instead of an error | PASS | HTTP 200 used_fallback=true reason=ai_output_unusable |
| lead (AI stubbed): CRM fails twice then succeeds (same retry pattern) | PASS | HTTP 200; CRM calls=3; notifications=1 |
| support: missing question is rejected (400) | PASS | HTTP 400 |
| support: AI unavailable (no Gemini key) -> honest refusal and a handoff row | PASS | HTTP 200 answered=false reason=ai_unavailable; handoffs rows=1 |
| support (AI stubbed): supported, confident, valid source -> answered, no handoff | PASS | HTTP 200 {"answered":true,"sources":["faq-03"],"confidence":0.92}; handoffs rows=0 |
| support (AI stubbed): supported=false -> refusal + handoff row | PASS | answered=false; handoffs row reason=not_in_faq |
| support (AI stubbed): confidence 0.4 (< 0.6) -> refusal + handoff row | PASS | answered=false; handoffs row reason=low_confidence confidence=0.4 |
| support (AI stubbed): confident answer citing a FAQ id that does not exist -> refused | PASS | answered=false; handoffs row reason=no_valid_source |
| error-handler: an unexpected crash in another workflow is logged | PASS | workflow_errors row: workflow=error-demo node=Always Fails message="Deliberate demo failure: this is how an unexpected crash is caught and logged [line 1]" execution_id=214 |
| eval: runs the 20-question set against the bot and writes a row to eval_runs | PASS | eval_runs rows 1 -> 2; {"run_at":"2026-10-08T23:04:47.390Z","total":20,"answerable":14,"unanswerable":6,"accuracy":0.3,"correct_refusal_rate":1,"wrong_answers":0,"missed_answers":14,"ai_unavailable":20,"id":2,"createdAt":"2026-10-08T23:04:47.410Z","updatedAt":"2026-10-08T23:04:47.410Z"}; AI key present: NO, so every question fell back to a handoff |
