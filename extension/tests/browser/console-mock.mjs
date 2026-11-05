export async function mockConsole(page, intercept = async () => false) {
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
