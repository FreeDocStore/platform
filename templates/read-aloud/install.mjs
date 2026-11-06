#!/usr/bin/env node
// Install the vendored, self-contained reader into built Zensical/static HTML.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT_SRC = '/assets/freedocstore-read-aloud.js';

export function injectReadAloud(html) {
  if (!/<(?:main|article)\b/i.test(html) || !/<\/body\s*>/i.test(html)) return html;
  if (/<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/freedocstore-read-aloud\.js(?:[?#][^"']*)?["']/i.test(html)) return html;
  return html.replace(/<\/body\s*>/i, `<script defer src="${SCRIPT_SRC}"></script>\n$&`);
}

function safeFile(root, relative) {
  if (relative.startsWith('/') || relative.split(/[\\/]/).some(p => p === '..' || !p)) return null;
  let current = path.resolve(root);
  if (!existsSync(current) || lstatSync(current).isSymbolicLink()) return null;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (!existsSync(current) || lstatSync(current).isSymbolicLink()) return null;
  }
  return lstatSync(current).isFile() ? current : null;
}

function pageMetadata(html, relative, sourceDir, report, siteDir, repo) {
  const rel = relative.replace(/\\/g, '/').replace(/\.html?$/i, '');
  const candidates = rel === 'index' ? ['index.md'] : rel.endsWith('/index') ? [`${rel.slice(0, -6)}.md`, `${rel}.md`] : [`${rel}.md`, `${rel}/index.md`];
  const source = candidates.map(candidate => ({ candidate, filename: safeFile(sourceDir, candidate) })).find(x => x.filename);
  if (!source) return html;
  const bytes = readFileSync(source.filename);
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const metas = { 'source-sha': sha };
  if (repo) { metas['source-repo'] = repo; metas['source-path'] = `docs/${source.candidate}`; }
  const manifestPath = safeFile(sourceDir, `${source.candidate}.audio.json`);
  if (manifestPath) {
    try {
      if (lstatSync(manifestPath).size > 8192) throw new Error('manifest too large');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.version !== 1 || manifest.sourcePath !== `docs/${source.candidate}` || !/^[0-9a-f]{40}$/.test(manifest.sourceSha) || !/^[0-9a-f]{64}$/.test(manifest.audioSha256) || !/^\/audio\/fds-audio-[0-9a-f]{20}\.(?:wav|opus)$/.test(manifest.audioFile) || (manifest.audioFile.endsWith('.opus') && (manifest.container !== 'opus' || !Number.isFinite(manifest.durationSeconds) || manifest.durationSeconds <= 0))) throw new Error('invalid metadata');
      if (manifest.sourceSha !== sha) throw new Error('source changed; regenerate narration');
      const file = safeFile(sourceDir, manifest.audioFile.slice(1));
      if (!file || lstatSync(file).size > (manifest.audioFile.endsWith('.opus') ? 1_572_864 : 12 * 1024 * 1024)) throw new Error('audio missing or too large');
      const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
      if (digest !== manifest.audioSha256 || manifest.audioFile !== `/audio/fds-audio-${digest.slice(0, 20)}.${manifest.audioFile.endsWith('.opus') ? 'opus' : 'wav'}`) throw new Error('audio integrity check failed');
      const outputDir = path.join(siteDir, 'audio');
      if (existsSync(outputDir) && lstatSync(outputDir).isSymbolicLink()) throw new Error('audio output directory is a symbolic link');
      mkdirSync(outputDir, { recursive: true });
      const output = path.join(siteDir, manifest.audioFile.slice(1));
      if (existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error('audio output is a symbolic link');
      if (path.resolve(file) !== path.resolve(output)) copyFileSync(file, output);
      metas['audio-file'] = manifest.audioFile;
      metas['audio-sha'] = sha;
    } catch (error) { report(`Skipped narration for ${relative}: ${error.message}`); }
  }
  if (repo) html = html.replace(/<meta\b[^>]*\bname\s*=\s*["'](?:source-repo|source-path)["'][^>]*>\s*/gi, '');
  const clean = html.replace(/<meta\b[^>]*\bname\s*=\s*["'](?:source-sha|audio-file|audio-sha|audio-sections)["'][^>]*>\s*/gi, '');
  const tags = Object.entries(metas).map(([name, content]) => `<meta name="${name}" content="${String(content).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}">`).join('\n');
  return clean.replace(/<\/head\s*>/i, `${tags}\n$&`);
}

export function installReadAloud(siteDir, { sourceDir = 'docs', report = console.warn, repo = process.env.GITHUB_REPOSITORY } = {}) {
  const root = path.resolve(siteDir);
  if (lstatSync(root).isSymbolicLink()) throw new Error('Site directory must not be a symbolic link');
  const assets = path.join(root, 'assets');
  if (existsSync(assets) && lstatSync(assets).isSymbolicLink()) throw new Error('Assets directory must not be a symbolic link');
  const bundle = path.join(root, SCRIPT_SRC.slice(1));
  if (existsSync(bundle) && lstatSync(bundle).isSymbolicLink()) throw new Error('Reader asset must not be a symbolic link');
  let changed = 0;
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile() && /\.html?$/i.test(entry.name) && entry.name !== '404.html') {
        const before = readFileSync(filename, 'utf8');
        const after = injectReadAloud(pageMetadata(before, path.relative(root, filename), sourceDir, report, root, repo));
        if (after !== before) { writeFileSync(filename, after); changed++; }
      }
    }
  }
  walk(root);
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  copyFileSync(path.join(here, 'read-aloud.js'), path.join(root, SCRIPT_SRC.slice(1)));
  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const site = process.argv[2];
  if (!site) throw new Error('Usage: node install.mjs <built-site-directory>');
  console.log(`Read aloud installed: ${installReadAloud(site)} pages updated`);
}
