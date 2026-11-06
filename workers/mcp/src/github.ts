import { validRepo, validPath, validBranch, validSha } from "./validation.js";

const UA = "freedocstore-mcp";

export interface Registry {
  knowledge_bases?: KnowledgeBase[];
}

export interface KnowledgeBase {
  id: string;
  title: string;
  description?: string;
  engine: "zensical" | string;
  source: {
    repo: string;
    branch?: string;
    docs_dir?: string;
    config?: string;
  };
  cloudflare?: {
    pages_project?: string;
    production_url?: string;
    custom_domains?: string[];
  };
  status?: string;
}

export interface RepoFile {
  path: string;
  type: string;
  size?: number;
  sha?: string;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`GitHub API ${status}: ${message}`);
    this.name = "GitHubError";
  }
}

// 404 is a genuine "not found" and callers treat it as empty/null; every other
// failure (401/403 auth, 429 rate limit, 5xx) must surface as an error.
function throwIfFailed(res: any): void {
  if (res?.__status && res.__status !== 404) {
    throw new GitHubError(res.__status, res.message ?? res.raw ?? "request failed");
  }
}

async function gh(url: string, init?: { method?: string; token?: string; body?: unknown }): Promise<any> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": UA,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (init?.token) headers.Authorization = `Bearer ${init.token}`;
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!json || typeof json !== 'object') json = {};
  if (!res.ok) json.__status = res.status;
  return json;
}

function b64ToText(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  // Preserve a UTF-8 BOM for byte-faithful document moves. Reject malformed
  // UTF-8 rather than silently replacing bytes before a reviewed write.
  return new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(bytes);
}

export async function readRegistry(registryUrl: string): Promise<Registry> {
  const res = await fetch(registryUrl, {
    headers: { Accept: "application/json", "User-Agent": UA },
    redirect: "manual", signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`registry fetch failed: ${res.status}`);
  const data = await res.json() as Registry;
  if (!data || !Array.isArray(data.knowledge_bases) || data.knowledge_bases.some(kb => !kb || typeof kb.id !== 'string' || !kb.id || typeof kb.title !== 'string' || !kb.source || typeof kb.source.repo !== 'string' || !validRepo(kb.source.repo) || (kb.source.branch !== undefined && !validBranch(kb.source.branch)))) throw new Error('The public registry is invalid. Retry after its source records are repaired.');
  return data;
}

export async function publicRepository(repo: string, token?: string) {
  if (!validRepo(repo)) throw new Error('Use a repository in owner/name format.');
  const metadata = await gh(`https://api.github.com/repos/${repo}`, { token });
  if (metadata.__status) throw new GitHubError(metadata.__status, `${typeof metadata.message === 'string' ? metadata.message + '. ' : ''}Cannot access this public repository. Check its name and GitHub access.`);
  if (metadata.private !== false) throw new Error('FreeDocStore supports public repositories. Private knowledge bases belong in ProDocStore.');
  if (typeof metadata.full_name !== 'string' || !validRepo(metadata.full_name) || metadata.full_name.toLowerCase() !== repo.toLowerCase()) throw new Error('The repository identity changed. Resolve its current owner/name before continuing.');
  if (!validBranch(metadata.default_branch ?? '')) throw new Error('The repository needs an initialized default branch.');
  return { repo: metadata.full_name as string, branch: metadata.default_branch as string };
}

export async function repositoryHead(repo: string, branch: string, token?: string): Promise<string> {
  if (!validRepo(repo) || !validBranch(branch)) throw new Error('Invalid repository or branch.');
  const ref = await gh(`https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, { token });
  if (ref.__status) throw new GitHubError(ref.__status, `Cannot resolve branch ${branch}. Check repository access and the selected branch.`);
  if (!validSha(ref?.object?.sha)) throw new Error('GitHub returned an invalid source commit. Retry the source read.');
  return ref.object.sha;
}

export async function listRepoFiles(repoFullName: string, branch: string, commitSha?: string, token?: string): Promise<RepoFile[]> {
  if (!validRepo(repoFullName) || !validBranch(branch)) throw new Error('Invalid repository or branch.');
  const sha = commitSha ?? await repositoryHead(repoFullName, branch, token);
  if (!validSha(sha)) throw new Error('Invalid source commit.');
  const tree = await gh(`https://api.github.com/repos/${repoFullName}/git/trees/${sha}?recursive=1`, { token });
  if (tree.__status) throw new GitHubError(tree.__status, 'Could not read the source tree.');
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('GitHub did not return the complete source tree. Use read_file for specific paths.');
  return tree.tree.filter((item: any) => item.type === 'blob' || item.type === 'tree').map((item: any) => ({ path: item.path, type: item.type, size: item.size, sha: item.sha }));
}

export async function readRepoFile(repoFullName: string, path: string, ref: string, token?: string): Promise<{ content: string; sha: string } | null> {
  if (!validRepo(repoFullName) || !validPath(path) || (!validSha(ref) && !validBranch(ref))) throw new Error('Invalid repository, source path or ref.');
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const file = await gh(`https://api.github.com/repos/${repoFullName}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, { token });
  if (file.__status === 404) return null;
  throwIfFailed(file);
  if (file.type !== 'file' || !validSha(file.sha) || typeof file.content !== 'string' || file.encoding !== 'base64' || file.size > 512 * 1024) throw new Error('Cannot safely read this source. Select a text file no larger than 512 KiB.');
  return { content: b64ToText(file.content), sha: file.sha };
}

export async function getDeployStatus(repoFullName: string, branch?: string, token?: string) {
  if (!validRepo(repoFullName) || (branch !== undefined && !validBranch(branch))) throw new Error('Invalid repository or branch.');
  const res = await fetch(`https://api.github.com/repos/${repoFullName}/actions/runs?per_page=5${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "manual", signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { error: `GitHub API ${res.status}` };
  const data = (await res.json()) as {
    workflow_runs?: Array<{
      name: string;
      conclusion: string | null;
      status: string;
      updated_at: string;
      html_url: string;
      head_sha: string;
    }>;
  };
  return (data.workflow_runs ?? []).map((run) => ({
    name: run.name,
    status: run.conclusion ?? run.status,
    updatedAt: run.updated_at,
    url: run.html_url,
    sha: run.head_sha?.slice(0, 7),
  }));
}

export function findKnowledgeBase(registry: Registry, id: string): KnowledgeBase | undefined {
  return (registry.knowledge_bases ?? []).find((kb) => kb.id === id);
}

export interface FileChange {
  path: string;
  content: string;
}

export interface UpdateResult {
  ok: boolean;
  error?: string;
  errorCode?: "source_conflict" | "upstream_error";
  unchanged?: boolean;
  baseCommitSha?: string;
  branch?: string;
  commitSha?: string;
  commitUrl?: string;
  prNumber?: number;
  prUrl?: string;
}

function textToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

export async function updateRepoFiles(input: {
  token: string;
  repoFullName: string;
  message: string;
  files: FileChange[];
  deletePaths?: string[];
  baseBranch?: string;
  mode: "pr" | "direct";
  prTitle?: string;
  prBody?: string;
  expectedFiles: Record<string, string | null>;
  dryRun?: boolean;
}): Promise<UpdateResult> {
  validateChanges(input.files, input.deletePaths ?? [], input.expectedFiles);
  const repository = await publicRepository(input.repoFullName, input.token);
  const base = `https://api.github.com/repos/${repository.repo}`;
  const baseBranch = input.baseBranch ?? repository.branch;
  if (!validBranch(baseBranch)) throw new Error('Invalid base branch.');
  const token = input.token;

  const headSha = await repositoryHead(repository.repo, baseBranch, token);
  const headCommit = await gh(`${base}/git/commits/${headSha}`, { token });
  const baseTreeSha = headCommit?.tree?.sha;
  if (headCommit.__status || !validSha(baseTreeSha)) return { ok: false, errorCode: 'upstream_error', error: 'Could not read the source commit tree. Check access and retry.' };

  for (const [path, expected] of Object.entries(input.expectedFiles)) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const file = await gh(`${base}/contents/${encodedPath}?ref=${headSha}`, { token });
    if (file.__status === 404) {
      if (expected === null) continue;
      return sourceConflict(path);
    }
    if (file.__status || !validSha(file.sha)) return { ok: false, errorCode: 'upstream_error', error: `Could not inspect ${path}. Check GitHub access and retry.` };
    if (expected === null || file.type !== 'file' || file.sha !== expected) return sourceConflict(path);
  }

  if (input.dryRun) return { ok: true, branch: baseBranch, baseCommitSha: headSha };

  const treeItems: any[] = [];
  for (const file of input.files) {
    const blob = await gh(`${base}/git/blobs`, { token, method: "POST", body: { content: textToB64(file.content), encoding: "base64" } });
    if (blob.__status || !validSha(blob.sha)) return { ok: false, error: `Blob create failed for ${file.path}: ${blob?.message ?? "unknown"}` };
    treeItems.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (const path of input.deletePaths ?? []) {
    treeItems.push({ path, mode: "100644", type: "blob", sha: null });
  }

  const tree = await gh(`${base}/git/trees`, { token, method: "POST", body: { base_tree: baseTreeSha, tree: treeItems } });
  if (tree.__status || !validSha(tree.sha)) return { ok: false, error: `Tree create failed: ${tree?.message ?? "unknown"}` };

  if (await repositoryHead(repository.repo, baseBranch, token) !== headSha) return sourceConflict('base branch');

  // No-op: the new tree matches the base tree (re-saving identical content).
  // Return the current head instead of creating an empty commit / empty PR.
  if (tree.sha === baseTreeSha) return { ok: true, unchanged: true, baseCommitSha: headSha, branch: baseBranch, commitSha: headSha };

  const commit = await gh(`${base}/git/commits`, { token, method: "POST", body: { message: input.message, tree: tree.sha, parents: [headSha] } });
  if (commit.__status || !validSha(commit.sha)) return { ok: false, error: `Commit create failed: ${commit?.message ?? "unknown"}` };

  if (input.mode === "direct") {
    const updated = await gh(`${base}/git/refs/heads/${encodeURIComponent(baseBranch)}`, { token, method: "PATCH", body: { sha: commit.sha, force: false } });
    if (updated.__status === 409 || updated.__status === 422) return { ok: false, errorCode: 'source_conflict', error: 'GitHub rejected the branch update. Read the current source again and check branch protection; use PR mode when direct commits are restricted. No change was published.' };
    if (updated.__status || updated?.object?.sha !== commit.sha) return { ok: false, error: `Ref update failed: ${updated?.message ?? "unknown"}` };
    return { ok: true, baseCommitSha: headSha, branch: baseBranch, commitSha: commit.sha, commitUrl: commit.html_url };
  }

  if (await repositoryHead(repository.repo, baseBranch, token) !== headSha) return sourceConflict('base branch');
  const branch = `fds/mcp-${crypto.randomUUID()}`;
  const created = await gh(`${base}/git/refs`, { token, method: "POST", body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  if (created.__status || created?.object?.sha !== commit.sha) return { ok: false, error: `Branch create failed: ${created?.message ?? "unknown"}` };

  if (await repositoryHead(repository.repo, baseBranch, token) !== headSha) return { ...sourceConflict('base branch'), branch };
  const pr = await gh(`${base}/pulls`, {
    token,
    method: "POST",
    body: {
      title: input.prTitle ?? input.message,
      body: input.prBody ?? "Proposed through the FreeDocStore MCP server.",
      head: branch,
      base: baseBranch,
    },
  });
  if (pr.__status || !Number.isSafeInteger(pr.number) || pr.number <= 0 || typeof pr.html_url !== 'string' || !pr.html_url.startsWith('https://github.com/')) return { ok: false, branch, error: `PR create failed: ${pr?.message ?? "unknown"} ${JSON.stringify(pr?.errors ?? [])}` };
  return { ok: true, baseCommitSha: headSha, branch, commitSha: commit.sha, commitUrl: commit.html_url, prNumber: pr.number, prUrl: pr.html_url };
}


function sourceConflict(path: string): UpdateResult {
  return { ok: false, errorCode: 'source_conflict', error: `Source changed: ${path}. Read the current source again, review a fresh proposal and use its blob SHAs in expected_files. No change was published.` };
}

export function validateChanges(files: FileChange[], deletions: string[], expected: Record<string, string | null>) {
  const paths = [...files.map(file => file.path), ...deletions];
  if (!paths.length || paths.length > 50 || paths.some(path => !validPath(path)) || new Set(paths).size !== paths.length) throw new Error('Provide 1–50 distinct valid paths; a path cannot be both updated and deleted.');
  if (paths.some(path => paths.some(other => other !== path && other.startsWith(path + '/')))) throw new Error('A file change cannot also contain changes beneath that path.');
  if (!expected || Object.keys(expected).length !== paths.length || paths.some(path => !Object.hasOwn(expected, path) || (expected[path] !== null && !validSha(expected[path])))) throw new Error('Provide expected_files for every changed path: the blob SHA from read_file/list_files, or null for a file confirmed absent. Read the source and review the proposal again.');
  if (deletions.some(path => expected[path] === null)) throw new Error('Deleting a file requires its reviewed blob SHA, not a missing-file expectation.');
}
