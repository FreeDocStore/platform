import { ProvisioningError } from './lib/provisioning-http';
import { managedRepository } from './provisioning';
import { writeRepositorySecrets, repositorySecretNames } from './lib/repository-secrets';
import type { Env } from './types';

interface Account { id: string; name: string }
export interface HostingConnection { repo: string; accountId: string; accountName: string; status: 'connecting' | 'ready' | 'failed'; updatedAt: string; projects: Array<{ name: string; production_branch: string; domains: string[] }> }
export const hostingKey = (repo: string) => `hosting:${repo.toLowerCase()}`;

export async function cloudflareRequest<T>(token: string, path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  } catch { throw new ProvisioningError(503, 'Cloudflare did not answer. Retry the connection check.'); }
  if (response.status === 429 || response.status >= 500) throw new ProvisioningError(503, 'Cloudflare is temporarily unavailable. Retry without replacing your token.');
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

export async function connectHosting(env: Env, githubToken: string, input: { repo: string; token: string; accountId: string; confirmOverwrite: boolean }) {
  const repo = await managedRepository(githubToken, input.repo);
  const accounts = await hostingAccounts(input.token);
  const account = accounts.find(account => account.id === input.accountId);
  if (!account) throw new ProvisioningError(403, 'The token cannot access the selected Cloudflare account.');
  const projects = await hostingProjects(input.token, account.id);
  const secrets = await repositorySecretNames(githubToken, repo.full_name);
  if (['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].some(name => secrets.has(name)) && !input.confirmOverwrite) throw new ProvisioningError(409, 'This repository already has Cloudflare credentials. Confirm replacement after checking the selected account.');
  const connection: HostingConnection = { repo: repo.full_name, accountId: account.id, accountName: account.name, status: 'connecting', updatedAt: new Date().toISOString(), projects };
  await env.FDS_API_KV.put(hostingKey(repo.full_name), JSON.stringify(connection));
  try {
    await writeRepositorySecrets(githubToken, repo.full_name, { CLOUDFLARE_ACCOUNT_ID: account.id, CLOUDFLARE_API_TOKEN: input.token });
  } catch (error) {
    await env.FDS_API_KV.put(hostingKey(repo.full_name), JSON.stringify({ ...connection, status: 'failed' }));
    throw new ProvisioningError(error instanceof ProvisioningError ? error.status : 502, 'Cloudflare connection was not completed. Some repository secrets may have been written. Check the app Secrets:write permission, then reconnect before deploying.');
  }
  connection.status = 'ready';
  await env.FDS_API_KV.put(hostingKey(repo.full_name), JSON.stringify(connection));
  return connection;
}
