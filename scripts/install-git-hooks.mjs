import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const root = git(['rev-parse', '--show-toplevel']);
let existing = '';
try { existing = git(['config', '--get', 'core.hooksPath']); } catch (error) { if (error.status !== 1) throw error; }
if (existing && existing !== '.githooks') throw new Error('A custom hooks path is already configured. Integrate the product identity checks there before replacing it.');
for (const hook of ['pre-commit', 'commit-msg']) if (!existsSync(resolve(root, '.githooks', hook))) throw new Error(`Missing managed hook: ${hook}`);
git(['config', '--local', 'core.hooksPath', '.githooks']);
console.log('Repository product identity hooks installed.');
