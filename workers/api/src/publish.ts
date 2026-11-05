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
  if (!viewer.__ok || typeof viewer.login !== 'string') throw new Error(`GitHub identity lookup failed (${viewer.__status})`);
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
  if (created.__ok && typeof created.full_name === 'string' && typeof created.html_url === 'string' && created.private === false) {
    if (created.default_branch !== 'main') throw new Error('The new repository must use main as its default branch before publishing.');
    return { fullName: created.full_name, htmlUrl: created.html_url, created: true };
  }
  if (created.__status === 422) {
    const existing = await gh(`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.slug)}`, input.userToken);
    if (existing.__ok) {
      if (typeof existing.full_name !== 'string' || existing.full_name.toLowerCase() !== `${input.owner}/${input.slug}`.toLowerCase() || typeof existing.html_url !== 'string') throw new Error('Could not verify the existing repository identity.');
      if (existing.private !== false) throw new Error('An existing repository must be verified public before publishing. Use ProDocStore for private knowledge bases.');
      if (existing.permissions?.push !== true || existing.archived === true || existing.disabled === true) throw new Error('The repository must be writable and active before publishing.');
      if (existing.default_branch !== 'main') throw new Error('This publisher requires a main default branch. Set up other branches through the existing-repository workflow.');
      return { fullName: existing.full_name, htmlUrl: existing.html_url, created: false };
    }
  }
  throw new Error(`Repo create failed (${created.__status}): ${created.message ?? "unknown"}`);
}

async function commitFiles(repoFullName: string, files: PublishFile[], token: string): Promise<string> {
  const base = `https://api.github.com/repos/${repoFullName}`;
  let headSha: string | undefined;
  for (let attempt = 0; attempt < 5 && !headSha; attempt += 1) {
    const ref = await gh(`${base}/git/ref/heads/main`, token);
    if (ref.__status !== 404 && !ref.__ok) throw new Error(`Could not read main branch (${ref.__status}): ${ref.message ?? 'GitHub request failed'}`);
    headSha = ref.__ok ? ref?.object?.sha : undefined;
    if (!headSha && attempt < 4) await new Promise((resolve) => setTimeout(resolve, 700));
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

interface RegistryEntry {
  id: string;
  source: { repo: string };
  cloudflare?: { custom_domains?: string[]; production_url?: string };
  [key: string]: unknown;
}
interface Registry { knowledge_bases: RegistryEntry[]; [key: string]: unknown }

async function readRegistry(input: PublishInput) {
  const token = input.platformToken || input.userToken;
  const url = `https://api.github.com/repos/${input.org}/platform/contents/site/registry.json`;
  const current = await gh(url, token);
  if (!current.__ok || typeof current.content !== 'string' || typeof current.sha !== 'string') throw new Error(`Could not read registry (${current.__status}): ${current.message ?? 'invalid response'}`);
  const registry: Registry = JSON.parse(b64ToText(current.content));
  if (!registry || !Array.isArray(registry.knowledge_bases) || registry.knowledge_bases.some(entry => !entry || typeof entry.id !== 'string' || typeof entry.source?.repo !== 'string')) throw new Error('Registry data is invalid; publishing stopped without replacing it.');
  return { token, url, current, registry };
}

interface RegistryTarget { repo: string; branch: string; project: string; domains: string[] }

function registryTarget(input: PublishInput): RegistryTarget {
  return { repo: `${input.owner}/${input.slug}`, branch: 'main', project: input.slug, domains: [`${input.slug}.freedocstore.online`, ...(input.customDomain ? [input.customDomain] : [])] };
}

function assertRegistryOwnership(input: PublishInput, registry: Registry, target = registryTarget(input)) {
  const repo = target.repo.toLowerCase();
  const domains = new Set([...target.domains, `${target.project}.pages.dev`].map(domain => domain.toLowerCase()));
  const sameSlug = registry.knowledge_bases.filter(entry => entry.id.toLowerCase() === input.slug.toLowerCase());
  if (sameSlug.length > 1) throw new Error('Registry contains an ambiguous knowledge-base id. Resolve it before publishing.');
  for (const entry of registry.knowledge_bases) {
    if (entry.source.repo.toLowerCase() === repo) continue;
    if (entry.id.toLowerCase() === input.slug.toLowerCase()) throw new Error('This knowledge-base slug already belongs to another repository. Choose a different slug.');
    const registeredDomains = Array.isArray(entry.cloudflare?.custom_domains) ? entry.cloudflare.custom_domains : [];
    let host = '';
    try { host = new URL(entry.cloudflare?.production_url ?? '').hostname; } catch { /* no production URL */ }
    if ([host, ...registeredDomains].some(domain => typeof domain === 'string' && domains.has(domain.toLowerCase()))) throw new Error('This publishing domain already belongs to another knowledge base.');
  }
}

async function upsertRegistry(input: PublishInput, liveUrl: string, status: 'submitted' | 'failed' | 'published' = 'submitted', target = registryTarget(input)): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { token, url, current, registry } = await readRegistry(input);
    assertRegistryOwnership(input, registry, target);
    const entries = [...registry.knowledge_bases];
    const entry = {
      id: input.slug,
      title: input.title,
      description: (input.description ?? input.title).slice(0, 300),
      engine: 'zensical',
      source: { repo: target.repo, branch: target.branch, docs_dir: 'docs', config: 'zensical.toml' },
      cloudflare: { pages_project: target.project, production_url: liveUrl, custom_domains: target.domains },
      status,
    };
    const index = entries.findIndex(kb => kb.id.toLowerCase() === input.slug.toLowerCase());
    if (index >= 0 && JSON.stringify(entries[index]) === JSON.stringify(entry)) return 'already registered';
    if (index >= 0) entries[index] = entry;
    else entries.unshift(entry);
    const put = await gh(url, token, { method: 'PUT', body: {
      message: `registry: ${index >= 0 ? 'update' : 'add'} ${input.slug}`,
      content: textToB64(`${JSON.stringify({ ...registry, knowledge_bases: entries }, null, 2)}\n`),
      sha: current.sha,
    } });
    if (put.__ok) return index >= 0 ? 'registry entry updated' : 'registered in the public library';
    if (put.__status !== 409 || attempt === 2) throw new Error(`Registry commit failed (${put.__status}): ${put.message ?? 'unknown'}`);
    // Re-read after a conflict; preserve concurrent additions and re-check the
    // namespace owner before spending the platform credential on another write.
  }
  throw new Error('Could not update registry');
}

export async function publishKb(input: PublishInput): Promise<PublishResult> {
  const liveUrl = input.customDomain ? `https://${input.customDomain}/` : `https://${input.slug}.freedocstore.online/`;
  const steps: PublishStepResult[] = [];
  let repo = { fullName: `${input.owner}/${input.slug}`, htmlUrl: `https://github.com/${input.owner}/${input.slug}`, created: false };

  try {
    const { registry } = await readRegistry(input);
    assertRegistryOwnership(input, registry);
  } catch (error) {
    steps.push({ id: 'registry', ok: false, detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, repo: repo.fullName, repoUrl: repo.htmlUrl, liveUrl, steps };
  }

  try {
    repo = await ensureRepo(input);
    steps.push({ id: "repo", ok: true, detail: repo.created ? repo.htmlUrl : `${repo.htmlUrl} (already existed)` });
  } catch (error) {
    steps.push({ id: "repo", ok: false, detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, repo: repo.fullName, repoUrl: repo.htmlUrl, liveUrl, steps };
  }

  try {
    // Claim the public namespace with GitHub's SHA compare-and-swap before
    // committing a workflow that could deploy to that shared project name.
    const detail = await upsertRegistry(input, liveUrl);
    steps.push({ id: "registry", ok: true, detail });
  } catch (error) {
    steps.push({ id: "registry", ok: false, detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, repo: repo.fullName, repoUrl: repo.htmlUrl, liveUrl, steps };
  }

  try {
    const sha = await commitFiles(repo.fullName, input.files, input.userToken);
    steps.push({ id: "files", ok: true, detail: `${input.files.length} files at ${sha.slice(0, 7)}` });
  } catch (error) {
    steps.push({ id: "files", ok: false, detail: error instanceof Error ? error.message : String(error) });
    // Retain the verified repository's namespace for a safe retry, while
    // making the failed source submission visible in the public registry.
    try { await upsertRegistry(input, liveUrl, 'failed'); }
    catch { steps.push({ id: 'registry', ok: false, detail: 'Could not record the failed publication. Check repository status before retrying.' }); }
    return { ok: false, repo: repo.fullName, repoUrl: repo.htmlUrl, liveUrl, steps };
  }

  return { ok: true, repo: repo.fullName, repoUrl: repo.htmlUrl, liveUrl, steps };
}


/** Register only after deployment identity has been verified on the public site. */
export async function registerManagedKnowledgeBase(input: { repo: string; branch: string; project: string; domain: string; url: string; userToken: string; platformToken?: string; org: string }) {
  const [owner, name] = input.repo.split('/');
  const draft: PublishInput = { title: name, slug: `${owner}-${name}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 58).replace(/-$/, ''), owner, files: [], userToken: input.userToken, platformToken: input.platformToken, org: input.org };
  const { registry } = await readRegistry(draft);
  const existing = registry.knowledge_bases.find(entry => entry.source.repo.toLowerCase() === input.repo.toLowerCase());
  if (existing) {
    draft.slug = existing.id;
    if (typeof existing.title === 'string') draft.title = existing.title;
    if (typeof existing.description === 'string') draft.description = existing.description;
  }
  await upsertRegistry(draft, input.url, 'published', { repo: input.repo, branch: input.branch, project: input.project, domains: input.domain ? [input.domain] : [] });
  return draft.slug;
}

/** Mark the existing library entry unpublished while retaining its site and source. */
export async function unpublishManagedKnowledgeBase(input: { repo: string; userToken: string; platformToken?: string; org: string }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { token, url, current, registry } = await readRegistry({ title: '', slug: '', owner: '', files: [], userToken: input.userToken, platformToken: input.platformToken, org: input.org });
    const index = registry.knowledge_bases.findIndex(entry => entry.source.repo.toLowerCase() === input.repo.toLowerCase());
    if (index < 0 || registry.knowledge_bases[index].status === 'unpublished') return { updated: false };
    const entries = [...registry.knowledge_bases];
    entries[index] = { ...entries[index], status: 'unpublished' };
    const put = await gh(url, token, { method: 'PUT', body: { message: `registry: unpublish ${entries[index].id}`, content: textToB64(`${JSON.stringify({ ...registry, knowledge_bases: entries }, null, 2)}\n`), sha: current.sha } });
    if (put.__ok) return { updated: true };
    if (put.__status !== 409 || attempt === 2) throw new Error(`Registry update failed (${put.__status}): ${put.message ?? 'unknown'}`);
  }
  throw new Error('Could not update registry');
}
