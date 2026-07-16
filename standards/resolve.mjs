#!/usr/bin/env node
// FreeDocStore standards resolver (reference implementation).
//
// Given a repo, it: (1) slices the repo into judgeable units, (2) gathers signals
// per slice, (3) evaluates the registry's detect predicates, and (4) composes the
// set of gold-standard KBs each slice should be judged against — plus repo-level
// recipes and a GAPS report of standards that matched but aren't authored yet.
//
// This is the deterministic ground-truth resolver: an AI judge calls this to learn
// *which* standards apply, then fetches those KB editions and judges against them —
// instead of guessing from memory.
//
//   node resolve.mjs <repo-path> [--json]
//
// Dependency-free. Node 18+.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(readFileSync(join(HERE, 'registry.json'), 'utf8'));

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.wrangler', 'test-results', '.cache', 'site']);

// ── file walk (relative paths within a dir, ignoring junk) ──
function walk(dir, base = dir, out = [], depth = 0) {
  if (depth > 6 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (IGNORE.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, base, out, depth + 1);
    else out.push(relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

// ── minimal glob -> regex (single-pass tokenizer: **/ , ** , * , {a,b}) ──
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
    else if (c === '*' && glob[i + 1] === '*') { re += '.*'; i += 1; }
    else if (c === '*') { re += '[^/]*'; }
    else if (c === '{') { const end = glob.indexOf('}', i); re += '(' + glob.slice(i + 1, end).split(',').join('|') + ')'; i = end; }
    else if ('.+^$()|[]\\'.includes(c)) { re += '\\' + c; }
    else { re += c; }
  }
  return new RegExp('^' + re + '$');
}
const anyGlob = (files, glob) => { const re = globToRe(glob); return files.some((f) => re.test(f)); };

const safeRead = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
function readPkg(dir) {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function depsOf(pkg) {
  if (!pkg) return new Set();
  return new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
}

// ── expand a pnpm/npm workspace into member dirs ──
function workspaceGlobs(repo) {
  const globs = [];
  const wsY = join(repo, 'pnpm-workspace.yaml');
  if (existsSync(wsY)) {
    let inPkgs = false;
    for (const line of readFileSync(wsY, 'utf8').split('\n')) {
      if (/^packages:/.test(line)) { inPkgs = true; continue; }
      if (inPkgs) {
        const m = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
        if (m) globs.push(m[1]); else if (/^\S/.test(line)) inPkgs = false;
      }
    }
  }
  const rootPkg = readPkg(repo);
  if (rootPkg?.workspaces) globs.push(...(Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces.packages || []));
  return globs;
}
function expandGlobDir(repo, glob) {
  if (!glob.includes('*')) return existsSync(join(repo, glob)) ? [glob] : [];
  const head = glob.split('/*')[0];
  const baseDir = join(repo, head);
  if (!existsSync(baseDir)) return [];
  return readdirSync(baseDir)
    .filter((n) => { if (IGNORE.has(n)) return false; try { return statSync(join(baseDir, n)).isDirectory(); } catch { return false; } })
    .map((n) => `${head}/${n}`);
}

// ── build the slices for a repo ──
function sliceRepo(repo) {
  const memberGlobs = workspaceGlobs(repo);
  let memberDirs = memberGlobs.flatMap((g) => expandGlobDir(repo, g));
  if (memberDirs.length === 0) memberDirs = ['.']; // non-monorepo: repo is one slice

  const slices = [];
  for (const rel of memberDirs) {
    const dir = join(repo, rel);
    if (!existsSync(dir)) continue;
    const pkg = readPkg(dir);
    const files = walk(dir);
    const hasFunctions = anyGlob(files, 'functions/**/*.{ts,js}');
    const label = rel === '.' ? (pkg?.name || 'repo') : rel;

    if (hasFunctions) {
      // split a fullstack package into a frontend sub-slice and a functions sub-slice
      const feFiles = files.filter((f) => !f.startsWith('functions/') && !f.startsWith('migrations/') && f !== 'wrangler.toml');
      slices.push({ label, dir, pkg, files: feFiles, kind: 'frontend' });
      const beFiles = files.filter((f) => f.startsWith('functions/') || f.startsWith('migrations/') || f === 'wrangler.toml' || f.endsWith('wrangler.jsonc'));
      slices.push({ label: `${label}/functions`, dir, pkg, files: beFiles, kind: 'functions' });
    } else {
      slices.push({ label, dir, pkg, files, kind: 'package' });
    }
  }
  return slices;
}

// ── gather the signal atoms a predicate can test ──
function signals(slice) {
  const deps = depsOf(slice.pkg);
  let files = slice.files;
  const cfg = new Set();
  if (slice.pkg?.bin) cfg.add('package.json:bin');
  if (slice.pkg?.exports || slice.pkg?.main || slice.pkg?.module) cfg.add('package.json:exportsOrMain');
  if (slice.pkg) { cfg.add('package.json'); files = [...new Set([...files, 'package.json'])]; }
  if (files.includes('wrangler.toml')) {
    const txt = safeRead(join(slice.dir, 'wrangler.toml'));
    if (/d1_databases/.test(txt)) cfg.add('wrangler.toml:d1_databases');
    if (/r2_buckets/.test(txt)) cfg.add('wrangler.toml:r2_buckets');
    if (/durable_objects/.test(txt)) cfg.add('wrangler.toml:durable_objects');
  }
  return { deps, files, cfg };
}

// ── predicate evaluator ──
function evalPred(pred, s, matched) {
  if (pred == null) return true;
  if (pred.always) return true;
  if (pred.all) return pred.all.every((p) => evalPred(p, s, matched));
  if (pred.any) return pred.any.some((p) => evalPred(p, s, matched));
  if (pred.not) return !evalPred(pred.not, s, matched);

  if (pred.dep) return s.deps.has(pred.dep);
  if (pred.anyDep) return pred.anyDep.some((d) => s.deps.has(d));
  if (pred.noneDep) return !pred.noneDep.some((d) => s.deps.has(d));

  if (pred.file) return s.files.includes(pred.file);
  if (pred.anyFile) return pred.anyFile.some((f) => s.files.includes(f));
  if (pred.fileGlob) return anyGlob(s.files, pred.fileGlob);
  if (pred.anyFileGlob) return pred.anyFileGlob.some((g) => anyGlob(s.files, g));
  if (pred.noneFileGlob) return !pred.noneFileGlob.some((g) => anyGlob(s.files, g));
  if (pred.noneFile) return !(Array.isArray(pred.noneFile) ? pred.noneFile : [pred.noneFile]).some((f) => s.files.includes(f));

  if (pred.config) return s.cfg.has(pred.config);
  if (pred.matched) return matched.has(pred.matched); // recipe: an archetype matched at repo level
  return false;
}

// ── resolve one repo ──
function resolve(repo) {
  const slices = sliceRepo(repo);
  const byType = (t) => registry.standards.filter((x) => x.type === t);
  const repoMatched = new Set();
  const results = [];

  for (const slice of slices) {
    const s = signals(slice);
    const archetypes = byType('archetype').filter((a) => evalPred(a.detect, s));
    const layers = byType('layer').filter((l) => evalPred(l.detect, s));
    const cross = byType('cross-cutting').filter((c) => evalPred(c.detect, s));
    archetypes.forEach((a) => repoMatched.add(a.id));
    results.push({ slice: slice.label, kind: slice.kind, archetypes, layers, cross });
  }

  const recipes = byType('recipe').filter((r) => evalPred(r.detect, null, repoMatched));
  return { repo, slices: results, recipes };
}

// ── format ──
const ed = (std) => { const e = (std.editions || []).find((x) => x.status === 'latest'); return e ? `@${e.version}` : ''; };
const tag = (std) => `${std.id}${ed(std)}` + (std.status === 'published' ? '' : ' [PLANNED]');

function report(res) {
  const lines = [];
  lines.push(`Repo: ${res.repo}`);
  lines.push(`Slices: ${res.slices.length}\n`);
  const gaps = new Map();
  const noteGap = (std, sliceLabel) => {
    if (std.status === 'published') return;
    const g = gaps.get(std.id) || { std, slices: new Set() };
    g.slices.add(sliceLabel); gaps.set(std.id, g);
  };
  for (const r of res.slices) {
    const arche = r.archetypes.length ? r.archetypes.map(tag).join(', ') : '(no archetype matched)';
    lines.push(`  # ${r.slice}  [${r.kind}]`);
    lines.push(`      archetype:     ${arche}`);
    if (r.layers.length) lines.push(`      layers:        ${r.layers.map(tag).join(', ')}`);
    lines.push(`      cross-cutting: ${r.cross.map(tag).join(', ')}`);
    [...r.archetypes, ...r.layers, ...r.cross].forEach((std) => noteGap(std, r.slice));
    lines.push('');
  }
  if (res.recipes.length) {
    lines.push(`  Repo recipes: ${res.recipes.map(tag).join(', ')}`);
    res.recipes.forEach((std) => noteGap(std, '(repo)'));
    lines.push('');
  }
  lines.push('GAPS — standards this repo needs that are not authored yet (ranked by demand):');
  const sorted = [...gaps.values()].sort((a, b) => b.slices.size - a.slices.size);
  if (!sorted.length) lines.push('  (none — every applicable standard is published)');
  for (const g of sorted) lines.push(`  - ${g.std.id}  (${g.std.type})  needed by ${g.slices.size} slice(s): ${[...g.slices].join(', ')}`);
  return lines.join('\n');
}

// ── main ──
const repoArg = process.argv[2];
if (!repoArg) { console.error('usage: node resolve.mjs <repo-path> [--json]'); process.exit(1); }
const res = resolve(repoArg.replace(/^~/, process.env.HOME));
if (process.argv.includes('--json')) console.log(JSON.stringify(res, (k, v) => (v instanceof Set ? [...v] : v), 2));
else console.log(report(res));
