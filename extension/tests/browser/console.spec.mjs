import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';

async function mockConsole(page, intercept = async () => false) {
  await page.route('https://freedocstore.online/registry.json', route => route.fulfill({ json: { knowledge_bases: [{ id: 'example', title: 'Example', source: { repo: 'FreeDocStore/example', branch: 'main' } }] } }));
  await page.route('https://api.freedocstore.online/**', async route => {
    const url = new URL(route.request().url());
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4319', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'Content-Type, Accept, X-GitHub-Api-Version, X-FDS-Account', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS' };
    const reply = (json, status = 200) => route.fulfill({ status, headers, json });
    if (await intercept(route, reply, url)) return;
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/api/me') return reply({ authenticated: true, user: { id: 'user', login: 'reader', name: 'Reader', provider: 'github', avatarUrl: '' } });
    if (url.pathname.startsWith('/api/kv/')) return reply({ value: null });
    if (url.pathname === '/api/billing') return reply({ status: 'free' });
    if (url.pathname === '/api/secrets') return reply({ openai: { configured: true }, anthropic: { configured: false } });
    if (url.pathname === '/api/proxy') {
      const target = url.searchParams.get('target');
      if (target.includes('/contents/')) return reply({ encoding: 'base64', content: btoa(target.includes('other.md') ? '# Another source page' : '# Original source\n\nUseful content.') });
      if (target.includes('/git/trees/')) return reply({ tree: [{ path: 'docs/index.md', type: 'blob' }, { path: 'docs/other.md', type: 'blob' }] });
      if (target.includes('/pulls')) return reply([{ number: 12, title: 'Review this change', html_url: 'https://github.com/FreeDocStore/example/pull/12' }]);
      if (target.includes('/actions/runs')) return reply({ error: 'Forbidden' }, 403);
      if (target.includes('/user')) return reply({ login: 'reader' });
      const body = route.request().postData() || '';
      if (target.includes('openai.com') || target.includes('models.github.ai')) return reply({ choices: [{ message: { content: JSON.stringify(body.includes('Current source') ? { summary: 'Improve <script>window.pwned=1</script>', rationale: 'Explain the change clearly.', content: '# Revised source\n\n<script>window.pwned=1</script>' } : { ok: true }) } }] });
    }
    return reply({ error: 'Unexpected request' }, 404);
  });
}

test('console browses source, reports failed builds, and prints an inert proposal', async ({ page }) => {
  test.skip(!existsSync('../apps/editor/web/dist/index.html'), 'Build the editor to run its integration checks.');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockConsole(page);
  await page.goto('/edit/example/docs/index.md');
  await expect(page.getByText('# Original source', { exact: false }).first()).toBeVisible();
  await page.getByText('Repository files, proposals and builds', { exact: true }).click();
  await expect(page.getByRole('link', { name: '#12 Review this change' })).toBeVisible();
  await expect(page.getByText(/Builds: HTTP 403/)).toBeVisible();
  await expect(page.getByText('No workflow runs found for this branch.')).toHaveCount(0);
  await page.getByRole('button', { name: /Ask AI/ }).first().click();
  await expect(page.getByRole('button', { name: 'Print proposal' })).toBeEnabled();
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Print proposal' }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole('heading', { name: 'Improve <script>window.pwned=1</script>', exact: true })).toBeVisible();
  expect(await popup.evaluate(() => window.pwned)).toBeUndefined();
  await expect(popup.locator('script')).toHaveCount(0);
  await popup.close();
  await page.getByRole('combobox', { name: 'Open source page' }).selectOption('docs/other.md');
  await expect(page.getByText('# Another source page', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print proposal' })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText('Page narration', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate audio' })).toBeEnabled();
  await page.screenshot({ path: '/tmp/fds-console-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});


test('account caches stay isolated and unowned legacy drafts are never uploaded', async ({ page }) => {
  let account = 'account-a';
  const writes = [];
  await page.addInitScript(() => {
    localStorage.setItem('fds-kb-drafts', JSON.stringify([{ id: 'old', title: 'Unowned legacy draft' }]));
  });
  await mockConsole(page, async (route, reply, url) => {
    if (url.pathname === '/api/me') {
      await reply({ authenticated: true, user: { id: account, login: account, name: account, provider: 'github', avatarUrl: '' } }); return true;
    }
    if (url.pathname.startsWith('/api/kv/') && route.request().method() === 'PUT') {
      writes.push({ account: route.request().headers()['x-fds-account'], body: route.request().postDataJSON() });
      await reply({ ok: true }); return true;
    }
    return false;
  });
  await page.goto('/');
  await expect(page.getByText('True Non-Profit', { exact: true }).first()).toBeVisible();
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(writes.every(write => write.account === 'account-a')).toBe(true);
  expect(JSON.stringify(writes)).not.toContain('Unowned legacy draft');
  await page.evaluate(() => {
    const key = 'fds:account:account-a:drafts';
    const drafts = JSON.parse(localStorage.getItem(key));
    drafts[0].title = 'Only account A';
    localStorage.setItem(key, JSON.stringify(drafts));
  });
  account = 'account-b'; writes.length = 0;
  await page.reload();
  await expect(page.getByText('True Non-Profit', { exact: true }).first()).toBeVisible();
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(writes.every(write => write.account === 'account-b')).toBe(true);
  expect(JSON.stringify(writes)).not.toContain('Only account A');
  expect(await page.evaluate(() => localStorage.getItem('fds:account:account-a:drafts'))).toContain('Only account A');
});

test('failed cloud hydration permits local drafts without overwriting cloud data', async ({ page }) => {
  const writes = [];
  await mockConsole(page, async (route, reply, url) => {
    if (url.pathname.startsWith('/api/kv/')) {
      if (route.request().method() === 'PUT') writes.push(route.request().postDataJSON());
      await reply({ error: 'Unavailable' }, 503); return true;
    }
    return false;
  });
  await page.goto('/');
  await expect(page.getByText('True Non-Profit', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Create KB', exact: true }).click();
  await expect(page.getByText('Untitled Knowledge Base', { exact: true }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('fds:account:user:drafts'))).toContain('Untitled Knowledge Base');
  expect(writes).toEqual([]);
});

test('late AI response is discarded after the same source page is reloaded', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let started = false;
  let source = '# Original source';
  await mockConsole(page, async (route, reply, url) => {
    const target = url.searchParams.get('target') || '';
    if (target.includes('/contents/')) { await reply({ encoding: 'base64', content: btoa(source) }); return true; }
    if (route.request().method() === 'POST' && (route.request().postData() || '').includes('Current source')) {
      started = true;
      await pending;
      await reply({ choices: [{ message: { content: JSON.stringify({ summary: 'Stale proposal', rationale: 'Old source', content: '# Stale replacement' }) } }] });
      return true;
    }
    return false;
  });
  await page.goto('/edit/example/docs/index.md');
  await expect(page.getByText('# Original source', { exact: false }).first()).toBeVisible();
  await page.getByText('Repository files, proposals and builds', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Open source page' })).toContainText('docs/index.md');
  await page.getByRole('button', { name: /Ask AI/ }).first().click();
  await expect.poll(() => started).toBe(true);
  source = '# New source version';
  await page.getByRole('combobox', { name: 'Open source page' }).selectOption('docs/index.md');
  await expect(page.getByText('# New source version', { exact: false }).first()).toBeVisible();
  const completed = page.waitForResponse(response => response.request().method() === 'POST' && (response.request().postData() || '').includes('Current source'));
  release();
  await completed;
  await expect(page.getByRole('button', { name: /Ask AI/ }).first()).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Print proposal' })).toBeDisabled();
  await expect(page.getByText('Stale proposal', { exact: true })).toHaveCount(0);
});

test('narration cancellation discards late worker output and publication cannot start twice', async ({ page }) => {
  await page.addInitScript(() => {
    window.audioWorkers = [];
    window.Worker = class {
      constructor() { this.terminated = false; window.audioWorkers.push(this); }
      postMessage() {}
      terminate() { this.terminated = true; }
    };
  });
  let publishCount = 0;
  let unchanged = false;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await mockConsole(page, async (route, reply, url) => {
    if (url.pathname === '/api/audio') {
      publishCount++;
      await pending;
      await reply(unchanged ? { ok: true, unchanged: true } : { ok: true, prUrl: 'https://github.com/FreeDocStore/example/pull/99' }); return true;
    }
    return false;
  });
  await page.goto('/edit/example/docs/index.md');
  await expect(page.getByText('# Original source', { exact: false }).first()).toBeVisible();
  await page.getByText('Page narration', { exact: true }).click();
  await page.getByRole('button', { name: 'Generate audio' }).click();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => window.audioWorkers[0].onmessage({ data: { type: 'complete', wav: new ArrayBuffer(44) } }));
  expect(await page.evaluate(() => window.audioWorkers[0].terminated)).toBe(true);
  await expect(page.getByRole('button', { name: 'Propose audio publication' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Generate audio' }).click();
  await expect.poll(() => page.evaluate(() => window.audioWorkers.length)).toBe(2);
  await page.evaluate(() => window.audioWorkers[1].onmessage({ data: { type: 'complete', wav: new ArrayBuffer(44) } }));
  const publish = page.getByRole('button', { name: 'Propose audio publication' });
  await expect(publish).toBeEnabled();
  await publish.evaluate(button => { button.click(); button.click(); });
  await expect.poll(() => publishCount).toBe(1);
  release();
  await expect(page.getByRole('link', { name: 'Review narration proposal' })).toBeVisible();
  expect(publishCount).toBe(1);
  unchanged = true;
  await publish.click();
  await expect(page.getByText('This recording is already on the base branch. No proposal was needed.')).toBeVisible();
});


test('unchanged text proposals show an explicit result without inventing a PR', async ({ page }) => {
  await mockConsole(page, async (route, reply, url) => {
    if (url.pathname === '/api/edit') { await reply({ ok: true, unchanged: true, branch: 'main' }); return true; }
    return false;
  });
  await page.goto('/edit/example/docs/index.md');
  await expect(page.getByText('# Original source', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: /Ask AI/ }).first().click();
  await expect(page.getByRole('button', { name: 'Print proposal' })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply as pull request' }).click();
  await expect(page.getByText('No changes to apply. The base branch already contains this content.', { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/PR #undefined/)).toHaveCount(0);
});
