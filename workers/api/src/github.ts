/**
 * Git Data commit helper — write files to a KB repo as the signed-in user,
 * either as a direct commit to the base branch or a reviewable pull request.
 *
 * Vendored from the FreeDocStore MCP worker (workers/mcp/src/github.ts) so the
 * console's server-side edit path and the MCP `update_files` tool share one
 * commit implementation. Keep the two in sync when either changes.
 */

const UA = "freedocstore-api";

export interface FileChange {
  path: string;
  content: string;
}

export interface CommitResult {
  ok: boolean;
  error?: string;
  branch?: string;
  commitSha?: string;
  commitUrl?: string;
  prNumber?: number;
  prUrl?: string;
}

async function gh(url: string, init: { token: string; method?: string; body?: unknown }): Promise<any> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${init.token}`,
    "User-Agent": UA,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
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

function textToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

export async function commitFiles(input: {
  token: string;
  repoFullName: string;
  message: string;
  files: FileChange[];
  deletePaths?: string[];
  baseBranch?: string;
  mode: "pr" | "direct";
  prTitle?: string;
  prBody?: string;
}): Promise<CommitResult> {
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

  // No-op: the new tree matches the base tree (re-saving identical content).
  // Return the current head instead of creating an empty commit / empty PR.
  if (tree.sha === baseTreeSha) return { ok: true, branch: baseBranch, commitSha: headSha };

  const commit = await gh(`${base}/git/commits`, { token, method: "POST", body: { message: input.message, tree: tree.sha, parents: [headSha] } });
  if (!commit?.sha) return { ok: false, error: `Commit create failed: ${commit?.message ?? "unknown"}` };

  if (input.mode === "direct") {
    const updated = await gh(`${base}/git/refs/heads/${encodeURIComponent(baseBranch)}`, { token, method: "PATCH", body: { sha: commit.sha } });
    if (!updated?.object?.sha) return { ok: false, error: `Ref update failed: ${updated?.message ?? "unknown"}` };
    return { ok: true, branch: baseBranch, commitSha: commit.sha, commitUrl: commit.html_url };
  }

  const branch = `fds/edit-${branchSuffix()}`;
  const created = await gh(`${base}/git/refs`, { token, method: "POST", body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  if (!created?.object?.sha) return { ok: false, error: `Branch create failed: ${created?.message ?? "unknown"}` };

  const pr = await gh(`${base}/pulls`, {
    token,
    method: "POST",
    body: {
      title: input.prTitle ?? input.message,
      body: input.prBody ?? "Proposed through the FreeDocStore console.",
      head: branch,
      base: baseBranch,
    },
  });
  if (!pr?.number) return { ok: false, error: `PR create failed: ${pr?.message ?? "unknown"} ${JSON.stringify(pr?.errors ?? [])}` };
  return { ok: true, branch, commitSha: commit.sha, commitUrl: commit.html_url, prNumber: pr.number, prUrl: pr.html_url };
}

function branchSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
