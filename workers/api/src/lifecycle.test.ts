import { afterEach, describe, expect, it, vi } from 'vitest';
import { deploymentKey, type DeploymentSetup } from './deployment';
import { disconnectRepository, lifecyclePreview, removeRepositorySecrets, unpublishSite } from './lifecycle';
import type { Env } from './types';

const setup: DeploymentSetup = { repo: 'Org/docs', repoFullName: 'Org/docs', repoId: 9, installationId: 7, branch: 'main', project: 'docs', domain: '', accountId: 'b'.repeat(32), credentialVersion: 'A'.repeat(32), workflow: 'reviewed', updatedAt: '2026-01-01T00:00:00Z', status: 'active', history: [] };
function fixture() {
  const values = new Map<string, string>([[deploymentKey(setup.repo), JSON.stringify(setup)]]); const secrets = new Set(['FDS_CF_TOKEN_' + 'A'.repeat(32), 'FDS_CF_ACCOUNT_' + 'A'.repeat(32), 'ORG_SHARED_TOKEN']); const calls: string[] = [];
  const kv = { get: vi.fn(async (key: string, type?: string) => { const value = values.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value; }), put: vi.fn(async (key: string, value: string) => { values.set(key, value); }), delete: vi.fn(async (key: string) => { values.delete(key); }) } as unknown as Env['FDS_API_KV'];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => { const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url); calls.push(`${init?.method ?? 'GET'} ${url.pathname}`); if (url.pathname.includes('/actions/secrets/')) secrets.delete(decodeURIComponent(url.pathname.split('/').pop()!)); if (url.pathname.endsWith('/registry.json')) return new Response(JSON.stringify({ content: btoa(JSON.stringify({ knowledge_bases: [] })), sha: 'sha' })); return new Response(null, { status: 204 }); }));
  return { values, secrets, calls, kv, env: { GITHUB_TOKEN: 'platform-token', GITHUB_ORG: 'FreeDocStore' } as Env };
}
afterEach(() => vi.unstubAllGlobals());

describe('publishing lifecycle', () => {
  it('previews effects without changing state', async () => {
    const f = fixture(); const before = f.values.get(deploymentKey(setup.repo));
    const preview = lifecyclePreview(setup, 'unpublish');
    expect(preview.contentPreserved).toBe(true); expect(preview.hostedSitePreserved).toBe(true);
    expect(f.values.get(deploymentKey(setup.repo))).toBe(before); expect(f.calls).toEqual([]);
  });
  it('unpublishes by disabling workflow while preserving content and site', async () => {
    const f = fixture(); const result = await unpublishSite(f.env, f.kv, deploymentKey(setup.repo), 'user-token', 'owner');
    const saved = JSON.parse(f.values.get(deploymentKey(setup.repo))!);
    expect(result.status).toBe('unpublished'); expect(f.calls[0]).toContain('/actions/workflows/');
    expect(saved.history[0].event).toBe('unpublish'); expect(saved.history[0].actor).toBe('owner');
  });
  it('disconnects without removing credentials unless separately selected', async () => {
    const f = fixture(); await disconnectRepository(f.env, f.kv, deploymentKey(setup.repo), 'user-token', 'owner', false);
    expect(JSON.parse(f.values.get(deploymentKey(setup.repo))!).status).toBe('disconnected');
    expect(f.secrets.has('FDS_CF_TOKEN_' + 'A'.repeat(32))).toBe(true);
  });
  it('can remove only its credential pair when removal is explicitly requested', async () => {
    const f = fixture();
    const removed = await disconnectRepository(f.env, f.kv, deploymentKey(setup.repo), 'user-token', 'owner', true);
    expect(removed.removedSecrets).toHaveLength(2);
    expect(f.secrets.has('ORG_SHARED_TOKEN')).toBe(true);
    expect(JSON.parse(f.values.get(deploymentKey(setup.repo))!).history.map((item: { event: string }) => item.event)).toEqual(['secret_removed', 'disconnect']);
  });
  it('removes only exact recorded managed secrets and rejects unrelated names', async () => {
    const f = fixture();
    await expect(removeRepositorySecrets(f.env, f.kv, deploymentKey(setup.repo), 'user-token', 'owner', ['ORG_SHARED_TOKEN'])).rejects.toThrow(/Only the recorded/);
    await removeRepositorySecrets(f.env, f.kv, deploymentKey(setup.repo), 'user-token', 'owner', ['FDS_CF_TOKEN_' + 'A'.repeat(32)]);
    expect(f.secrets.has('FDS_CF_TOKEN_' + 'A'.repeat(32))).toBe(false); expect(f.secrets.has('ORG_SHARED_TOKEN')).toBe(true);
  });
  it('caps history to 50 newest events', async () => {
    const f = fixture(); const history = Array.from({ length: 55 }, (_, i) => ({ event: 'deploy', actor: 'owner', at: new Date(1000 * i).toISOString(), details: {} }));
    f.values.set(deploymentKey(setup.repo), JSON.stringify({ ...setup, history }));
    await disconnectRepository(f.env, f.kv, deploymentKey(setup.repo), 'user-token', 'owner');
    const saved = JSON.parse(f.values.get(deploymentKey(setup.repo))!);
    expect(saved.history).toHaveLength(50); expect(saved.history[0].event).toBe('disconnect');
  });
  it('leaves setup active if GitHub cannot disable the workflow', async () => {
    const f = fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'unavailable' }), { status: 503 })));
    await expect(unpublishSite(f.env, f.kv, deploymentKey(setup.repo), 'user-token', 'owner')).rejects.toThrow(/temporarily unavailable/);
    expect(JSON.parse(f.values.get(deploymentKey(setup.repo))!).status).toBe('active');
  });
});
