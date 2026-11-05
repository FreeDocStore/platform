import { afterEach, expect, it, vi } from 'vitest';
import { githubRequest, ProvisioningError, retryDelay } from './provisioning-http';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([
  [429, { 'Retry-After': '93' }, 'limit reached', 93],
  [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000100' }, 'limit reached', 100],
  [403, {}, 'You have exceeded a secondary rate limit.', 60],
])('treats GitHub rate limiting (%s) as retryable without changing permissions', async (status, headers, message, delay) => {
  vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message }), { status, headers })));
  const error = await githubRequest('test-token', '/user/installations').catch(error => error);
  expect(error).toBeInstanceOf(ProvisioningError);
  expect(error.status).toBe(503); expect(error.retryAfterSeconds).toBe(delay);
  expect(error.message).not.toContain('permissions');
});

it('retains genuine permission failures as 403', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 })));
  await expect(githubRequest('test-token', '/repos/owner/docs')).rejects.toMatchObject({ status: 403, retryAfterSeconds: undefined });
});

it('parses HTTP-date cooldowns and falls back when provider headers are unusable', () => {
  expect(retryDelay(new Headers({ 'Retry-After': 'Tue, 14 Nov 2023 22:14:20 GMT' }), 1700000000000)).toBe(60);
  expect(retryDelay(new Headers({ 'Retry-After': 'invalid' }), 1700000000000)).toBe(60);
});
