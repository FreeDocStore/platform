import { publicRepository, readRegistry, repositoryHead, type KnowledgeBase } from '../github.js';
import { validBranch, validPath, validRepo } from '../validation.js';
import type { Env } from './helpers.js';

export interface RepositoryTarget {
  repo: string;
  branch: string;
  commitSha: string;
  kbId?: string;
  registryUnavailable?: boolean;
  source: { repo: string; branch: string; docs_dir: string; config: string };
}

/** Explicit owner/name + branch is self-contained, including during registry outages. */
export async function resolveTarget(env: Env, input: string, override?: string, token?: string): Promise<RepositoryTarget> {
  const explicit = input.includes('/');
  if (!input || (explicit ? !validRepo(input) : !/^[\w.-]{1,100}$/.test(input) || ['.', '..'].includes(input))) throw new Error('Use a registered KB id, repository short name, or owner/name.');
  if (override !== undefined && !validBranch(override)) throw new Error('Invalid branch override. Use a branch name, not a revision expression.');
  let kb: KnowledgeBase | undefined;
  let registryUnavailable = false;
  let records: KnowledgeBase[] = [];
  try { records = (await readRegistry(env.REGISTRY_URL)).knowledge_bases!; }
  catch {
    if (!explicit || override === undefined) throw new Error('The public registry could not be resolved. Retry, or provide an explicit owner/name and branch to select the target without the registry.');
    registryUnavailable = true;
  }
  const value = input.toLowerCase();
  let matches = records.filter(record => explicit ? record.source.repo.toLowerCase() === value : record.id.toLowerCase() === value || record.source.repo.split('/')[1].toLowerCase() === value);
  if (matches.length > 1 && explicit && override !== undefined) matches = matches.filter(record => record.source.branch === override);
  if (matches.length > 1) throw new Error('This name matches multiple registry records. Specify owner/name and branch explicitly; conflicting records for that exact target must be repaired in the registry.');
  kb = matches[0];
  const name = kb?.source.repo ?? (explicit ? input : `${env.GITHUB_ORG}/${input}`);
  const repository = await publicRepository(name, token);
  const branch = override ?? kb?.source.branch ?? repository.branch;
  const source = { repo: repository.repo, branch, docs_dir: kb?.source.docs_dir ?? 'docs', config: kb?.source.config ?? 'zensical.toml' };
  if (!validBranch(branch) || !validPath(source.docs_dir) || !validPath(source.config)) throw new Error('The registered source metadata is invalid. Repair it before continuing.');
  return { repo: repository.repo, branch, source, kbId: kb?.id, registryUnavailable, commitSha: await repositoryHead(repository.repo, branch, token) };
}

export function renderTarget(target: RepositoryTarget): string {
  return [
    `Repository: ${target.repo}`,
    `Branch: ${target.branch}`,
    `Source commit: ${target.commitSha}`,
    ...(target.kbId ? [`Knowledge base: ${target.kbId}`] : []),
    `Docs dir: ${target.source.docs_dir}`,
    `Config: ${target.source.config}`,
    ...(target.registryUnavailable ? ['Registry unavailable: explicit repository/branch selected; docs/config metadata uses platform defaults.'] : []),
  ].join('\n');
}
