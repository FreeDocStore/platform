import type { Env } from './types';
type KV = Env['FDS_API_KV'];
import { appendHistory, type DeploymentSetup } from './deployment';
import { deploymentKey } from './deployment';
import { ProvisioningError } from './lib/provisioning-http';
import { repositoryById, type Installation, type Repository } from './provisioning';
import { hostingKey, type HostingConnection } from './hosting';

export type ReconciliationStatus = 'ok' | 'renamed' | 'transferred' | 'branch_changed' | 'access_lost' | 'suspended' | 'not_found' | 'provider_outage';
export interface ReconciliationRecord { installationId: number; repoId: number; repoFullName: string; defaultBranch: string; checkedAt: string; status: ReconciliationStatus; message: string }
export interface ReconciliationResult { status: ReconciliationStatus; record: ReconciliationRecord; setup: DeploymentSetup; previousName?: string; currentName?: string }

async function installationsIncludingSuspended(token: string, env: Env): Promise<Installation[]> {
  if (!env.GH_APP_ID) throw new ProvisioningError(503, 'The FreeDocStore GitHub App is not configured.');
  const items: Installation[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) }).catch(() => { throw new ProvisioningError(503, 'GitHub did not answer. Retry reconciliation.'); });
    if (result.status >= 500) throw new ProvisioningError(503, 'GitHub is temporarily unavailable. Retry reconciliation.');
    if (!result.ok) throw new ProvisioningError(result.status === 401 ? 401 : 503, 'GitHub could not verify this app installation. Retry reconciliation.');
    const data = await result.json() as { installations?: Installation[] };
    if (!Array.isArray(data.installations)) throw new ProvisioningError(503, 'GitHub returned an invalid installation list. Retry reconciliation.');
    items.push(...data.installations.filter(item => item.app_id === Number(env.GH_APP_ID)));
    if (data.installations.length < 100) return items;
  }
  throw new ProvisioningError(503, 'GitHub returned too many installations to reconcile safely.');
}

export async function reconcileRepository(env: Env, kv: KV, key: string, token: string, actor = 'unknown'): Promise<ReconciliationResult> {
  const setup = await kv.get<DeploymentSetup>(key, 'json');
  if (!setup) throw new ProvisioningError(404, 'Publishing record was not found.');
  const now = new Date().toISOString();
  const previousName = setup.repoFullName ?? setup.repo;
  const recordKey = setup.installationId && setup.repoId ? `reconcile:${setup.installationId}:${setup.repoId}` : '';
  const finish = async (status: ReconciliationStatus, message: string, updated = setup): Promise<ReconciliationResult> => {
    const record: ReconciliationRecord = { installationId: setup.installationId ?? 0, repoId: setup.repoId ?? 0, repoFullName: updated.repoFullName ?? updated.repo, defaultBranch: updated.branch, checkedAt: now, status, message };
    const next = appendHistory(updated, { event: 'reconcile', actor, at: now, details: { status, message } });
    if (status !== 'provider_outage') await kv.put(key, JSON.stringify(next));
    if (recordKey) await kv.put(recordKey, JSON.stringify(record));
    return { status, record, setup: next, ...(previousName !== record.repoFullName ? { previousName, currentName: record.repoFullName } : {}) };
  };
  if (!setup.repoId || !setup.installationId) return finish('not_found', 'This older publishing record has no stable repository or installation identity. Re-run setup to attach it safely.');
  try {
    const installed = await installationsIncludingSuspended(token, env);
    const installation = installed.find(item => item.id === setup.installationId);
    if (installation?.suspended_at) return finish('suspended', 'The GitHub App installation is suspended. Ask an organization owner to restore it.');
    if (!installation) return finish('access_lost', 'The GitHub App installation is no longer available to this account. Check or restore the installation.');
    let repo: Repository | null;
    try { repo = await repositoryById(token, setup.repoId); }
    catch (error) {
      if (error instanceof ProvisioningError && error.status === 503) return finish('provider_outage', error.message);
      throw error;
    }
    if (!repo) return finish('access_lost', 'GitHub no longer exposes this repository to the connected account. Restore repository access, then reconcile again.');
    if (repo.id !== setup.repoId) return finish('not_found', 'The repository identity did not match the stored record. No repository was adopted.');
    const ownerChanged = previousName.split('/')[0].toLowerCase() !== repo.full_name.split('/')[0].toLowerCase();
    const nameChanged = previousName.toLowerCase() !== repo.full_name.toLowerCase();
    const branchChanged = setup.branch !== repo.default_branch;
    const next = { ...setup, credentialRepo: setup.credentialRepo ?? setup.repo, repo: repo.full_name, repoFullName: repo.full_name, branch: repo.default_branch, updatedAt: now };
    const status: ReconciliationStatus = ownerChanged ? 'transferred' : nameChanged ? 'renamed' : branchChanged ? 'branch_changed' : 'ok';
    const message = ownerChanged ? `Repository transferred to ${repo.full_name}. Review the target and credentials before redeploying.` : nameChanged ? `Repository renamed to ${repo.full_name}.` : branchChanged ? `Default branch changed to ${repo.default_branch}. Review setup before redeploying.` : 'Repository identity and publishing configuration are available.';
    if (nameChanged) {
      const newKey = deploymentKey(repo.full_name);
      const collision = await kv.get<DeploymentSetup>(newKey, 'json');
      if (collision && collision.repoId !== setup.repoId) return finish('not_found', 'The repository name is now used by a different repository. The existing record was left untouched.');
    }
    const result = await finish(status, message, next);
    if (nameChanged) {
      const newKey = deploymentKey(repo.full_name);
      await kv.put(newKey, JSON.stringify(result.setup));
      const oldHostingKey = hostingKey(previousName); const newHostingKey = hostingKey(repo.full_name);
      const connection = await kv.get<HostingConnection>(oldHostingKey, 'json');
      if (connection) {
        await kv.put(newHostingKey, JSON.stringify({ ...connection, repo: repo.full_name }));
        await kv.delete(oldHostingKey);
      }
      await kv.delete(key);
    }
    return result;
  } catch (error) {
    if (error instanceof ProvisioningError && [401, 403, 404].includes(error.status)) return finish(error.status === 404 ? 'access_lost' : 'provider_outage', error.message);
    if (error instanceof ProvisioningError && error.status === 503) return finish('provider_outage', error.message);
    return finish('provider_outage', 'GitHub could not be reached. Publishing state was not changed; retry reconciliation.');
  }
}
