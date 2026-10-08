# Test results

- Run: 2026-10-09 08:57 AEST (run id 1791500218)
- n8n version: 2.42.5
- Gemini key available: no (AI paths marked below)
- Result: **7 passed, 19 failed**
- Every case reads the outcome back from the Data Tables through the n8n API; the evidence column is the measured value.
- "AI stubbed" cases replace only the Gemini step with a fixed answer (header x-stub-llm); every node after it is the real workflow.

| Case | Result | Evidence |
|---|---|---|
| chatbot: happy path creates the contact | FAIL | HTTP , body ; crm_sent rows for key=0, mock CRM contacts for email=0 |
| chatbot: same payload again is a duplicate and the CRM is not called | FAIL | HTTP  status=; CRM calls before=0 after=0; crm_sent rows still 0 |
| chatbot: existing email is updated, not created again | FAIL | HTTP  crm_action= existed_before=; contact rows for email=0, version=null |
| chatbot: unapproved summary is ignored (202) | FAIL | HTTP  status=; CRM calls for email=0, contacts=0 |
| chatbot: missing email is rejected (400) with a reason | FAIL | HTTP  reasons= |
| chatbot: CRM fails twice (500) then succeeds on the third try | PASS | HTTP 200 attempts=3 in 6s; CRM call log outcomes=["injected_500x2","injected_500x2","ok"]; crm_sent rows=1 |
| chatbot: CRM answers 400 -> no retry, error logged, caller gets 502 | PASS | HTTP 502 attempts=1; CRM calls=1; crm_errors row: step=crm_upsert http_status=400 payload.email=bad400-1791500218@demo.test |
| chatbot: CRM hangs (timeout) -> retried 3 times, then logged, caller gets 502 | PASS | HTTP 502 attempts=3 in 34s; CRM calls=3; crm_errors error="timeout of 10000ms exceeded" |
| chatbot: CRM answers 429 -> retried 3 times, then logged | PASS | HTTP 502; CRM calls=3; crm_errors http_status=429 |
| chatbot: CRM answers 500 every time -> 3 tries, then logged | PASS | HTTP 502; CRM calls=3; crm_errors rows=1 |
| mock CRM: GET finds an existing contact | FAIL | HTTP 404 {"email":null,"version":null} |
| mock CRM: GET on an unknown email is 404 | PASS | HTTP 404 |
| lead: invalid input is rejected (400) | FAIL | HTTP  reasons= |
| lead: AI unavailable (no Gemini key) -> falls back to needs_human=true, still saved to CRM, no hot-lead alert | FAIL | HTTP  used_fallback= reason=""; CRM contacts=0, notifications=0 |
| lead (AI stubbed): score 92 -> hot-lead notification row written | FAIL | HTTP 404 hot_lead_notified=null; notifications rows=0 score=null; CRM contacts=0 |
| lead (AI stubbed): score 30 -> saved to CRM, no notification | FAIL | HTTP 404; notifications rows=0; CRM contacts=0 |
| lead (AI stubbed): unusable AI output -> needs_human=true fallback instead of an error | FAIL | HTTP 404 used_fallback=null reason=null |
| lead (AI stubbed): CRM fails twice then succeeds (same retry pattern) | FAIL | HTTP 404; CRM calls=0; notifications=0 |
| support: missing question is rejected (400) | FAIL | HTTP  |
| support: AI unavailable (no Gemini key) -> honest refusal and a handoff row | FAIL | HTTP  answered= reason=; handoffs rows=0 |
| support (AI stubbed): supported, confident, valid source -> answered, no handoff | FAIL | HTTP 404 {"answered":null,"sources":null,"confidence":null}; handoffs rows=0 |
| support (AI stubbed): supported=false -> refusal + handoff row | FAIL | answered=false; handoffs row reason=null |
| support (AI stubbed): confidence 0.4 (< 0.6) -> refusal + handoff row | FAIL | answered=false; handoffs row reason=null confidence=null |
| support (AI stubbed): confident answer citing a FAQ id that does not exist -> refused | FAIL | answered=false; handoffs row reason=null |
| error-handler: an unexpected crash in another workflow is logged | PASS | workflow_errors row: workflow=error-demo node=Always Fails message="Deliberate demo failure: this is how an unexpected crash is caught and logged [line 1]" execution_id=87 |
| eval: runs the 20-question set against the bot and writes a row to eval_runs | FAIL | eval_runs rows 0 -> 0; null; AI key present: NO, so every question fell back to a handoff |
