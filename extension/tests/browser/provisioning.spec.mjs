import { test, expect } from '@playwright/test';
import { mockConsole } from './console-mock.mjs';

const repo = 'CustomerOrg/knowledge';
const account = { id: 'a'.repeat(32), name: 'Customer Cloudflare' };
const projects = [{ name: 'customer-docs', production_branch: 'release', domains: [] }];
const connection = { repo, accountId: account.id, accountName: account.name, status: 'ready', version: 'A'.repeat(32), projects, updatedAt: '2026-11-05T00:00:00Z' };
const token = 'test-only-hosting-token-not-for-real-use';
const plan = { planId: 'review-plan', credentialVersion: connection.version, repo, branch: 'release', project: 'customer-docs', domain: '', url: 'https://customer-docs.pages.dev/', accountName: account.name, files: [{ path: '.github/workflows/deploy.yml', before: 'name: Previous deployment', content: 'name: FreeDocStore public publishing', expectedSha: 'b'.repeat(40) }], replacesWorkflow: true, warning: 'Existing source files are preserved.' };

async function setupMock(page, options = {}) {
  const requests = [];
  let connected = Boolean(options.connected);
  let applied = Boolean(options.applied);
  let retry = false;
  let checked = 0;
  await mockConsole(page, async (route, reply, url) => {
    if (route.request().method() === 'OPTIONS') return false;
    if (!url.pathname.startsWith('/api/provisioning/')) return false;
    const endpoint = url.pathname.split('/').at(-1);
    const body = route.request().postDataJSON();
    requests.push({ endpoint, body, boundAccount: route.request().headers()['x-fds-account'] });
    if (endpoint === 'installations') { await reply({ installations: options.noInstallations ? [] : [{ id: 7, account: { login: 'CustomerOrg', type: 'Organization' }, permissions: { contents: 'write', actions: 'write', secrets: 'write', workflows: 'write' } }], installUrl: 'https://github.com/apps/freedocstore/installations/new' }); return true; }
    if (endpoint === 'repositories') { await reply({ repositories: [{ fullName: repo, name: 'knowledge', branch: 'release', canConfigure: true }] }); return true; }
    if (endpoint === 'connection') { await reply({ connection: connected ? { ...connection, version: options.legacy ? undefined : connection.version, projects: options.missingProjectSnapshot ? [] : projects } : null, setup: applied ? { project: 'customer-docs', branch: 'release', domain: '', accountId: account.id } : null }); return true; }
    if (endpoint === 'accounts') {
      if (options.cloudflareUnavailable) await reply({ error: 'Cloudflare is temporarily unavailable. Retry without replacing your token.' }, 503);
      else await reply({ accounts: [account], ...(body.accountId ? { projects } : {}) });
      return true;
    }
    if (endpoint === 'connect') {
      if (options.stagingFailure) await reply({ error: 'Credential staging was incomplete. The active deployment was not changed.' }, 403);
      else { connected = true; await reply({ connection }); }
      return true;
    }
    if (endpoint === 'staging') { await reply({ versions: [{ ...connection, version: 'B'.repeat(32), status: 'failed' }], cursor: null }); return true; }
    if (endpoint === 'cleanup') { await reply({ removed: true }); return true; }
    if (endpoint === 'plan') { await reply(options.plan ?? plan); return true; }
    if (endpoint === 'apply') {
      applied = true;
      await reply(options.pullRequest ? { ok: true, prUrl: `https://github.com/${repo}/pull/42`, prNumber: 42 } : { ok: true, commitSha: 'a'.repeat(40) }); return true;
    }
    if (endpoint === 'deploy') { retry = true; checked = 0; await reply({ ok: true }); return true; }
    if (endpoint === 'status') {
      checked++;
      if (options.transientStatus && checked === 1) { await reply({ error: 'GitHub is temporarily unavailable.', retryAfterSeconds: 1 }, 503); return true; }
      if (options.pullRequest) await reply({ state: 'awaiting-review', prUrl: `https://github.com/${repo}/pull/42`, message: 'Review and merge the setup pull request.' });
      else if (options.failed && !retry) await reply({ state: 'failed', failedSteps: ['deploy: Ensure Cloudflare Pages project'], runUrl: `https://github.com/${repo}/actions/runs/1`, message: 'Deployment failed. Check token permissions and retry.' });
      else if (checked === 1 && retry) await reply({ state: 'building', message: 'GitHub Actions: queued.' });
      else await reply({ state: 'live', pagesReady: true, domainReady: true, pagesUrl: plan.url, url: plan.url, message: 'Verified: the public site serves this repository and deployed source version.' });
      return true;
    }
    if (endpoint === 'register') { await reply({ state: 'live', pagesReady: true, domainReady: true, pagesUrl: plan.url, url: plan.url, registryKbId: 'customerorg-knowledge', message: 'Verified: the public site serves this repository and deployed source version.' }); return true; }
    await reply({ error: 'Unexpected setup call' }, 404); return true;
  });
  return requests;
}

async function chooseRepository(page) {
  await page.goto('/provision');
  await page.getByLabel('GitHub organization or account').selectOption('7');
  await expect(page.getByLabel('Public repository')).toContainText(repo);
  await page.getByLabel('Public repository').selectOption(repo);
  await expect(page.getByLabel('Cloudflare API token')).toBeEnabled();
}
async function connectHosting(page) {
  await page.getByLabel('Cloudflare API token').fill(token);
  await page.getByRole('button', { name: 'Check token and accounts' }).click();
  await expect(page.getByRole('combobox', { name: 'Cloudflare account', exact: true })).toHaveValue(account.id);
  await page.getByRole('button', { name: 'Stage hosting credentials' }).click();
}
async function reviewPlan(page) {
  await page.getByRole('combobox', { name: 'Pages project', exact: true }).selectOption('customer-docs');
  await page.getByLabel('Publish this repository to the selected existing Pages project.', { exact: false }).check();
  await page.getByRole('button', { name: 'Review setup changes' }).click();
  await expect(page.getByText('Setup and draft review · Customer Cloudflare', { exact: true })).toBeVisible();
}

test('customer organization setup connects hosting, reviews changes, recovers a failed build and verifies publication', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const requests = await setupMock(page, { failed: true });
  await chooseRepository(page);
  await connectHosting(page);
  await expect(page.getByLabel('Cloudflare API token')).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })) ).not.toContain(token);
  await reviewPlan(page);
  await expect(page.getByRole('button', { name: 'Open setup pull request' })).toBeDisabled();
  await page.getByText('.github/workflows/deploy.yml · update', { exact: true }).click();
  await expect(page.getByText(/Previous deployment/)).toBeVisible();
  await page.getByLabel('Replace the existing deploy.yml workflow', { exact: false }).check();
  await page.getByRole('combobox', { name: 'Apply setup', exact: true }).selectOption('direct');
  await page.getByRole('button', { name: 'Commit reviewed setup' }).click();
  await expect(page.getByText('deploy: Ensure Cloudflare Pages project', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Deploy / retry' }).click();
  await expect(page.getByRole('link', { name: 'Open published knowledge base' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Edit this knowledge base in FreeDocStore' })).toBeEnabled();
  expect(requests.every(request => request.boundAccount === 'user')).toBe(true);
  expect(requests.find(request => request.endpoint === 'connect').body.repo).toBe(repo);
  expect(requests.find(request => request.endpoint === 'apply').body.confirmReplaceWorkflow).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('button', { name: 'Set up' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: '/tmp/fdocs-provisioning-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Edit this knowledge base in FreeDocStore' }).click();
  await expect(page).toHaveURL(/edit\/customerorg-knowledge\/docs\/index.md/);
  await expect(page.getByText('# Original source', { exact: false }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('workspace AI draft enters setup review, applies with content confirmation and verifies live', async ({ page }) => {
  const generated = [{ path: 'docs/index.md', content: '# Reviewed workspace draft\n' }, { path: 'docs/guide.md', content: '# Guide\n' }];
  const setupPlan = { ...plan, hasDraftChanges: true, files: [...plan.files, ...generated.map(file => ({ ...file, before: file.path.endsWith('index.md') ? '# Existing page\n' : '', expectedSha: file.path.endsWith('index.md') ? 'b'.repeat(40) : null }))] };
  const requests = await setupMock(page, { connected: true, plan: setupPlan });
  await page.addInitScript(({ user, files }) => {
    localStorage.setItem(`fds:account:${user}:drafts`, JSON.stringify([{ id: 'draft-1', title: 'Launch Guide', slug: 'launch-guide', owner: 'CustomerOrg', customDomain: '', visibility: 'public', prompt: 'Create a launch guide', files, liveUrl: '', repoUrl: '', lastStatus: 'Files generated', createdAt: '', updatedAt: '', steps: [] }]));
    localStorage.setItem(`fds:account:${user}:active`, 'draft-1');
  }, { user: 'user', files: generated });
  await page.goto('/publish');
  await expect(page.getByText('Launch Guide', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Continue to setup', exact: true }).click();
  await page.getByLabel('GitHub organization or account').selectOption('7');
  await expect(page.getByLabel('Public repository')).toContainText(repo);
  await page.getByLabel('Public repository').selectOption(repo);
  await expect(page.getByText('Launch Guide', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: 'Pages project', exact: true }).selectOption('customer-docs');
  await page.getByLabel('Publish this repository to the selected existing Pages project.', { exact: false }).check();
  await page.getByRole('button', { name: 'Review setup changes' }).click();
  await expect(page.getByText('Setup and draft review · Customer Cloudflare', { exact: true })).toBeVisible();
  expect(requests.find(request => request.endpoint === 'plan').body.draftFiles).toEqual(generated);
  const guideReview = page.locator('.setup-review details').filter({ has: page.getByText('docs/guide.md · new file', { exact: true }) });
  await guideReview.locator('summary').click();
  await expect(guideReview.locator('pre')).toContainText('+ # Guide');
  await page.getByLabel('I reviewed and approve the generated content changes', { exact: false }).check();
  await page.getByLabel('Replace the existing deploy.yml workflow', { exact: false }).check();
  await page.getByRole('button', { name: 'Open setup pull request' }).click();
  await expect(page.getByRole('link', { name: 'Open published knowledge base' })).toBeVisible({ timeout: 15000 });
  expect(requests.find(request => request.endpoint === 'apply').body.confirmDraftContent).toBe(true);
});

test('setup pull requests stay reviewable and cannot deploy before merge', async ({ page }) => {
  await setupMock(page, { connected: true, pullRequest: true });
  await chooseRepository(page); await reviewPlan(page);
  await page.getByLabel('Replace the existing deploy.yml workflow', { exact: false }).check();
  await page.getByRole('button', { name: 'Open setup pull request' }).click();
  await expect(page.getByRole('link', { name: 'Review setup pull request', exact: true })).toHaveAttribute('href', `https://github.com/${repo}/pull/42`);
  await expect(page.getByRole('button', { name: 'Deploy / retry' })).toBeDisabled();
});

test('staging keeps the existing deployment available until reviewed activation', async ({ page }) => {
  const requests = await setupMock(page, { connected: true, applied: true });
  await chooseRepository(page); await connectHosting(page);
  await expect(page.getByText('Credentials staged for Customer Cloudflare.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open published knowledge base' })).toBeVisible();
  expect(requests.some(request => request.endpoint === 'apply')).toBe(false);
  expect(requests.find(request => request.endpoint === 'connect').body.confirmOverwrite).toBeUndefined();
  await reviewPlan(page);
  await expect(page.getByText('Credential version:', { exact: false })).toContainText(connection.version);
});

test('failed staging can be reviewed and explicitly cleaned up', async ({ page }) => {
  const requests = await setupMock(page, { stagingFailure: true });
  await chooseRepository(page); await connectHosting(page);
  await expect(page.getByRole('alert')).toContainText('The active deployment was not changed');
  await page.getByRole('button', { name: 'Review failed staging attempts' }).click();
  await expect(page.getByRole('button', { name: 'Remove failed credentials' })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Remove failed staging credentials', { exact: false }).check();
  await page.getByRole('button', { name: 'Remove failed credentials' }).click();
  await expect(page.getByText('Failed staging credentials removed.', { exact: false })).toBeVisible();
  expect(requests.find(request => request.endpoint === 'cleanup').body).toEqual({ repo, version: 'B'.repeat(32), confirm: true });
});

test('legacy credentials retain deployment tracking while requiring staging for new review', async ({ page }) => {
  await setupMock(page, { connected: true, applied: true, legacy: true });
  await chooseRepository(page);
  await expect(page.getByText('Stage a fresh credential version', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review setup changes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Deploy / retry' })).toBeEnabled();
});

test('missing installations and temporary provider failures have actionable recovery', async ({ page }) => {
  await setupMock(page, { noInstallations: true });
  await page.goto('/provision');
  await expect(page.getByText('No accessible app installations yet.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Install or configure GitHub App' })).toHaveAttribute('href', 'https://github.com/apps/freedocstore/installations/new');
  await setupMock(page, { cloudflareUnavailable: true });
  await chooseRepository(page);
  await page.getByLabel('Cloudflare API token').fill(token);
  await page.getByRole('button', { name: 'Check token and accounts' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'temporarily unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check token and accounts' })).toBeEnabled();
});


test('a reloaded configured target can be reviewed without pasting hosting credentials again', async ({ page }) => {
  const requests = await setupMock(page, { connected: true, applied: true, missingProjectSnapshot: true });
  await chooseRepository(page);
  await expect(page.getByRole('combobox', { name: 'Pages project', exact: true })).toHaveValue('customer-docs');
  await expect(page.getByRole('combobox', { name: 'Pages project', exact: true })).toContainText('configured target');
  await page.getByLabel('Publish this repository to the selected configured Pages project.', { exact: false }).check();
  await page.getByRole('button', { name: 'Review setup changes' }).click();
  await expect(page.getByText('Setup and draft review · Customer Cloudflare', { exact: true })).toBeVisible();
  expect(requests.filter(request => ['accounts', 'connect'].includes(request.endpoint))).toHaveLength(0);
});

test('automatic deployment checks recover after a transient provider error', async ({ page }) => {
  await page.clock.install();
  const requests = await setupMock(page, { connected: true, applied: true, transientStatus: true });
  await chooseRepository(page);
  await expect(page.getByText(/Automatic checks will retry in 5 seconds/)).toBeVisible();
  await page.clock.fastForward(5000);
  await expect(page.getByRole('link', { name: 'Open published knowledge base' })).toBeVisible();
  await expect(page.getByText(/Automatic checks will retry/)).toHaveCount(0);
  expect(requests.filter(request => request.endpoint === 'status')).toHaveLength(2);
});
