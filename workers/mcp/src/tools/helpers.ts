import { type KnowledgeBase } from "../github.js";

export interface Env {
  PUBLIC_BASE_URL: string;
  REGISTRY_URL: string;
  GITHUB_ORG: string;
  PLATFORM_REPO: string;
  DEFAULT_DOMAIN: string;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  FDS_API_KV?: KVNamespace;
  GH_APP_CLIENT_ID?: string;
  GH_APP_CLIENT_SECRET?: string;
}

export const txt = (text: string) => ({ content: [{ type: "text" as const, text }] });

export interface McpProps extends Record<string, unknown> {
  userId?: string;
  provider?: string;
  login?: string;
  name?: string;
  avatarUrl?: string;
  githubUrl?: string;
  githubAccessToken?: string;
  scopes?: string[];
}

export interface WorkspaceDraft {
  id?: string;
  title?: string;
  slug?: string;
  owner?: string;
  customDomain?: string;
  visibility?: string;
  prompt?: string;
  liveUrl?: string;
  repoUrl?: string;
  lastStatus?: string;
  updatedAt?: string;
  files?: Array<{ path?: string }>;
  steps?: Array<{ id: string; label: string; detail: string; state: string }>;
  createdAt?: string;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function repoFromInput(env: Env, kbOrRepo: string): string {
  return kbOrRepo.includes("/") ? kbOrRepo : `${env.GITHUB_ORG}/${kbOrRepo}`;
}

export function renderKb(kb: KnowledgeBase): string {
  const domains = kb.cloudflare?.custom_domains?.length ? kb.cloudflare.custom_domains.join(", ") : "(none)";
  return [
    `**${kb.title}** (${kb.id})`,
    `Status: ${kb.status ?? "unknown"}`,
    `Engine: ${kb.engine}`,
    `Repo: https://github.com/${kb.source.repo}`,
    `Branch: ${kb.source.branch ?? "main"}`,
    `Docs dir: ${kb.source.docs_dir ?? "docs"}`,
    `Config: ${kb.source.config ?? "zensical.toml"}`,
    `Cloudflare project: ${kb.cloudflare?.pages_project ?? kb.id}`,
    `Production: ${kb.cloudflare?.production_url ?? `https://${kb.id}.pages.dev/`}`,
    `Custom domains: ${domains}`,
    kb.description ? `\n${kb.description}` : "",
  ].filter(Boolean).join("\n");
}

export function userKvKey(userId: string, key: string): string {
  return `user_kv:${userId}:${key}`;
}

export async function readWorkspace<T>(env: Env, userId: string | undefined, key: string): Promise<T | null> {
  if (!userId || !env.FDS_API_KV) return null;
  return env.FDS_API_KV.get<T>(userKvKey(userId, key), "json");
}

export function renderDraft(draft: WorkspaceDraft): string {
  const files = draft.files?.map((file) => file.path).filter(Boolean) ?? [];
  return [
    `**${draft.title ?? "Untitled KB"}** (${draft.id ?? draft.slug ?? "unknown"})`,
    `Status: ${draft.lastStatus ?? "Draft"}`,
    `Repo target: ${draft.owner ?? "FreeDocStore"}/${draft.slug ?? "unknown"}`,
    `Visibility: ${draft.visibility ?? "public"}`,
    `Repo URL: ${draft.repoUrl || "(not published)"}`,
    `Live URL: ${draft.liveUrl || (draft.slug ? `https://${draft.slug}.pages.dev/` : "(not set)")}`,
    `Custom domain: ${draft.customDomain || "(none)"}`,
    `Generated files: ${files.length ? files.join(", ") : "(none)"}`,
    `Updated: ${draft.updatedAt ?? "(unknown)"}`,
  ].join("\n");
}

export function requireRepoWrite(props: McpProps): string {
  if (!props?.userId) throw new Error("Not authenticated. Connect with GitHub OAuth first.");
  if (!props.scopes?.includes("write")) throw new Error("This MCP token does not include the write scope.");
  if (!props.githubAccessToken) {
    throw new Error("This MCP session has no GitHub repo access token. Reconnect (sign in with GitHub again) to grant the public_repo scope.");
  }
  return props.githubAccessToken;
}

export function requireWorkspaceWrite(env: Env, props: McpProps): string {
  if (!props?.userId) throw new Error("Not authenticated. Connect with GitHub OAuth first.");
  if (!props.scopes?.includes("write")) throw new Error("This MCP token does not include the write scope.");
  if (!env.FDS_API_KV) throw new Error("FDS_API_KV is not bound to the MCP worker.");
  return props.userId;
}

export function clonePublishSteps() {
  return [
    { id: "plan", label: "Create Zensical structure", detail: "Draft", state: "ok" },
    { id: "ai", label: "Generate Markdown files", detail: "Created by MCP sample tool", state: "ok" },
    { id: "repo", label: "Create GitHub repository", detail: "Not published yet", state: "idle" },
    { id: "files", label: "Commit Zensical source", detail: "Not published yet", state: "idle" },
    { id: "secrets", label: "Use stored Cloudflare deploy connection", detail: "Ready at platform level", state: "idle" },
    { id: "deploy", label: "GitHub Actions publishes to Cloudflare", detail: "Not started", state: "idle" },
  ];
}

export function sampleFiles(title: string, prompt: string, slug: string, customDomain = "") {
  const productionUrl = customDomain ? `https://${customDomain}/` : `https://${slug}.pages.dev/`;
  return [
    {
      path: "README.md",
      content: `# ${title}\n\nFreeDocStore sample knowledge base created through MCP.\n\n- Engine: Zensical\n- Source: docs/\n- Production target: ${productionUrl}\n`,
    },
    {
      path: "zensical.toml",
      content: [
        `title = "${title.replace(/"/g, '\\"')}"`,
        `base_url = "${productionUrl}"`,
        'content_dir = "docs"',
        'output_dir = "site"',
        "",
        "[navigation]",
        "items = [",
        '  { title = "Start", path = "index.md" },',
        '  { title = "Assessment", path = "assessment.md" }',
        "]",
      ].join("\n"),
    },
    {
      path: "docs/index.md",
      content: [`# ${title}`, "", prompt, "", "This draft was created through the FreeDocStore MCP server."].join("\n"),
    },
    {
      path: "docs/assessment.md",
      content: [
        "# Assessment",
        "",
        "Use this page to define the rubric, evidence sources, and maintenance process for this knowledge base.",
      ].join("\n"),
    },
  ];
}

export function makeWorkspaceDraft(input: {
  title: string;
  prompt: string;
  slug: string;
  owner: string;
  customDomain?: string;
  visibility?: string;
}): WorkspaceDraft {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: input.title,
    slug: input.slug,
    owner: input.owner,
    customDomain: input.customDomain ?? "",
    visibility: input.visibility ?? "public",
    prompt: input.prompt,
    files: sampleFiles(input.title, input.prompt, input.slug, input.customDomain),
    liveUrl: "",
    repoUrl: "",
    lastStatus: "Created via MCP",
    createdAt: now,
    updatedAt: now,
    steps: clonePublishSteps(),
  } as WorkspaceDraft;
}

export function nextDraftSlug(existing: WorkspaceDraft[], preferred: string): string {
  const base = slugify(preferred || "sample-knowledge-base") || "sample-knowledge-base";
  const used = new Set(existing.map((draft) => draft.slug).filter(Boolean));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
