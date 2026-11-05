import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditProductIdentity } from './check-product-identity.mjs';

const forbidden = String.fromCharCode(103, 108, 97, 115, 115, 100, 111, 99, 115);
function repository(fn) {
  const cwd = mkdtempSync(join(tmpdir(), 'fds-identity-'));
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  try {
    git(['init', '-q']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.test']); git(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(cwd, 'README.md'), 'FreeDocStore and ProDocStore');
    git(['add', '.']); git(['commit', '-qm', 'Initialize product']);
    fn({ cwd, git });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
test('accepts product-owned content and messages', () => repository(({ cwd }) => {
  assert.deepEqual(auditProductIdentity(cwd).failures, []);
}));
test('rejects mixed-case names in tracked content without echoing the match', () => repository(({ cwd }) => {
  writeFileSync(join(cwd, 'README.md'), forbidden.toUpperCase());
  const result = auditProductIdentity(cwd);
  assert.equal(result.failures.length, 1);
  assert.ok(!JSON.stringify(result).toLowerCase().includes(forbidden));
}));
test('rejects disallowed file names', () => repository(({ cwd, git }) => {
  writeFileSync(join(cwd, `${forbidden}.txt`), 'content'); git(['add', '.']);
  const failures = auditProductIdentity(cwd).failures;
  assert.match(failures[0], /in path/);
  assert.ok(!failures[0].includes(forbidden));
}));
test('rejects disallowed commit messages even if the current files are clean', () => repository(({ cwd, git }) => {
  git(['commit', '--allow-empty', '-qm', `Mention ${forbidden}`]);
  assert.match(auditProductIdentity(cwd).failures[0], /commit message/);
}));

test('staged checks inspect the index even when the working copy has been cleaned', () => repository(({ cwd, git }) => {
  writeFileSync(join(cwd, 'README.md'), forbidden); git(['add', 'README.md']);
  writeFileSync(join(cwd, 'README.md'), 'FreeDocStore');
  assert.deepEqual(auditProductIdentity(cwd).failures, []);
  assert.match(auditProductIdentity(cwd, { staged: true }).failures[0], /contents/);
}));

test('checks a proposed commit message before any commit is created', () => repository(({ cwd }) => {
  writeFileSync(join(cwd, 'candidate-message.txt'), `Mention ${forbidden}`);
  const failures = auditProductIdentity(cwd, { messageFile: 'candidate-message.txt' }).failures;
  assert.deepEqual(failures, ['Disallowed product name in proposed commit message.']);
}));
