const UA = "freedocstore-api";

export interface PublishFile {
  path: string;
  content: string;
}

export interface PublishInput {
  title: string;
  slug: string;
  owner: string;
  customDomain?: string;
  description?: string;
  files: PublishFile[];
  userToken: string;
  platformToken?: string;
  org: string;
}

export interface PublishStepResult {
  id: "repo" | "files" | "registry";
  ok: boolean;
  detail: string;
}

export interface PublishResult {
  ok: boolean;
  repo: string;
  repoUrl: string;
  liveUrl: string;
  steps: PublishStepResult[];
}

async function gh(url: string, token: string, init?: { method?: string; body?: unknown }): Promise<any> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  json.__status = res.status;
  json.__ok = res.ok;
  return json;
}

function textToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function b64ToText(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function ensureRepo(input: PublishInput): Promise<{ fullName: string; htmlUrl: string; created: boolean }> {
  const viewer = await gh("https://api.github.com/user", input.userToken);
  const isUser = typeof viewer.login === "string" && viewer.login.toLowerCase() === input.owner.toLowerCase();
  const createUrl = isUser
    ? "https://api.github.com/user/repos"
    : `https://api.github.com/orgs/${encodeURIComponent(input.owner)}/repos`;
  const created = await gh(createUrl, input.userToken, {
    method: "POST",
    body: {
      name: input.slug,
      description: `${input.title} - FreeDocStore Zensical knowledge base`,
      private: false,
      auto_init: true,
      homepage: input.customDomain ? `https://${input.customDomain}/` : `https://${input.slug}.pages.dev/`,
    },
  });
  if (created.__ok) return { fullName: created.full_name, htmlUrl: created.html_url, created: true };
  if (created.__status === 422) {
    const existing = await gh(`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.slug)}`, input.userToken);
    if (existing.__ok) return { fullName: existing.full_name, htmlUrl: existing.html_url, created: false };
  }
  throw new Error(`Repo create failed (${created.__status}): ${created.message ?? "unknown"}`);
}

async function commitFiles(repoFullName: string, files: PublishFile[], token: string): Promise<string> {
  const base = `https://api.github.com/repos/${repoFullName}`;
  let headSha: string | undefined;
  for (let attempt = 0; attempt < 5 && !headSha; attempt += 1) {
    const ref = await gh(`${base}/git/ref/heads/main`, token);
    headSha = ref?.object?.sha;
    if (!headSha) await new Promise((resolve) => setTimeout(resolve, 700));
  }
  if (!headSha) throw new Error("main branch did not appear after repo creation");

  const headCommit = await gh(`${base}/git/commits/${headSha}`, token);
  if (!headCommit?.tree?.sha) throw new Error(`Could not read head commit: ${headCommit.message ?? "unknown"}`);

  const treeItems = [];
  for (const file of files) {
    const blob = await gh(`${base}/git/blobs`, token, {
      method: "POST",
      body: { content: textToB64(file.content), encoding: "base64" },
    });
    if (!blob.sha) throw new Error(`Blob create failed for ${file.path}: ${blob.message ?? "unknown"}`);
    treeItems.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const tree = await gh(`${base}/git/trees`, token, { method: "POST", body: { base_tree: headCommit.tree.sha, tree: treeItems } });
  if (!tree.sha) throw new Error(`Tree create failed: ${tree.message ?? "unknown"}`);
  if (tree.sha === headCommit.tree.sha) return headSha;

  const commit = await gh(`${base}/git/commits`, token, {
    method: "POST",
    body: { message: "Publish Zensical source via FreeDocStore", tree: tree.sha, parents: [headSha] },
  });
  if (!commit.sha) throw new Error(`Commit create failed: ${commit.message ?? "unknown"}`);
  const updated = await gh(`${base}/git/refs/heads/main`, token, { method: "PATCH", body: { sha: commit.sha } });
  if (!updated?.object?.sha) throw new Error(`Ref update failed: ${updated.message ?? "unknown"}`);
  return commit.sha;
}

async function upsertRegistry(input: PublishInput, liveUrl: string): Promise<string> {
  const token = input.platformToken || input.userToken;
  const registryRepo = `${input.org}/platform`;
  const url = `https://api.github.com/repos/${registryRepo}/contents/site/registry.json`;
  const current = await gh(url, token);
  if (!current.__ok || typeof current.content !== "string") {
    throw new Error(`Could not read registry (${current.__status}): ${current.message ?? "unknown"}`);
  }
  const registry = JSON.parse(b64ToText(current.content)) as { knowledge_bases?: any[] };
  const entries = registry.knowledge_bases ?? [];
  const defaultDomain = `${input.slug}.freedocstore.online`;
  const domains = [defaultDomain, ...(input.customDomain ? [input.customDomain] : [])];
  const entry = {
    id: input.slug,
    title: input.title,
    description: (input.description ?? input.title).slice(0, 300),
    engine: "zensical",
    source: { repo: `${input.owner}/${input.slug}`, branch: "main", docs_dir: "docs", config: "zensical.toml" },
    cloudflare: {
      pages_project: input.slug,
      production_url: liveUrl,
      custom_domains: domains,
    },
    status: "published",
  };
  const index = entries.findIndex((kb) => kb?.id === input.slug);
  if (index >= 0 && JSON.stringify(entries[index]) === JSON.stringify(entry)) return "already registered";
  if (index >= 0) entries[index] = entry;
  else entries.unshift(entry);
  const body = `${JSON.stringify({ knowledge_bases: entries }, null, 2)}\n`;
  const put = await gh(url, token, {
    method: "PUT",
    body: {
      message: `registry: ${index >= 0 ? "update" : "add"} ${input.slug}`,
      content: textToB64(body),
      sha: current.sha,
    },
  });
  if (!put.__ok) throw new Error(`Registry commit failed (${put.__status}): ${put.message ?? "unknown"}`);
  return index >= 0 ? "registry entry updated" : "registered in the public library";
}

export async function publishKb(input: PublishInput): Promise<PublishResult> {
  const liveUrl = input.customDomain ? `https://${input.customDomain}/` : `https://${input.slug}.freedocstore.online/`;
  const steps: PublishStepResult[] = [];
  let repo = { fullName: `${input.owner}/${input.slug}`, htmlUrl: `https://github.com/${input.owner}/${input.slug}`, created: false };

  try {
    repo = await ensureRepo(input);
    steps.push({ id: "repo", ok: true, detail: repo.created ? repo.htmlUrl : `${repo.htmlUrl} (already existed)` });
  } catch (error) {
    steps.push({ id: "repo", ok: false, detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, repo: repo.fullName, repoUrl: repo.htmlUrl, liveUrl, steps };
  }

  try {
    const sha = await commitFiles(repo.fullName, input.files, input.userToken);
    steps.push({ id: "files", ok: true, detail: `${input.files.length} files at ${sha.slice(0, 7)}` });
  } catch (error) {
    steps.push({ id: "files", ok: false, detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, repo: repo.fullName, repoUrl: repo.htmlUrl, liveUrl, steps };
  }

  try {
    const detail = await upsertRegistry(input, liveUrl);
    steps.push({ id: "registry", ok: true, detail });
  } catch (error) {
    steps.push({ id: "registry", ok: false, detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, repo: repo.fullName, repoUrl: repo.htmlUrl, liveUrl, steps };
  }

  return { ok: true, repo: repo.fullName, repoUrl: repo.htmlUrl, liveUrl, steps };
}
