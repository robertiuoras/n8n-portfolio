# Pre-publication scan, 17 Oct 2026

Run before the repo was made public. No secret values or client names are written here.

- **Scope:** every commit on every branch (14 commits, 102 git objects), every commit message and author line, plus all 20 versions of the 7 screenshots in history (checked by eye: n8n canvas only, no account, client or workflow-list data).
- **gitleaks 8.30.1** over full history: 1 finding, a false positive (`generic-api-key` on the mock CRM's test marker string `injected_500x2`, `workflows/mock-crm.json`). Allowlisted by fingerprint in `.gitleaksignore`. No real keys found, so nothing needed rotating and history was not rewritten.
- **Client denylist** (134 private terms: client names, businesses, emails, domains, phone numbers in local and +61 form): 0 hits.
- `.env` and `data/` were never committed (checked with `git log --all --name-only`).
- The local n8n owner password and API key are read at run time from a private secrets store, never written into the repo.

## Kept true by
`scripts/public-gate.mjs` runs on every push, locally (`.githooks/pre-push`, enabled with `git config core.hooksPath .githooks`) and in GitHub Actions (`.github/workflows/public-gate.yml`). It fails on any gitleaks finding, any denylist hit, or a missing denylist. `tests/public-gate.test.mjs` proves it catches a planted token, a name only in an old commit, a name in a commit message, and a spaced +61 phone number.
