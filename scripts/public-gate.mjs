// Fails (exit 1) if anything in this repo's history could leak a secret or a client's identity.
// Two checks over EVERY commit on every branch, not just the latest files:
//   1. gitleaks (secret shapes: API keys, tokens, private keys, passwords).
//   2. a private denylist of client names, businesses, emails and phone numbers.
// The denylist is never stored in this repo: it comes from the CLIENT_NAME_DENYLIST env var (base64 of one term
// per line; a GitHub Actions secret in CI) or, locally, from the secrets store. No denylist = fail, never a pass.
// Hits are reported by file and line with the term's NUMBER, never the term, because CI logs are public.
// Usage: node scripts/public-gate.mjs   (run inside the repo; the pre-push hook and CI run the same thing)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 });
const fail = (msg) => { console.error(`public-gate: ${msg}`); process.exit(1); };

function loadDenylist() {
  let b64 = process.env.CLIENT_NAME_DENYLIST;
  const store = process.env.HOME + '/Projects/claude-memory/claude-config/secrets.mjs';
  if (!b64 && fs.existsSync(store)) {
    try { b64 = execFileSync('node', [store, 'get', 'CLIENT_NAME_DENYLIST'], { encoding: 'utf8' }).trim(); } catch {}
  }
  const terms = Buffer.from(b64 || '', 'base64').toString('utf8').split('\n').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (terms.length < 10) fail('client-name denylist missing or too short (set CLIENT_NAME_DENYLIST). Refusing to pass.');
  return terms;
}

// Phone numbers are matched with spaces, dashes, dots and brackets removed, in local (04..) and +61 form.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matchers(terms) {
  return terms.map((t, i) => {
    const forms = /^0\d{8,9}$/.test(t) ? [t, '61' + t.slice(1), '64' + t.slice(1)] : [t];
    return { n: i + 1, digits: /^\d+$/.test(t), re: new RegExp(`(?<![a-z0-9])(${forms.map(esc).join('|')})(?![a-z0-9])`, 'i') };
  });
}

function scanText(label, text, ms, hits) {
  text.split('\n').forEach((line, i) => {
    const squashed = line.replace(/[\s().-]/g, '');
    for (const m of ms) if (m.re.test(m.digits ? squashed : line)) hits.push(`${label}:${i + 1} matches denylisted term #${m.n}`);
  });
}

const terms = loadDenylist();
const ms = matchers(terms);
const hits = [];

// Every blob reachable from any ref, with the path it was first seen at.
const seen = new Set();
for (const row of git('rev-list', '--objects', '--all').split('\n')) {
  const [sha, ...p] = row.split(' ');
  const path = p.join(' ');
  if (!path || seen.has(sha)) continue;
  seen.add(sha);
  if (git('cat-file', '-t', sha).trim() !== 'blob') continue;
  const buf = execFileSync('git', ['cat-file', 'blob', sha], { maxBuffer: 1 << 28 });
  if (buf.includes(0)) continue; // binary (screenshots): checked by eye before publishing
  scanText(path, buf.toString('utf8'), ms, hits);
}
// Commit messages and author/committer names are public too.
for (const c of git('log', '--all', '--format=%H%x00%an %ae %cn %ce%n%B%x01').split('\x01')) {
  const [sha, body] = c.trim().split('\x00');
  if (sha) scanText(`commit ${sha.slice(0, 8)}`, body || '', ms, hits);
}

const gl = spawnSync('gitleaks', ['git', '--log-opts=--all', '--redact', '--no-banner', '--exit-code', '3', '.'], { encoding: 'utf8' });
if (gl.error) fail('gitleaks is not installed (brew install gitleaks). Refusing to pass.');
if (gl.status === 3) hits.push('gitleaks found a secret:\n' + (gl.stdout + gl.stderr).trim());
else if (gl.status !== 0) fail('gitleaks errored:\n' + (gl.stdout + gl.stderr).trim());

if (hits.length) fail(`${hits.length} problem(s):\n  ` + hits.join('\n  '));
console.log(`public-gate: clean (${seen.size} objects, ${terms.length} denylisted terms, gitleaks ok)`);
