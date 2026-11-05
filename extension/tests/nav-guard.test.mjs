import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './_bundle.mjs';
const { collectNavHrefs, droppedNavHrefs, mkdocsNavHrefs } = await import(await bundle('src/lib/nav-guard.ts'));
const { buildNavProposalPreview } = await import(await bundle('src/adapters/proposal-nav.ts'));

test('detects omitted nested links and accepts only declared removals', () => {
  const items = [{ label: 'Home', href: 'index.md' }, { label: 'Guides', children: [{ label: 'Deploy', href: 'deploy.md' }, { label: 'Setup', href: 'setup.md' }] }];
  assert.deepEqual(collectNavHrefs(items), ['index.md', 'deploy.md', 'setup.md']);
  assert.deepEqual(droppedNavHrefs(collectNavHrefs(items), ['/docs/index.md', 'docs/deploy.md']), ['setup.md']);
  assert.deepEqual(droppedNavHrefs(collectNavHrefs(items), ['index.md', 'deploy.md'], ['docs/setup.md']), []);
  assert.deepEqual(droppedNavHrefs(['page.html'], ['page.md']), ['page.html']);
});

test('reads block, flow, bare-link and deeply nested MkDocs navigation', () => {
  assert.deepEqual(mkdocsNavHrefs(`site_name: Example\nnav:\n  - Home: index.md\n  - Guide:\n    - Nested:\n      - 'Deploy: safely': 'deploy.md'\n  - https://example.test/\nplugins:\n  - search\n`), ['index.md', 'deploy.md', 'https://example.test/']);
  assert.deepEqual(mkdocsNavHrefs(`nav: [{Home: index.md}, {Guide: [setup.md]}]\nextra: !custom irrelevant`), ['index.md', 'setup.md']);
});

test('refuses automatic, malformed, tagged and unresolved navigation', () => {
  for (const yaml of ['site_name: Example', 'nav: null', 'nav: {Home: index.md}', 'nav: [*outside]', 'nav: !custom [index.md]', 'nav:\n - Home: [broken']) {
    assert.throws(() => mkdocsNavHrefs(yaml));
  }
});

function storage() {
  const values = new Map();
  const area = { get: async key => key == null ? Object.fromEntries(values) : { [key]: values.get(key) }, set: async entries => { for (const [key, value] of Object.entries(entries)) values.set(key, value); }, remove: async key => values.delete(key) };
  globalThis.chrome = { storage: { session: area, local: area } };
  return values;
}
const proposal = items => ({ items, summary: 'Update the navigation' });
const menu = [{ label: 'Home', href: 'index.md' }, { label: 'Operations', href: 'operations.md' }];
function repo(files) { return { getFileOrNull: async (_owner, _repo, path) => files[path] ? { content: files[path], sha: 'source-sha' } : null }; }

test('JSON omission is rejected without storing a preview; navSkip alone cannot authorize deletion', async () => {
  const values = storage();
  const gh = repo({ 'docs/nav.json': JSON.stringify({ items: menu, navSkip: ['404.html'] }) });
  const result = await buildNavProposalPreview(gh, 'owner', 'repo', { ...proposal([menu[0]]), navSkip: ['operations.md'] }, 'pr');
  assert.equal(result.attachment, undefined);
  assert.match(result.content, /operations\.md/);
  assert.equal(values.size, 0);
});

test('explicit JSON removal is reviewed and existing navSkip survives omission', async () => {
  storage();
  const gh = repo({ 'docs/nav.json': JSON.stringify({ items: menu, navSkip: ['404.html'] }) });
  const result = await buildNavProposalPreview(gh, 'owner', 'repo', { ...proposal([menu[0]]), remove: ['docs/operations.md'] }, 'pr');
  assert.equal(result.attachment.kind, 'preview');
  const config = JSON.parse(result.attachment.data.newContent);
  assert.deepEqual(config.items, [menu[0]]);
  assert.deepEqual(config.navSkip, ['404.html']);
});

test('MkDocs omission is rejected and an explicit removal preserves unrelated configuration', async () => {
  const values = storage();
  const gh = repo({ 'mkdocs.yml': 'site_name: Example\nnav:\n  - Home: index.md\n  - Operations: operations.md\nplugins:\n  - search\n' });
  const denied = await buildNavProposalPreview(gh, 'owner', 'repo', proposal([menu[0]]), 'pr');
  assert.equal(denied.attachment, undefined); assert.equal(values.size, 0);
  const accepted = await buildNavProposalPreview(gh, 'owner', 'repo', { ...proposal([menu[0]]), remove: ['operations.md'] }, 'pr');
  assert.match(accepted.attachment.data.newContent, /plugins:\n  - search/);
  assert.doesNotMatch(accepted.attachment.data.newContent, /Operations:/);
});

test('unknown current menus and invalid removal lists cannot produce a proposal', async () => {
  for (const [files, request] of [
    [{ 'docs/nav.json': '{broken' }, proposal(menu)],
    [{ 'mkdocs.yml': 'site_name: Automatic' }, proposal(menu)],
    [{ 'docs/nav.json': JSON.stringify({ items: menu }) }, { ...proposal(menu), remove: 'operations.md' }],
  ]) {
    const values = storage();
    const result = await buildNavProposalPreview(repo(files), 'owner', 'repo', request, 'pr');
    assert.equal(result.attachment, undefined); assert.equal(values.size, 0);
  }
});
