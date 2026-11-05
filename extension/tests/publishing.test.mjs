import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudflareClient, ensureProject, ensureDomains } from '../../templates/publishing/cloudflare.mjs';

for (const [status, success] of [[200, false], [403, false], [500, true]]) {
  test(`Cloudflare HTTP ${status} with success=${success} fails visibly`, async () => {
    const api = cloudflareClient({ token: 'test-token', fetch: async () => new Response(JSON.stringify({ success, result: {} }), { status }) });
    await assert.rejects(api('/test'), /failed/);
  });
}

test('existing project is checked without suppressing access errors or changing its branch', async () => {
  await ensureProject(async () => ({ production_branch: 'main' }), 'account', 'example');
  await assert.rejects(ensureProject(async () => ({ production_branch: 'other' }), 'account', 'example'), /production branch/);
  await assert.rejects(ensureProject(async () => { throw Error('forbidden'); }, 'account', 'example'), /forbidden/);
  const calls = [];
  await ensureProject(async (route, opts) => { calls.push({ route, opts }); return null; }, 'account', 'example');
  assert.equal(calls[1].opts.method, 'POST');
  assert.equal(calls[1].opts.body.production_branch, 'main');
});

test('apex custom domains use their own zone and existing DNS conflicts block publication', async () => {
  const writes = [];
  const api = async (route, options) => {
    if (options?.method === 'POST') { writes.push({ route, body: options.body }); return {}; }
    if (route.endsWith('/domains')) return [{ name: 'example.com' }];
    if (route === '/zones?name=example.com') return [{ id: 'apex-zone' }];
    if (route.includes('/dns_records?')) return [];
    throw Error(route);
  };
  await ensureDomains(api, 'account', 'project', ['example.com'], () => {});
  assert.equal(writes[0].route, '/zones/apex-zone/dns_records');
  assert.equal(writes[0].body.content, 'project.pages.dev');
  await assert.rejects(ensureDomains(async (route, opts) => route.includes('/dns_records?') ? [{ type: 'A', content: '192.0.2.1' }] : api(route, opts), 'account', 'project', ['example.com']), /points elsewhere/);
});

test('external DNS produces actionable status rather than a false success claim', async () => {
  const messages = [];
  await ensureDomains(async () => [], 'account', 'project', ['docs.example.com'], message => messages.push(message));
  assert.match(messages[0], /Configure external DNS/);
});

test('generated deployment uses shared checked helpers before deploying and attaching domains', async () => {
  const { bundle } = await import('./_bundle.mjs');
  const { parse } = await import('yaml');
  const { deployWorkflow } = await import(await bundle('../apps/editor/web/src/model/kb.ts'));
  const workflow = parse(deployWorkflow('example', 'docs.example.com'));
  const steps = workflow.jobs.deploy.steps;
  const project = steps.findIndex(step => step.name === 'Ensure Cloudflare Pages project');
  const deploy = steps.findIndex(step => step.name === 'Deploy to Cloudflare Pages');
  const domains = steps.findIndex(step => step.name === 'Attach domains');
  assert.ok(project < deploy && deploy < domains);
  assert.equal(steps[project].env.PROJECT, 'example');
  assert.match(steps[project].run, /cloudflare.mjs project$/);
  assert.match(steps[domains].run, /cloudflare.mjs domains$/);
  assert.doesNotMatch(deployWorkflow('example', ''), /\|\| true/);
});

test('customer workflows use the actual branch and native Pages hosting without shell interpolation', async () => {
  const { bundle } = await import('./_bundle.mjs');
  const { parse } = await import('yaml');
  const { deployWorkflow } = await import(await bundle('../templates/publishing/workflow.ts'));
  const text = deployWorkflow('customer-docs', '', { branch: 'release/$HOME', managed: true });
  const workflow = parse(text);
  assert.deepEqual(workflow.on.push.branches, ['release/$HOME']);
  assert.equal(workflow.jobs.deploy.env.PRODUCTION_BRANCH, 'release/$HOME');
  assert.match(workflow.jobs.deploy.steps.find(step => step.name === 'Deploy to Cloudflare Pages').run, /--branch="\$PRODUCTION_BRANCH"/);
  assert.doesNotMatch(text, /customer-docs\.freedocstore\.online/);
  assert.throws(() => deployWorkflow('example', '', { branch: '${{secrets.VALUE}}' }), /workflow expressions/);
});

test('Zensical fallback and scalar updates stay within the project section', async () => {
  const { bundle } = await import('./_bundle.mjs');
  const { ensureFallbackFiles } = await import(await bundle('../apps/editor/web/src/model/kb.ts'));
  const { setTomlScalar } = await import(await bundle('../apps/editor/web/src/model/util.ts'));
  const form = { title: 'Customer docs', owner: 'CustomerOrg', slug: 'knowledge', customDomain: '', prompt: 'Public documentation', visibility: 'public' };
  const files = ensureFallbackFiles([], form, 'workflow');
  assert.match(files.find(file => file.path === 'zensical.toml').content, /^\[project\]/);
  const config = '[project]\nsite_name = "Docs"\n[project.extra]\nsite_url = "preserve-this"\n';
  const updated = setTomlScalar(config, 'site_url', 'https://example.com/');
  assert.match(updated, /^\[project\]\nsite_url = "https:\/\/example.com\/"\n/);
  assert.match(updated, /\[project.extra\]\nsite_url = "preserve-this"/);
  assert.throws(() => setTomlScalar('site_name="old"', 'site_url', 'url'), /\[project\]/);
});

test('changes to shared publishing code trigger tests and rebuild both consumers', async () => {
  const { readFileSync } = await import('node:fs');
  const { parse } = await import('yaml');
  for (const file of ['test.yml', 'deploy-api.yml', 'deploy-editor.yml']) {
    const workflow = parse(readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'));
    assert.ok(workflow.on.push.paths.includes('templates/publishing/**'), `${file} must watch the shared publishing dependency`);
  }
});
