import { afterEach, describe, expect, it, vi } from 'vitest';
import { deploymentKey, type DeploymentSetup } from './deployment';
import { reconcileRepository } from './reconciliation';
import type { Env } from './types';

const base = (): DeploymentSetup => ({ repo: 'OldOrg/guide', repoFullName: 'OldOrg/guide', repoId: 77, installationId: 7, branch: 'main', project: 'guide', domain: '', accountId: 'a'.repeat(32), credentialVersion: 'A'.repeat(32), workflow: 'workflow', updatedAt: '2026-01-01T00:00:00Z', status: 'active', history: [] });
function harness(options: { name?: string; owner?: string; branch?: string; repoStatus?: number; install?: Record<string, unknown>; network?: boolean } = {}) {
  const values = new Map<string, string>([[deploymentKey('OldOrg/guide'), JSON.stringify(base())]]);
  const kv = {
    get: vi.fn(async (key: string, type?: string) => { const value = values.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value; }),
    put: vi.fn(async (key: string, value: string) => { values.set(key, value); }), delete: vi.fn(async (key: string) => { values.delete(key); }),
  } as unknown as Env['FDS_API_KV'];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    if (url.pathname.startsWith('/user/installations')) return new Response(JSON.stringify({ installations: [options.install ?? { id: 7, app_id: 10, account: { login: 'OldOrg' } }] }), { status: 200 });
    if (options.network) throw new Error('network down');
    if (url.pathname === '/repositories/77') return new Response(JSON.stringify({ id: 77, full_name: `${options.owner ?? 'OldOrg'}/${options.name ?? 'guide'}`, name: options.name ?? 'guide', private: false, default_branch: options.branch ?? 'main', permissions: { push: true } }), { status: options.repoStatus ?? 200 });
    return new Response('{}', { status: 500 });
  });
  vi.stubGlobal('fetch', fetch);
  return { kv, values, fetch, env: { GH_APP_ID: '10' } as Env };
}
afterEach(() => vi.unstubAllGlobals());

describe('repository reconciliation', () => {
  it('moves setup by stable identity after a rename', async () => {
    const f = harness({ name: 'manual' });
    const result = await reconcileRepository(f.env, f.kv, deploymentKey('OldOrg/guide'), 'user-token', 'admin');
    expect(result.status).toBe('renamed');
    expect(result.setup.repoFullName).toBe('OldOrg/manual');
    expect(f.values.has(deploymentKey('OldOrg/guide'))).toBe(false);
    expect(JSON.parse(f.values.get(deploymentKey('OldOrg/manual'))!).repoId).toBe(77);
  });
  it('detects a transfer and a default branch change using the same repository id', async () => {
    const transfer = harness({ owner: 'NewOrg' });
    expect((await reconcileRepository(transfer.env, transfer.kv, deploymentKey('OldOrg/guide'), 'token')).status).toBe('transferred');
    const branch = harness({ branch: 'trunk' });
    const result = await reconcileRepository(branch.env, branch.kv, deploymentKey('OldOrg/guide'), 'token');
    expect(result.status).toBe('branch_changed'); expect(result.setup.branch).toBe('trunk');
  });
  it('retains the deployment when access is lost or the installation is suspended', async () => {
    const lost = harness({ repoStatus: 404 });
    expect((await reconcileRepository(lost.env, lost.kv, deploymentKey('OldOrg/guide'), 'token')).status).toBe('access_lost');
    expect(lost.values.has(deploymentKey('OldOrg/guide'))).toBe(true);
    const suspended = harness({ install: { id: 7, app_id: 10, suspended_at: '2026-01-02T00:00:00Z' } });
    expect((await reconcileRepository(suspended.env, suspended.kv, deploymentKey('OldOrg/guide'), 'token')).status).toBe('suspended');
    expect(suspended.values.has(deploymentKey('OldOrg/guide'))).toBe(true);
  });
  it('does not change setup state on provider outage or adopt a repository with a different id', async () => {
    const outage = harness({ network: true }); const before = outage.values.get(deploymentKey('OldOrg/guide'));
    expect((await reconcileRepository(outage.env, outage.kv, deploymentKey('OldOrg/guide'), 'token')).status).toBe('provider_outage');
    expect(outage.values.get(deploymentKey('OldOrg/guide'))).toBe(before);
    const reusedName = harness();
    const f = reusedName.fetch as unknown as ReturnType<typeof vi.fn>;
    f.mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      return url.pathname.startsWith('/user/installations') ? new Response(JSON.stringify({ installations: [{ id: 7, app_id: 10 }] })) : new Response(JSON.stringify({ id: 88, full_name: 'OldOrg/guide', name: 'guide', private: false, default_branch: 'main' }));
    });
    expect((await reconcileRepository(reusedName.env, reusedName.kv, deploymentKey('OldOrg/guide'), 'token')).status).toBe('not_found');
    expect(JSON.parse(reusedName.values.get(deploymentKey('OldOrg/guide'))!).repoId).toBe(77);
  });
});
