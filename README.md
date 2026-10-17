# n8n automation portfolio (Robert Iuoras)

Five small automations built in n8n 2.42.5, each tested end to end. **These are my own demo builds using synthetic data. None of them is client work.** Everything runs on one laptop; the "CRM" is a stand-in (see below), so no third-party accounts are needed.

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
**How it behaves:** Google Gemini (free tier, `gemini-3.5-flash-lite`) returns a structured answer (intent, budget, urgency, score 0-100, summary, needs-human). The AI step retries twice, 5 seconds apart, on a rate limit or error. If the AI is still down or returns nonsense the lead is NOT dropped: it is saved with `needs_human = true`. The lead is saved to the CRM with the same retry rules as above, and a score of 70 or more writes a "hot lead" row (stand-in for a Slack or email alert).
**Tested:** input checks, a real Gemini call (the lead is scored, saved to the CRM and, at 70 or more, flagged as hot), the AI-outage fallback, unusable AI output, and the scoring and alert branches with the Gemini step replaced by a fixed answer.

## 3. support-bot-with-fallback and support-bot-eval
![canvas](screenshots/support-bot-with-fallback.png)
**Problem it solves:** a support bot that only answers from the company's own FAQ (a fictional "Acme Solar" FAQ, 12 answers in `faq.json`) and says "I can't answer that reliably" instead of guessing, passing the question to a human.
**How it behaves:** the AI must say whether the FAQ supports the answer, how confident it is (0 to 1) and which FAQ entries it used. Unsupported, under 0.6 confidence, unusable output, or a cited FAQ entry that does not exist all lead to a refusal plus a row in a handoff table.
**Eval:** `support-bot-eval` (manual run) sends 20 questions (14 answerable, 6 not, `tests/support-eval.json`) to the bot and records accuracy, correct-refusal rate and wrong-answer count in the `eval_runs` table. ![eval](screenshots/support-bot-eval.png)
**Tested:** a real Gemini answer to an in-FAQ question (cites the right entry, no handoff), a real Gemini refusal of an off-FAQ question (handoff row written), the AI-outage path, and every refuse branch with the Gemini step replaced by a fixed answer. **Real eval, 2026-10-09, `gemini-3.5-flash-lite`, one run of the 20 questions:** 14 of 14 answerable questions answered citing the expected FAQ entry, 6 of 6 off-topic questions refused and handed off, 0 wrong answers, 0 questions lost to the AI being unavailable (accuracy 1.0, correct-refusal rate 1.0). That is one run on a small, easy question set, not a general accuracy figure; the per-question table is in RESULTS.md.

## 4. error-handler
![canvas](screenshots/error-handler.png)
**Problem it solves:** automations fail quietly. Any workflow pointing at this one as its Error Workflow gets its crash written to a `workflow_errors` table (workflow, step, message, run id, time). `error-demo` crashes on purpose to prove it.

## 5. rag-docs: answers from real documents (rag-ingest, rag-ask, rag-eval)
![canvas](screenshots/rag-ask.png)
**Problem it solves:** a FAQ only goes so far. Real answers live in long documents (warranty terms, an installation guide, a privacy policy, a price sheet: four synthetic "Acme Solar" documents in `docs/`). The bot has to find the right passage, answer from it, show where the answer came from, and still say "I can't answer that reliably" when the documents do not cover the question.
**How it behaves:** `rag-ingest` (POST a document as markdown) splits it at its headings, turns each piece into an embedding with Google's `gemini-embedding-2` (free tier) and stores text and vector in an n8n Data Table, so the index survives restarts. Re-sending a document replaces its old pieces, but only after every new piece was embedded: if the embeddings API fails, the stored copy is left as it was. ![ingest](screenshots/rag-ingest.png)
`rag-ask` embeds the question, ranks every stored piece by similarity, and gives the best 4 to Gemini, which must answer only from them and name the pieces it used. The answer is refused and handed to a person (a row in `rag_handoff_log`) when the AI says the extracts do not cover it, is under 0.6 confident, cites a piece that was not among the ones retrieved for this question, returns unusable output, or the AI or embeddings service is down. Answers come back with their citations (document and section).
**Eval:** `rag-eval` (manual run) sends 20 questions (`tests/rag-eval.json`): 14 answerable across all four documents, 4 near-misses (on-topic but not in the documents, such as the price of an EV charger) and 2 off-topic. It records retrieval hit rate (was the right document in the top 4), answer accuracy (an answer counts only if it cites the expected document and contains the expected fact), correct refusals and wrong answers in `rag_eval_scores`. ![eval](screenshots/rag-eval.png)
**Tested:** input checks, a re-ingest of all four documents (33 pieces) that replaces each old copy instead of doubling it, an embeddings outage during ingest (502, stored copy untouched), a real Gemini answer that quotes the price and cites its piece, a real refusal of an off-topic question (handoff row written), the embeddings-outage and AI-outage paths, and every refuse branch with the Gemini step replaced by a fixed answer. **Real eval, 2026-10-17, `gemini-embedding-2` + `gemini-3.5-flash-lite`, one run of the 20 questions:** the right document was in the top 4 for 14 of 14 answerable questions (retrieval hit rate 1.0), 14 of 14 answered citing the expected document with the expected fact (answer accuracy 1.0), 6 of 6 near-miss and off-topic questions refused and handed off, 0 wrong answers, 0 questions lost to the AI being unavailable. Best-match similarity was 0.70 to 0.85 for answerable questions and 0.54 to 0.57 for off-topic ones; near-misses scored 0.71 to 0.77, so they are caught by the AI saying the extracts do not cover them, not by the 0.6 floor. That is one run on a small synthetic question set, not a general accuracy figure; the per-question table is in RESULTS.md. All 42 end-to-end cases passed in that run.

## Publishing safety
Every push is scanned for secrets (gitleaks) and for a private list of client identifiers, across the whole history, by `scripts/public-gate.mjs` (pre-push hook and GitHub Actions). The scan done before publishing is in [tests/PUBLIC-SCAN.md](tests/PUBLIC-SCAN.md).

## Rebuilding
`node scripts/gen-workflows.mjs` (writes `workflows/`), `node scripts/setup.mjs` (creates tables, imports and activates), then `bash tests/run.sh`. The AI workflows use an n8n credential "Gemini free tier" (Google Gemini(PaLM) API); `setup.mjs` creates or updates it from the `GEMINI_API_KEY` environment variable (a free-tier key from a Google Cloud project with billing off, so it cannot be charged). Each full test run spends about 45 Gemini answer requests and 60 embedding requests; the free tier allows 500 answers a day and 15 a minute for `gemini-3.5-flash-lite`, and 1,000 embeddings a day and 100 a minute for `gemini-embedding-2`, which is why both evals send one question every 8 seconds. To load the documents: POST each file in `docs/` to `/webhook/rag/ingest` as `{doc_id, title, text}` (the test script does this).
