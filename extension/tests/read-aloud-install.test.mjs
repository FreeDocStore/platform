import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { injectReadAloud, installReadAloud, SCRIPT_SRC } from '../../templates/read-aloud/install.mjs';

test('installs once into Material/Zensical and static article pages', () => {
  for (const body of ['<main><article>Text</article></main>', '<article>Text</article>']) {
    const html = `<html><body>${body}</BODY></html>`;
    const result = injectReadAloud(html);
    assert.ok(result.includes(`defer src="${SCRIPT_SRC}"`));
    assert.equal(injectReadAloud(result), result);
    assert.ok(result.includes(body));
  }
  assert.equal(injectReadAloud('<body>no article</body>'), '<body>no article</body>');
});

test('only publishes verified narration for the exact current source blob', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fds-audio-'));
  try {
    const site = path.join(root, 'site');
    const docs = path.join(root, 'docs');
    mkdirSync(path.join(site, 'guide'), { recursive: true });
    mkdirSync(path.join(site, 'audio'), { recursive: true });
    mkdirSync(path.join(docs, 'audio'), { recursive: true });
    const source = '# Unicode guide\n\nHello 世界.\n';
    const sha = createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
    const audio = Buffer.from('recording fixture');
    const digest = createHash('sha256').update(audio).digest('hex');
    const file = `fds-audio-${digest.slice(0, 20)}.wav`;
    writeFileSync(path.join(docs, 'guide.md'), source);
    writeFileSync(path.join(docs, 'audio', file), audio);
    writeFileSync(path.join(docs, 'guide.md.audio.json'), JSON.stringify({ version: 1, sourcePath: 'docs/guide.md', sourceSha: sha, audioFile: `/audio/${file}`, audioSha256: digest }));
    const html = '<html><head></head><body><main><h1>Guide</h1></main></body></html>';
    const output = path.join(site, 'guide/index.html');
    writeFileSync(output, html);
    assert.equal(installReadAloud(site, { sourceDir: docs }), 1);
    const published = readFileSync(output, 'utf8');
    assert.ok(published.includes(`name="source-sha" content="${sha}"`));
    assert.ok(published.includes(`name="audio-file" content="/audio/${file}"`));
    assert.equal(installReadAloud(site, { sourceDir: docs }), 0);
    const warnings = [];
    writeFileSync(path.join(docs, 'guide.md'), `${source}An update.\n`);
    installReadAloud(site, { sourceDir: docs, report: message => warnings.push(message) });
    assert.ok(!readFileSync(output, 'utf8').includes('name="audio-file"'));
    assert.match(warnings[0], /source changed/);
    writeFileSync(path.join(docs, 'guide.md'), source);
    writeFileSync(path.join(docs, 'audio', file), 'corrupt');
    installReadAloud(site, { sourceDir: docs, report: message => warnings.push(message) });
    assert.ok(!readFileSync(output, 'utf8').includes('name="audio-file"'));
    assert.match(warnings.at(-1), /integrity/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refuses symlinked assets rather than overwriting outside the site', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fds-link-'));
  try {
    mkdirSync(path.join(root, 'site'));
    mkdirSync(path.join(root, 'outside'));
    symlinkSync(path.join(root, 'outside'), path.join(root, 'site/assets'));
    assert.throws(() => installReadAloud(path.join(root, 'site')), /symbolic link/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installs nested pages and asset without modifying errors or following symlinks', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fds-reader-'));
  try {
    const site = path.join(root, 'site');
    mkdirSync(path.join(site, 'guide'), { recursive: true });
    const html = '<body><main><h1>Guide</h1><p>Read me.</p></main></body>';
    writeFileSync(path.join(site, 'guide/index.html'), html);
    writeFileSync(path.join(site, '404.html'), html);
    writeFileSync(path.join(root, 'outside.html'), html);
    symlinkSync(path.join(root, 'outside.html'), path.join(site, 'outside.html'));
    assert.equal(installReadAloud(site), 1);
    assert.equal(installReadAloud(site), 0);
    assert.equal(readFileSync(path.join(site, '404.html'), 'utf8'), html);
    assert.equal(readFileSync(path.join(root, 'outside.html'), 'utf8'), html);
    const asset = readFileSync(path.join(site, SCRIPT_SRC.slice(1)), 'utf8');
    assert.ok(asset.includes('freedocstore-read-aloud'));
    assert.ok(!/\bfetch\s*\(/.test(asset));
    assert.ok(asset.includes('localService'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
