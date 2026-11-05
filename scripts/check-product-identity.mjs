import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Character codes keep the detector itself free of the disallowed literal.
const words = [[103, 108, 97, 115, 115], [100, 111, 99, 115]].map(codes => String.fromCharCode(...codes));
const pattern = () => new RegExp(words.join('[\\s_-]*'), 'gi');
const redact = value => value.replace(pattern(), '[disallowed product name]');

export function auditProductIdentity(cwd = process.cwd(), { staged = false, messageFile } = {}) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const files = git(staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z']).split('\0').filter(Boolean);
  const failures = [];
  for (const file of files) {
    if (pattern().test(file)) failures.push(`Disallowed product name in path: ${redact(file)}`);
    const filename = resolve(cwd, file);
    let content;
    try { content = staged ? git(['show', `:${file}`]) : lstatSync(filename).isSymbolicLink() ? readlinkSync(filename) : readFileSync(filename, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (content !== null && pattern().test(content)) failures.push(`Disallowed product name in contents: ${redact(file)}`);
  }
  if (messageFile && pattern().test(readFileSync(resolve(cwd, messageFile), 'utf8'))) failures.push('Disallowed product name in proposed commit message.');
  const commits = git(['log', '--all', '--format=%H%x00%B%x00']).split('\0');
  for (let i = 0; i + 1 < commits.length; i += 2) {
    if (pattern().test(commits[i + 1])) failures.push(`Disallowed product name in commit message: ${commits[i].trim().slice(0, 12)}`);
  }
  return { failures, files: files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const messageIndex = process.argv.indexOf('--message-file');
  if (messageIndex >= 0 && !process.argv[messageIndex + 1]) throw new Error('--message-file requires a path');
  const result = auditProductIdentity(process.cwd(), { staged: process.argv.includes('--staged'), messageFile: messageIndex >= 0 ? process.argv[messageIndex + 1] : undefined });
  if (result.failures.length) {
    for (const failure of result.failures) console.error(failure);
    process.exitCode = 1;
  } else console.log(`Product identity check passed (${result.files} tracked files and all commit messages).`);
}
