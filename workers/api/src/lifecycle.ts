import type { Env } from './types';
type KV = Env['FDS_API_KV'];
import { appendHistory, type DeploymentSetup, type HistoryEntry } from './deployment';
import { ProvisioningError, githubRequest as gh } from './lib/provisioning-http';
import { credentialNames } from '../../../templates/publishing/workflow';
import { unpublishManagedKnowledgeBase } from './publish';

export type LifecycleAction = 'unpublish' | 'disconnect';
export function lifecyclePreview(setup: DeploymentSetup, action: LifecycleAction) {
  const secrets = setup.credentialVersion ? Object.values(credentialNames(setup.credentialVersion)) : [];
  return { action, effects: [
    `Disable the managed workflow ${'.github/workflows/deploy.yml'} so it cannot start new deployments.`,
    action === 'unpublish' ? 'Stop future library registration; keep the hosted site and repository files in place.' : 'Mark this repository disconnected and stop future deployment and library registration.',
    'Preserve repository content and the existing hosted site.',
    secrets.length ? `Leave these repository secrets intact: ${secrets.join(', ')}.` : 'No managed credential version is recorded.',
  ], managedSecrets: secrets, contentPreserved: true, hostedSitePreserved: true };
}

async function disableWorkflow(token: string, setup: DeploymentSetup) {
  const response = await gh(token, `/repos/${setup.repoFullName ?? setup.repo}/actions/workflows/${encodeURIComponent('.github/workflows/deploy.yml')}/disable`, { method: 'PUT' });
  if (response === null) return;
}
function event(setup: DeploymentSetup, eventName: HistoryEntry['event'], actor: string, details: HistoryEntry['details']) {
  return appendHistory(setup, { event: eventName, actor, at: new Date().toISOString(), details });
}
async function save(kv: KV, key: string, setup: DeploymentSetup) { await kv.put(key, JSON.stringify(setup)); return setup; }

export async function unpublishSite(_env: Env, kv: KV, key: string, token: string, actor: string) {
  const setup = await kv.get<DeploymentSetup>(key, 'json');
  if (!setup) throw new ProvisioningError(404, 'Publishing record was not found.');
  if (setup.status !== 'unpublished') await disableWorkflow(token, setup);
  const updated = await save(kv, key, event({ ...setup, status: 'unpublished', workflowDisabled: true }, 'unpublish', actor, { repo: setup.repoFullName ?? setup.repo, branch: setup.branch, project: setup.project, domain: setup.domain, workflow: '.github/workflows/deploy.yml', contentPreserved: true, hostedSitePreserved: true }));
  let registryWarning: string | undefined;
  try { await unpublishManagedKnowledgeBase({ repo: setup.repoFullName ?? setup.repo, userToken: token, platformToken: _env.GITHUB_TOKEN, org: _env.GITHUB_ORG }); }
  catch { registryWarning = 'Publishing is disabled and the hosted site remains in place, but the public library entry could not be updated. Retry the unpublish action.'; }
  return { ok: true, status: updated.status, effects: lifecyclePreview(setup, 'unpublish').effects, history: updated.history?.[0], ...(registryWarning ? { registryWarning } : {}) };
}

export async function disconnectRepository(env: Env, kv: KV, key: string, token: string, actor: string, removeSecrets = false) {
  const setup = await kv.get<DeploymentSetup>(key, 'json');
  if (!setup) throw new ProvisioningError(404, 'Publishing record was not found.');
  if (setup.status !== 'disconnected') await disableWorkflow(token, setup);
  const updated = await save(kv, key, event({ ...setup, status: 'disconnected', workflowDisabled: true }, 'disconnect', actor, { repo: setup.repoFullName ?? setup.repo, workflow: '.github/workflows/deploy.yml', secretsRemoved: false, contentPreserved: true, hostedSitePreserved: true }));
  const removed = removeSecrets ? await removeRepositorySecrets(env, kv, key, token, actor, updated.credentialVersion ? Object.values(credentialNames(updated.credentialVersion)) : []) : [];
  return { ok: true, status: updated.status, effects: lifecyclePreview(setup, 'disconnect').effects, removedSecrets: removed };
}

export async function removeRepositorySecrets(_env: Env, kv: KV, key: string, token: string, actor: string, secretNames: string[]) {
  const setup = await kv.get<DeploymentSetup>(key, 'json');
  if (!setup) throw new ProvisioningError(404, 'Publishing record was not found.');
  if (!setup.credentialVersion) throw new ProvisioningError(409, 'No managed credential version is recorded for this deployment.');
  const allowed = new Set(Object.values(credentialNames(setup.credentialVersion)));
  if (!secretNames.length || secretNames.some(name => !allowed.has(name))) throw new ProvisioningError(400, 'Only the recorded FreeDocStore credential names for this repository can be removed.');
  const results: Array<{ name: string; removed: boolean }> = [];
  for (const name of [...new Set(secretNames)]) {
    try {
      await gh(token, `/repos/${setup.repoFullName ?? setup.repo}/actions/secrets/${encodeURIComponent(name)}`, { method: 'DELETE', missing: true });
      results.push({ name, removed: true });
    } catch { results.push({ name, removed: false }); }
  }
  const removed = results.filter(item => item.removed).map(item => item.name);
  if (removed.length) await save(kv, key, event(setup, 'secret_removed', actor, { names: removed.join(', ') }));
  return results;
}
