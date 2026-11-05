import { parse } from 'yaml';
import type { Env } from './types';
import { managedRepository, readSource, type Repository } from './provisioning';
import { githubRequest as gh, ProvisioningError } from './lib/provisioning-http';
import { hostingVersionKey, hostingVersionPrefix, type HostingConnection } from './hosting';
import { credentialNames } from '../../../templates/publishing/workflow';

const removedKey = (repo: string, version: string) => `hosting-removed:${repo.toLowerCase()}:${version}`;

async function assertRepositoryAdministrator(token: string, name: string): Promise<Repository> {
  const repo = await managedRepository(token, name);
  if (repo.permissions?.admin !== true) throw new ProvisioningError(403, 'Repository administrator access is required to inspect or remove failed staging credentials.');
  return repo;
}

export async function failedHostingVersions(env: Env, token: string, name: string, cursor?: string) {
  const repo = await assertRepositoryAdministrator(token, name);
  const page = await env.FDS_API_KV.list({ prefix: hostingVersionPrefix(repo.full_name), limit: 100, ...(cursor ? { cursor } : {}) });
  const records = await Promise.all(page.keys.map(key => env.FDS_API_KV.get<HostingConnection>(key.name, 'json')));
  const removed = new Set((await Promise.all(records.map(async record => record?.version && await env.FDS_API_KV.get(removedKey(repo.full_name, record.version)) ? record.version : null))).filter(Boolean));
  return { versions: records.filter((record): record is HostingConnection => record?.status === 'failed' && Boolean(record.version) && !removed.has(record.version!) && record.repo.toLowerCase() === repo.full_name.toLowerCase()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), cursor: page.list_complete ? null : page.cursor };
}

async function repositoryRefs(token: string, repo: string) {
  const branches = await gh<Array<{ name: string; commit: { sha: string } }>>(token, `/repos/${repo}/branches?per_page=100`);
  const prs = await gh<Array<{ number: number; head: { sha: string } }>>(token, `/repos/${repo}/pulls?state=open&per_page=100`);
  if (!Array.isArray(branches) || !Array.isArray(prs) || branches.length >= 100 || prs.length >= 100) throw new ProvisioningError(409, 'Could not fully inspect branches and open pull requests. Review failed staging secrets on GitHub.');
  const refs = [...branches.map(branch => ({ id: `branch:${branch.name}`, sha: branch.commit?.sha })), ...prs.map(pr => ({ id: `pr:${pr.number}`, sha: pr.head?.sha }))].sort((a, b) => a.id.localeCompare(b.id));
  if (!refs.length || refs.some(ref => typeof ref.sha !== 'string' || !/^[a-f0-9]{40}$/.test(ref.sha))) throw new ProvisioningError(409, 'Could not verify repository references. Retry cleanup after checking GitHub.');
  const heads = [...new Set(refs.map(ref => ref.sha))];
  if (heads.length > 8) throw new ProvisioningError(409, 'This repository has too many distinct branch and pull-request versions for automatic cleanup. Review failed staging secrets on GitHub.');
  return { signature: JSON.stringify(refs), heads };
}

/** Only failed, never-ready attempts can be removed; ready versions preserve rollback. */
export async function removeFailedHostingVersion(env: Env, token: string, name: string, version: string) {
  if (!/^[A-F0-9]{32}$/.test(version)) throw new ProvisioningError(400, 'Select a valid failed credential version.');
  const repo = await assertRepositoryAdministrator(token, name);
  const key = hostingVersionKey(repo.full_name, version);
  const connection = await env.FDS_API_KV.get<HostingConnection>(key, 'json');
  if (await env.FDS_API_KV.get(removedKey(repo.full_name, version)) || connection?.status !== 'failed' || connection.version !== version || connection.repo.toLowerCase() !== repo.full_name.toLowerCase()) throw new ProvisioningError(409, 'Only failed staging attempts can be cleaned up. Ready versions are retained for active workflows, reviews and rollback.');
  const names = credentialNames(version);
  const before = await repositoryRefs(token, repo.full_name);
  let files = 0;
  for (const head of before.heads) {
    // A fork PR's commit must be resolvable before interpreting a missing folder.
    const commit = await gh<{ tree: { sha: string } }>(token, `/repos/${repo.full_name}/git/commits/${head}`);
    if (!commit?.tree?.sha) throw new ProvisioningError(409, 'Could not inspect a branch or pull request. Cleanup was stopped.');
    const workflows = await gh<Array<{ type: string; path: string }>>(token, `/repos/${repo.full_name}/contents/.github/workflows?ref=${head}`, { missing: true });
    if (workflows === null) continue;
    if (!Array.isArray(workflows)) throw new ProvisioningError(409, 'Could not inspect repository workflows. Cleanup was stopped.');
    for (const entry of workflows.filter(entry => entry.type === 'file' && /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(entry.path))) {
      if (++files > 20) throw new ProvisioningError(409, 'Too many workflow files to inspect automatically. Review failed staging secrets on GitHub.');
      const source = await readSource(token, repo.full_name, entry.path, head);
      if (!source) throw new ProvisioningError(409, 'A workflow could not be inspected. Cleanup was stopped.');
      let workflow: string;
      try {
        // Decode YAML escapes and aliases before checking case-insensitive secret
        // names. Invalid or cyclic workflow data is never evidence of non-use.
        const parsed = parse(source.content, { maxAliasCount: 10 });
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid workflow');
        workflow = JSON.stringify(parsed).replace(/\\[nrt]/g, ' ').toUpperCase();
      } catch { throw new ProvisioningError(409, 'A workflow could not be parsed safely. Review failed staging secrets on GitHub.'); }
      if (workflow.includes(names.token) || workflow.includes(names.account) || /\bSECRETS\s*\[|\bTOJSON\s*\(\s*SECRETS\b|"SECRETS"\s*:\s*"INHERIT"/.test(workflow)) throw new ProvisioningError(409, 'A branch or open pull request references these credentials or forwards secrets dynamically. Review cleanup on GitHub.');
    }
  }
  if ((await repositoryRefs(token, repo.full_name)).signature !== before.signature) throw new ProvisioningError(409, 'Branches or pull requests changed during cleanup. Refresh and review again.');
  for (const secret of [names.token, names.account]) await gh(token, `/repos/${repo.full_name}/actions/secrets/${secret}`, { method: 'DELETE', missing: true });
  // A separate tombstone keeps the terminal attempt record immutable.
  await env.FDS_API_KV.put(removedKey(repo.full_name, version), new Date().toISOString());
  return { removed: true, version };
}
