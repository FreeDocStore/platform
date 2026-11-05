import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';

test('console browses source, reports failed builds, and prints an inert proposal', async ({ page }) => {
  test.skip(!existsSync('../apps/editor/web/dist/index.html'), 'Build the editor to run its integration checks.');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://freedocstore.online/registry.json', route => route.fulfill({ json: { knowledge_bases: [{ id: 'example', title: 'Example', source: { repo: 'FreeDocStore/example', branch: 'main' } }] } }));
  await page.route('https://api.freedocstore.online/**', async route => {
    const url = new URL(route.request().url());
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4319', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'Content-Type, Accept, X-GitHub-Api-Version', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS' };
    const reply = (json, status = 200) => route.fulfill({ status, headers, json });
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
