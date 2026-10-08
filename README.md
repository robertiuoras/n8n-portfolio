# n8n automation portfolio (Robert Iuoras)

Four small automations built in n8n 2.42.5, each tested end to end. **These are my own demo builds using synthetic data. None of them is client work.** Everything runs on one laptop; the "CRM" is a stand-in (see below), so no third-party accounts are needed.

Test evidence: [tests/RESULTS.md](tests/RESULTS.md) (re-run any time with `bash tests/run.sh`). Canvas pictures: `screenshots/`. Importable workflow files: `workflows/`.

## The stand-in CRM (`mock-crm`)
A tiny fake CRM API built as an n8n workflow (create/update a contact, look one up, store it in an n8n Data Table). It can also fail on request (header `x-fail: 500 | 429 | 400 | timeout | 500x2`) so the error handling below can be proven rather than assumed. It is a **stand-in for a real CRM API**.

**Swapping in HubSpot, Pipedrive or GoHighLevel:** in each workflow, change the URL of the "CRM Upsert" (and "CRM Lookup") HTTP Request node to the real endpoint, attach that service's credential, and adjust the JSON body field names. The retry, duplicate and error-log logic around it does not change.

## 1. chatbot-to-crm
![canvas](screenshots/chatbot-to-crm.png)
**Problem it solves:** a website chatbot finishes a conversation and a person approves the summary. The summary must land in the CRM once, without double entries and without silently losing anything when the CRM is having a bad day.
**Failures and duplicates:** bad input is refused with a plain reason (400); unapproved summaries are ignored (202); a fingerprint of conversation + email stops the same summary being sent twice (the CRM is not even called); the CRM call has a 10 second limit and is retried up to 3 times with growing pauses, but only for temporary problems (rate limit, server error, timeout), never for a rejected request. If it still fails, the full payload and reason go into an error table and the caller gets a clear 502. A crash anywhere else is caught by the `error-handler` workflow.
**Tested:** 10 cases, see RESULTS.md.

## 2. ai-lead-qualify
![canvas](screenshots/ai-lead-qualify.png)
**Problem it solves:** inbound enquiries need a quick, consistent first read: what do they want, how urgent, how likely to buy, and does a human need to look.
**How it behaves:** Google Gemini returns a structured answer (intent, budget, urgency, score 0-100, summary, needs-human). If the AI is down or returns nonsense the lead is NOT dropped: it is saved with `needs_human = true`. The lead is saved to the CRM with the same retry rules as above, and a score of 70 or more writes a "hot lead" row (stand-in for a Slack or email alert).
**Tested:** input checks, the AI-down fallback (real), and the scoring and alert branches with the Gemini step replaced by a fixed answer. **The live Gemini call is untested: no Gemini key was available.**

## 3. support-bot-with-fallback and support-bot-eval
![canvas](screenshots/support-bot-with-fallback.png)
**Problem it solves:** a support bot that only answers from the company's own FAQ (a fictional "Acme Solar" FAQ, 12 answers in `faq.json`) and says "I can't answer that reliably" instead of guessing, passing the question to a human.
**How it behaves:** the AI must say whether the FAQ supports the answer, how confident it is (0 to 1) and which FAQ entries it used. Unsupported, under 0.6 confidence, unusable output, or a cited FAQ entry that does not exist all lead to a refusal plus a row in a handoff table.
**Eval:** `support-bot-eval` (manual run) sends 20 questions (14 answerable, 6 not, `tests/support-eval.json`) to the bot and records accuracy, correct-refusal rate and wrong-answer count in the `eval_runs` table. ![eval](screenshots/support-bot-eval.png)
**Tested:** refusal and handoff branches (AI-down for real, answer/refuse branches with a fixed AI answer) and a real eval run with the AI unavailable (accuracy 0.3 = refuse everything; it proves the harness, not answer quality). **Answer quality with real Gemini is unmeasured.**

## 4. error-handler
![canvas](screenshots/error-handler.png)
**Problem it solves:** automations fail quietly. Any workflow pointing at this one as its Error Workflow gets its crash written to a `workflow_errors` table (workflow, step, message, run id, time). `error-demo` crashes on purpose to prove it.

## Rebuilding
`node scripts/gen-workflows.mjs` (writes `workflows/`), `node scripts/setup.mjs` (creates tables, imports and activates), then `bash tests/run.sh`. The AI workflows need an n8n credential "Gemini free tier" (Google Gemini(PaLM) API) with a free Google AI Studio key.
