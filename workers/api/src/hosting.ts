import { ProvisioningError, retryDelay } from './lib/provisioning-http';
import { managedRepository } from './provisioning';
import { writeRepositorySecrets, repositorySecretNames } from './lib/repository-secrets';
import { credentialNames } from '../../../templates/publishing/workflow';
import type { DeploymentSetup } from './deployment';
import type { Env } from './types';

interface Account { id: string; name: string }
export interface HostingConnection { repo: string; accountId: string; accountName: string; status: 'connecting' | 'ready' | 'failed' | 'removed'; updatedAt: string; version?: string; projects: Array<{ name: string; production_branch: string; domains: string[] }> }
export const hostingKey = (repo: string) => `hosting:${repo.toLowerCase()}`;
export const hostingVersionPrefix = (repo: string) => `hosting-version:${repo.toLowerCase()}:`;
export const hostingVersionKey = (repo: string, version: string) => `${hostingVersionPrefix(repo)}${version}`;
const legacyKey = (repo: string, account: string) => `hosting-legacy:${repo.toLowerCase()}:${account}`;

export async function setupConnection(env: Env, setup: DeploymentSetup): Promise<HostingConnection | null> {
  const connection = setup.credentialVersion
    ? await env.FDS_API_KV.get<HostingConnection>(hostingVersionKey(setup.repo, setup.credentialVersion), 'json')
    : await env.FDS_API_KV.get<HostingConnection>(legacyKey(setup.repo, setup.accountId), 'json') ?? await env.FDS_API_KV.get<HostingConnection>(hostingKey(setup.repo), 'json');
  return connection?.status === 'ready' && connection.repo.toLowerCase() === setup.repo.toLowerCase() && connection.accountId === setup.accountId && connection.version === setup.credentialVersion ? connection : null;
}

export async function cloudflareRequest<T>(token: string, path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  } catch { throw new ProvisioningError(503, 'Cloudflare did not answer. Retry the connection check.'); }
  if (response.status === 429) throw new ProvisioningError(503, 'Cloudflare’s request limit was reached. Wait before retrying.', retryDelay(response.headers));
  if (response.status >= 500) throw new ProvisioningError(503, 'Cloudflare is temporarily unavailable. Retry without replacing your token.');
  const data = await response.json().catch(() => null) as { success?: boolean; result?: T } | null;
  if (!response.ok || data?.success !== true || data.result === undefined) throw new ProvisioningError(403, 'Cloudflare denied access. Check the token, selected account, and Pages permissions.');
  return data.result;
}

export function validateHostingToken(token: string) {
  if (token.length < 20 || token.length > 512 || /\s/.test(token)) throw new ProvisioningError(400, 'Enter a complete Cloudflare API token without whitespace.');
}

export async function hostingAccounts(token: string) {
  validateHostingToken(token);
  const accounts: Account[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = await cloudflareRequest<Account[]>(token, `/accounts?per_page=50&page=${page}`);
    if (!Array.isArray(result) || result.some(account => !/^[a-f0-9]{32}$/.test(account.id) || typeof account.name !== 'string')) throw new ProvisioningError(502, 'Cloudflare returned an invalid account list.');
    accounts.push(...result);
    if (result.length < 50) return accounts;
  }
  throw new ProvisioningError(422, 'Limit the API token to the Cloudflare account you want to connect.');
}

export async function hostingProjects(token: string, accountId: string) {
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new ProvisioningError(400, 'Select a Cloudflare account.');
  const projects: Array<{ name: string; production_branch: string; domains: string[] }> = [];
  for (let page = 1; page <= 20; page++) {
    const result = await cloudflareRequest<Array<{ name: string; production_branch: string; domains: string[] }>>(token, `/accounts/${accountId}/pages/projects?per_page=100&page=${page}`);
    if (!Array.isArray(result)) throw new ProvisioningError(502, 'Cloudflare returned an invalid Pages project list.');
    projects.push(...result.map(project => ({ name: project.name, production_branch: project.production_branch, domains: project.domains ?? [] })));
    if (result.length < 100) return projects;
  }
  throw new ProvisioningError(422, 'This account has too many Pages projects to list safely. Narrow the account or retry with a dedicated publishing account.');
}

export async function connectHosting(env: Env, githubToken: string, input: { repo: string; token: string; accountId: string }) {
  const repo = await managedRepository(githubToken, input.repo);
  const accounts = await hostingAccounts(input.token);
  const account = accounts.find(account => account.id === input.accountId);
  if (!account) throw new ProvisioningError(403, 'The token cannot access the selected Cloudflare account.');
  const projects = await hostingProjects(input.token, account.id);
  const secrets = await repositorySecretNames(githubToken, repo.full_name);
  const version = crypto.randomUUID().replace(/-/g, '').toUpperCase();
  const names = credentialNames(version);
  if (secrets.has(names.account) || secrets.has(names.token)) throw new ProvisioningError(409, 'This credential version already exists. Retry staging to generate another version.');
  const previous = await env.FDS_API_KV.get<HostingConnection>(hostingKey(repo.full_name), 'json');
  if (previous?.status === 'ready' && !previous.version) {
    await env.FDS_API_KV.put(legacyKey(repo.full_name, previous.accountId), JSON.stringify(previous));
  }
  const connection: HostingConnection = { repo: repo.full_name, accountId: account.id, accountName: account.name, status: 'connecting', updatedAt: new Date().toISOString(), projects, version };
  const key = hostingVersionKey(repo.full_name, version);
  // Persist only the terminal outcome: version records are immutable, avoiding
  // rapid connecting/ready writes to the same Workers KV key.
  try {
    await writeRepositorySecrets(githubToken, repo.full_name, { [names.account]: account.id, [names.token]: input.token });
  } catch (error) {
    await env.FDS_API_KV.put(key, JSON.stringify({ ...connection, status: 'failed' }));
    throw new ProvisioningError(error instanceof ProvisioningError ? error.status : 502, 'Credential staging was incomplete. The active deployment was not changed. Check the app Secrets:write permission, then stage again. Failed attempts can be cleaned up separately.', error instanceof ProvisioningError ? error.retryAfterSeconds : undefined);
  }
  connection.status = 'ready';
  await env.FDS_API_KV.put(key, JSON.stringify(connection));
  await env.FDS_API_KV.put(hostingKey(repo.full_name), JSON.stringify(connection));
  return connection;
}
