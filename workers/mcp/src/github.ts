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
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) json.__status = res.status;
  return json;
}

function b64ToText(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function readRegistry(registryUrl: string): Promise<Registry> {
  const res = await fetch(registryUrl, {
    headers: { Accept: "application/json", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`registry fetch failed: ${res.status}`);
  return (await res.json()) as Registry;
}

export async function listRepoFiles(repoFullName: string, branch = "main"): Promise<RepoFile[]> {
  const base = `https://api.github.com/repos/${repoFullName}`;
  const ref = await gh(`${base}/git/ref/heads/${encodeURIComponent(branch)}`);
  const headSha = ref?.object?.sha;
  if (!headSha) return [];
  const tree = await gh(`${base}/git/trees/${headSha}?recursive=1`);
  if (!Array.isArray(tree?.tree)) return [];
  return tree.tree
    .filter((item: any) => item.type === "blob" || item.type === "tree")
    .map((item: any) => ({ path: item.path, type: item.type, size: item.size }));
}

export async function readRepoFile(repoFullName: string, path: string, branch = "main"): Promise<string | null> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${repoFullName}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  const res = await gh(url);
  if (typeof res?.content !== "string" || res.encoding !== "base64") return null;
  return b64ToText(res.content);
}

export async function getDeployStatus(repoFullName: string) {
  const res = await fetch(`https://api.github.com/repos/${repoFullName}/actions/runs?per_page=5`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28",
    },
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
}): Promise<UpdateResult> {
  const base = `https://api.github.com/repos/${input.repoFullName}`;
  const baseBranch = input.baseBranch ?? "main";
  const token = input.token;

  const ref = await gh(`${base}/git/ref/heads/${encodeURIComponent(baseBranch)}`, { token });
  const headSha = ref?.object?.sha;
  if (!headSha) return { ok: false, error: `Could not resolve ${baseBranch} on ${input.repoFullName} (${ref?.__status ?? "no ref"}): ${ref?.message ?? ""}` };

  const headCommit = await gh(`${base}/git/commits/${headSha}`, { token });
  const baseTreeSha = headCommit?.tree?.sha;
  if (!baseTreeSha) return { ok: false, error: `Could not read head commit tree: ${headCommit?.message ?? "unknown"}` };

  const treeItems: any[] = [];
  for (const file of input.files) {
    const blob = await gh(`${base}/git/blobs`, { token, method: "POST", body: { content: textToB64(file.content), encoding: "base64" } });
    if (!blob?.sha) return { ok: false, error: `Blob create failed for ${file.path}: ${blob?.message ?? "unknown"}` };
    treeItems.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (const path of input.deletePaths ?? []) {
    treeItems.push({ path, mode: "100644", type: "blob", sha: null });
  }

  const tree = await gh(`${base}/git/trees`, { token, method: "POST", body: { base_tree: baseTreeSha, tree: treeItems } });
  if (!tree?.sha) return { ok: false, error: `Tree create failed: ${tree?.message ?? "unknown"}` };

  const commit = await gh(`${base}/git/commits`, { token, method: "POST", body: { message: input.message, tree: tree.sha, parents: [headSha] } });
  if (!commit?.sha) return { ok: false, error: `Commit create failed: ${commit?.message ?? "unknown"}` };

  if (input.mode === "direct") {
    const updated = await gh(`${base}/git/refs/heads/${encodeURIComponent(baseBranch)}`, { token, method: "PATCH", body: { sha: commit.sha } });
    if (!updated?.object?.sha) return { ok: false, error: `Ref update failed: ${updated?.message ?? "unknown"}` };
    return { ok: true, branch: baseBranch, commitSha: commit.sha, commitUrl: commit.html_url };
  }

  const branch = `fds/mcp-${Date.now().toString(36)}`;
  const created = await gh(`${base}/git/refs`, { token, method: "POST", body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  if (!created?.object?.sha) return { ok: false, error: `Branch create failed: ${created?.message ?? "unknown"}` };

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
  if (!pr?.number) return { ok: false, error: `PR create failed: ${pr?.message ?? "unknown"} ${JSON.stringify(pr?.errors ?? [])}` };
  return { ok: true, branch, commitSha: commit.sha, commitUrl: commit.html_url, prNumber: pr.number, prUrl: pr.html_url };
}

