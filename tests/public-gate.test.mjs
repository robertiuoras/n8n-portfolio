// Red-then-green proof for scripts/public-gate.mjs: plants a fake key and a denylisted name in a throwaway repo
// and checks the gate fails, even when the plant is only in an OLD commit. Run: node --test tests/public-gate.test.mjs
// The terms below are made up; the real denylist never appears in this repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GATE = new URL('../scripts/public-gate.mjs', import.meta.url).pathname;
const TERMS = ['zorblax holdings', 'quentin vanderpluff', '0499111222', ...Array.from({ length: 10 }, (_, i) => `filler-term-${i}`)];
const DENY = Buffer.from(TERMS.join('\n')).toString('base64');

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  g('init', '-q');
  for (const commit of files) {
    for (const [f, body] of Object.entries(commit)) body === null ? fs.rmSync(path.join(dir, f)) : fs.writeFileSync(path.join(dir, f), body);
    g('add', '-A'); g('commit', '-qm', 'c');
  }
  return dir;
}
const run = (dir, env = { CLIENT_NAME_DENYLIST: DENY }) =>
  spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, ...env } });

test('clean repo passes', () => {
  const r = run(repo([{ 'a.md': 'Acme Solar demo, synthetic data only.\n' }]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /clean/);
});

test('fake GitHub token fails, and is not printed', () => {
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const r = run(repo([{ 'cfg.js': `const token = "${token}";\n` }]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gitleaks found a secret/);
  assert.ok(!r.stderr.includes(token));
});

test('client name in an old commit fails even after removal, term not printed', () => {
  const r = run(repo([{ 'a.md': 'Built for Zorblax Holdings.\n' }, { 'a.md': 'Built for a client.\n' }]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.md:1 matches denylisted term #1/);
  assert.ok(!/zorblax/i.test(r.stderr));
});

test('phone number in +61 form with spaces fails', () => {
  const r = run(repo([{ 'b.json': '{"phone": "+61 499 111 222"}\n' }]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /term #3/);
});

test('name in a commit message fails', () => {
  const dir = repo([{ 'a.md': 'ok\n' }]);
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'notes for quentin vanderpluff'], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /commit [0-9a-f]{8}:\d+ matches denylisted term #2/);
});

test('missing denylist fails closed', () => {
  const r = run(repo([{ 'a.md': 'ok\n' }]), {});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /denylist missing/);
});
