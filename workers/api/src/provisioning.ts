import { parse as parseToml } from 'smol-toml';
import type { Env } from './types';
import { githubRequest as gh, ProvisioningError } from './lib/provisioning-http';
import { validBranch, validDomain, validPath, validRepo } from './lib/validation';
import { deployWorkflow } from '../../../templates/publishing/workflow';

export const SETUP_WORKFLOW = '.github/workflows/deploy.yml';
export interface Installation {
  id: number; app_id: number; app_slug: string; repository_selection?: string; suspended_at?: string | null;
  account: { login: string; type: string }; permissions: Record<string, string>;
}
export interface Repository { full_name: string; name: string; private: boolean; archived?: boolean; disabled?: boolean; default_branch: string; permissions?: { admin?: boolean; push?: boolean } }

export async function installations(token: string, env: Env) {
  if (!env.GH_APP_ID) throw new ProvisioningError(503, 'The FreeDocStore GitHub App is not configured for organization setup.');
  const all: Installation[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = await gh<{ installations: Installation[] }>(token, `/user/installations?per_page=100&page=${page}`);
    if (!Array.isArray(result?.installations)) throw new ProvisioningError(502, 'GitHub returned an invalid installation list.');
    all.push(...result.installations.filter(item => item.app_id === Number(env.GH_APP_ID) && !item.suspended_at));
    if (result.installations.length < 100) return all;
  }
  throw new ProvisioningError(422, 'Too many app installations to list. Narrow your GitHub App repository access and retry.');
}

export async function repositories(token: string, env: Env, installationId: number) {
  const installed = (await installations(token, env)).find(item => item.id === installationId);
  if (!installed) throw new ProvisioningError(403, 'This app installation is not accessible to your GitHub account. Refresh installations or ask an organization owner to grant access.');
  const repos: Repository[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = await gh<{ repositories: Repository[] }>(token, `/user/installations/${installationId}/repositories?per_page=100&page=${page}`);
    if (!Array.isArray(result?.repositories)) throw new ProvisioningError(502, 'GitHub returned an invalid repository list.');
    repos.push(...result.repositories.filter(repo => repo.private === false && !repo.archived && !repo.disabled && repo.full_name.split('/')[0].toLowerCase() === installed.account.login.toLowerCase()));
    if (result.repositories.length < 100) return { installation: installed, repositories: repos };
  }
  throw new ProvisioningError(422, 'Too many repositories to list. Select specific repositories in the GitHub App installation and retry.');
}

export async function managedRepository(token: string, name: string) {
  if (!validRepo(name)) throw new ProvisioningError(400, 'Choose a repository in owner/name format.');
  const repo = await gh<Repository>(token, `/repos/${name}`);
  if (!repo || repo.full_name?.toLowerCase() !== name.toLowerCase()) throw new ProvisioningError(409, 'This repository was renamed. Refresh and select its current name before continuing.');
  if (repo.private !== false) throw new ProvisioningError(403, 'FreeDocStore publishes public repositories. Private knowledge bases belong in ProDocStore.');
  if (repo.archived || repo.disabled || repo.permissions?.push !== true) throw new ProvisioningError(403, 'The selected GitHub account needs write access to this active repository.');
  if (!validBranch(repo.default_branch) || repo.default_branch.includes('${{')) throw new ProvisioningError(422, 'The repository needs a valid default branch before setup.');
  return repo;
}

export async function readSource(token: string, repo: string, path: string, ref: string) {
  const file = await gh<{ encoding: string; content: string; sha: string; size: number }>(token, `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, { missing: true });
  if (!file) return null;
  if (file.encoding !== 'base64' || typeof file.content !== 'string' || !/^[a-f0-9]{40}$/.test(file.sha) || file.size > 512 * 1024) throw new ProvisioningError(422, `Cannot safely review ${path}. It must be a text file no larger than 512 KiB.`);
  const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0));
  return { content: new TextDecoder().decode(bytes), sha: file.sha };
}

export function publishingTarget(project: string, domain: string) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(project)) throw new ProvisioningError(400, 'Pages project must use 1–58 lowercase letters, digits or hyphens.');
  if (domain && !validDomain(domain)) throw new ProvisioningError(400, 'Enter a valid custom hostname.');
  if (domain === 'freedocstore.online' || domain.endsWith('.freedocstore.online')) throw new ProvisioningError(400, 'Organization-owned hosting must use your own domain or the Pages URL.');
  return { project, domain, url: `https://${domain || `${project}.pages.dev`}/` };
}

export async function setupPlan(token: string, repoName: string, project: string, domain: string, credentialVersion: string, draftFiles: Array<{ path: string; content: string }> = [], title?: string, draftSlug?: string) {
  const target = publishingTarget(project, domain);
  const repo = await managedRepository(token, repoName);
  const branch = repo.default_branch;
  const head = await gh<{ object: { sha: string } }>(token, `/repos/${repo.full_name}/git/ref/heads/${encodeURIComponent(branch)}`, { missing: true });
  const sha = head?.object?.sha;
  if (!sha) throw new ProvisioningError(422, 'Initialize the repository with a README or template before setting it up.');
  const paths = [SETUP_WORKFLOW, 'zensical.toml', 'docs/index.md'];
  const existing = await Promise.all(paths.map(path => readSource(token, repo.full_name, path, sha)));
  const config = existing[1]?.content;
  if (!config) {
    const legacy = await Promise.all(['mkdocs.yml', 'mkdocs.yaml'].map(path => readSource(token, repo.full_name, path, sha)));
    if (legacy.some(Boolean)) throw new ProvisioningError(422, 'This repository has an existing MkDocs configuration. Review a Zensical configuration on GitHub before changing its publishing workflow.');
  }
  if (config) {
    let projectConfig: Record<string, unknown>;
    try {
      const parsed = parseToml(config);
      if (!parsed.project || typeof parsed.project !== 'object' || Array.isArray(parsed.project)) throw new Error('missing project');
      projectConfig = parsed.project as Record<string, unknown>;
    } catch { throw new ProvisioningError(422, 'Review the existing Zensical configuration on GitHub. It must be valid TOML with a [project] section.'); }
    if ((projectConfig.docs_dir ?? 'docs') !== 'docs' || (projectConfig.site_dir ?? 'site') !== 'site') throw new ProvisioningError(422, 'This setup supports docs/ source and site/ output. Review the existing folder configuration on GitHub first.');
  }
  const generated: Record<string, string> = {
    [SETUP_WORKFLOW]: deployWorkflow(project, domain, { branch, managed: true, credentialVersion }),
    'zensical.toml': `[project]\nsite_name = ${JSON.stringify(title?.slice(0, 120) || repo.name)}\nsite_url = ${JSON.stringify(target.url)}\nrepo_url = ${JSON.stringify(`https://github.com/${repo.full_name}`)}\ndocs_dir = "docs"\nsite_dir = "site"\n`,
    'docs/index.md': `# ${repo.name}\n\nWelcome to your public knowledge base. Propose content changes through FreeDocStore or edit this page on GitHub.\n`,
  };
  const requestedDraftPaths = new Set(draftFiles.map(file => file.path));
  const files = paths.flatMap((path, index) => {
    // Existing source/configuration belongs to the customer. Only the reviewed
    // deployment workflow is replaced; scaffolding fills absent files only.
    if (path === 'docs/index.md' && requestedDraftPaths.has(path)) return [];
    if (existing[index] && path !== SETUP_WORKFLOW) return [];
    if (existing[index]?.content === generated[path]) return [];
    return [{ path, content: generated[path], before: existing[index]?.content ?? '', expectedSha: existing[index]?.sha ?? null }];
  });
  if (draftFiles.length > 100) throw new ProvisioningError(413, 'A setup draft can contain at most 100 files.');
  const draftPaths = new Set<string>();
  let draftBytes = 0;
  for (const file of draftFiles) {
    draftBytes += new TextEncoder().encode(file.content).byteLength;
    if (!validPath(file.path) || !file.path.startsWith('docs/') || !/\.md$/.test(file.path) || file.path === 'docs/zensical.toml' || file.path === SETUP_WORKFLOW || draftPaths.has(file.path)) throw new ProvisioningError(400, `Invalid or duplicate draft path: ${file.path}`);
    if (draftBytes > 1_500_000 || new TextEncoder().encode(file.content).byteLength > 256_000) throw new ProvisioningError(413, 'Draft files are limited to 256 KiB each and 1.5 MiB total.');
    draftPaths.add(file.path);
    const current = await readSource(token, repo.full_name, file.path, sha);
    if (current?.content === file.content) continue;
    files.push({ path: file.path, content: file.content, before: current?.content ?? '', expectedSha: current?.sha ?? null });
  }
  return { repo: repo.full_name, branch, headSha: sha, project, domain, url: target.url, workflow: generated[SETUP_WORKFLOW], files, draftTitle: title ?? '', draftSlug: draftSlug ?? '', hasDraftChanges: files.some(file => draftPaths.has(file.path)),
    replacesWorkflow: Boolean(existing[0] && files.some(file => file.path === SETUP_WORKFLOW)),
    warning: config ? 'Existing Zensical configuration is preserved. Check its canonical site_url against the selected hosting address.' : null };
}
