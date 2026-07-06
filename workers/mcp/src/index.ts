import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthHandler } from "./auth-handler.js";
import {
  findKnowledgeBase,
  getDeployStatus,
  listRepoFiles,
  readRegistry,
  readRepoFile,
  type KnowledgeBase,
} from "./github.js";

interface Env {
  PUBLIC_BASE_URL: string;
  REGISTRY_URL: string;
  GITHUB_ORG: string;
  PLATFORM_REPO: string;
  DEFAULT_DOMAIN: string;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

const txt = (text: string) => ({ content: [{ type: "text" as const, text }] });

interface McpProps extends Record<string, unknown> {
  userId?: string;
  provider?: string;
  login?: string;
  name?: string;
  avatarUrl?: string;
  githubUrl?: string;
  scopes?: string[];
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function repoFromInput(env: Env, kbOrRepo: string): string {
  return kbOrRepo.includes("/") ? kbOrRepo : `${env.GITHUB_ORG}/${kbOrRepo}`;
}

function renderKb(kb: KnowledgeBase): string {
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

export class FreeDocStoreMcp extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({
    name: "FreeDocStore",
    version: "0.2.0",
  });

  declare props: McpProps;

  async init() {
    this.server.tool(
      "whoami",
      "Show the authenticated FreeDocStore MCP account.",
      {},
      async () => txt(JSON.stringify({
        authenticated: Boolean(this.props?.userId),
        userId: this.props?.userId ?? null,
        provider: this.props?.provider ?? null,
        login: this.props?.login ?? null,
        name: this.props?.name ?? null,
        githubUrl: this.props?.githubUrl ?? null,
        scopes: this.props?.scopes ?? [],
      }, null, 2)),
    );

    this.server.tool(
      "platform_guide",
      "Read the FreeDocStore publishing contract and current launch constraints.",
      {},
      async () => txt(`# FreeDocStore Platform Guide

FreeDocStore publishes knowledge bases from GitHub repositories using Zensical only.

Current contract:
- one GitHub repo per KB
- Markdown source lives in docs/
- zensical.toml config at repo root
- Zensical builds to site/
- each KB has its own Cloudflare Pages project
- each KB can attach custom domains
- the platform repo stores registry metadata only
- no embedded static HTML KB folders in the platform repo

Invite readiness:
- ready for design partners who are comfortable with GitHub-backed repos and reviewable AI proposals
- not ready for broad self-serve until authenticated repo creation, custom-domain automation, and write-scoped MCP tools are finished

Recommended first flow:
1. User gives a topic/prompt.
2. Agent creates a Zensical repo plan with publish_plan.
3. Agent drafts Markdown content in docs/.
4. Repo builds with python3 -m zensical build --strict.
5. Cloudflare Pages publishes the repo.
6. Platform registry records repo, Pages project, production URL, and custom domains.
`),
    );

    this.server.tool(
      "list_knowledge_bases",
      "List public FreeDocStore knowledge bases from the platform registry.",
      {},
      async () => {
        const registry = await readRegistry(this.env.REGISTRY_URL);
        const kbs = registry.knowledge_bases ?? [];
        if (kbs.length === 0) return txt("No knowledge bases are registered yet.");
        return txt(`${kbs.length} knowledge base(s):\n\n${kbs.map(renderKb).join("\n\n---\n\n")}`);
      },
    );

    this.server.tool(
      "knowledge_base_info",
      "Get repository, Zensical, Cloudflare, and domain metadata for one registered KB.",
      { id: z.string().describe("Knowledge base id, e.g. true-non-profit") },
      async ({ id }) => {
        const registry = await readRegistry(this.env.REGISTRY_URL);
        const kb = findKnowledgeBase(registry, id);
        if (!kb) return txt(`No registered KB found for "${id}".`);
        return txt(renderKb(kb));
      },
    );

    this.server.tool(
      "check_zensical_repo",
      "Validate that a public GitHub repo matches the FreeDocStore Zensical contract.",
      {
        repo: z.string().describe("Repo as owner/name, or just name under the FreeDocStore org"),
        branch: z.string().optional().describe("Branch to inspect, default main"),
      },
      async ({ repo, branch }) => {
        const fullRepo = repoFromInput(this.env, repo);
        const files = await listRepoFiles(fullRepo, branch ?? "main");
        if (files.length === 0) return txt(`Could not read ${fullRepo}, or it has no files on ${branch ?? "main"}.`);
        const paths = new Set(files.map((f) => f.path));
        const markdown = files.filter((f) => f.path.startsWith("docs/") && f.path.endsWith(".md")).map((f) => f.path);
        const checks = [
          ["zensical.toml at repo root", paths.has("zensical.toml")],
          ["docs/index.md exists", paths.has("docs/index.md")],
          ["docs/ contains Markdown", markdown.length > 0],
          ["generated site/ is not committed", !files.some((f) => f.path === "site" || f.path.startsWith("site/"))],
          ["no embedded static HTML docs", !files.some((f) => f.path.startsWith("docs/") && f.path.endsWith(".html"))],
        ] as const;
        const passed = checks.filter(([, ok]) => ok).length;
        const lines = checks.map(([label, ok]) => `- ${ok ? "OK" : "FAIL"} ${label}`);
        return txt([
          `Zensical contract check for ${fullRepo}: ${passed}/${checks.length}`,
          "",
          lines.join("\n"),
          "",
          `Markdown pages: ${markdown.length ? markdown.join(", ") : "(none)"}`,
        ].join("\n"));
      },
    );

    this.server.tool(
      "list_files",
      "List files in a public KB repo.",
      {
        repo: z.string().describe("Repo as owner/name, or just name under the FreeDocStore org"),
        branch: z.string().optional().describe("Branch to inspect, default main"),
      },
      async ({ repo, branch }) => {
        const fullRepo = repoFromInput(this.env, repo);
        const files = await listRepoFiles(fullRepo, branch ?? "main");
        if (files.length === 0) return txt(`No files found for ${fullRepo}.`);
        return txt(`Files in ${fullRepo}:\n\n${files.map((f) => `- ${f.path}`).join("\n")}`);
      },
    );

    this.server.tool(
      "read_file",
      "Read one source file from a public KB repo.",
      {
        repo: z.string().describe("Repo as owner/name, or just name under the FreeDocStore org"),
        path: z.string().describe("File path, e.g. docs/index.md"),
        branch: z.string().optional().describe("Branch to inspect, default main"),
      },
      async ({ repo, path, branch }) => {
        const fullRepo = repoFromInput(this.env, repo);
        const content = await readRepoFile(fullRepo, path, branch ?? "main");
        if (content === null) return txt(`Could not read ${path} from ${fullRepo}.`);
        return txt(`File: ${fullRepo}/${path}\n\n\`\`\`\n${content}\n\`\`\``);
      },
    );

    this.server.tool(
      "deploy_status",
      "Check the last five GitHub Actions runs for a KB repo.",
      { repo: z.string().describe("Repo as owner/name, registered KB id, or repo name under FreeDocStore") },
      async ({ repo }) => {
        let fullRepo = repoFromInput(this.env, repo);
        const registry = await readRegistry(this.env.REGISTRY_URL);
        const kb = findKnowledgeBase(registry, repo);
        if (kb) fullRepo = kb.source.repo;
        const runs = await getDeployStatus(fullRepo);
        if (!Array.isArray(runs)) return txt(`Error: ${runs.error}`);
        if (runs.length === 0) return txt(`No workflow runs found for ${fullRepo}.`);
        const lines = runs.map((run) => `- ${run.status} ${run.name} (${run.sha}) - ${run.updatedAt}\n  ${run.url}`);
        return txt(`Deploy history for ${fullRepo}:\n\n${lines.join("\n")}`);
      },
    );

    this.server.tool(
      "publish_plan",
      "Turn a knowledge-base topic/prompt into the concrete FreeDocStore repo, Zensical, Cloudflare, and custom-domain plan. This does not create resources yet.",
      {
        title: z.string().describe("Knowledge base title"),
        prompt: z.string().describe("What the KB should cover"),
        slug: z.string().optional().describe("Preferred repo/project slug"),
        custom_domain: z.string().optional().describe("Optional custom domain for this KB"),
      },
      async ({ title, prompt, slug, custom_domain }) => {
        const id = slugify(slug ?? title);
        const domain = custom_domain ? `https://${custom_domain}/` : `https://${id}.${this.env.DEFAULT_DOMAIN}/`;
        return txt(`# Publish Plan: ${title}

KB id: ${id}
Repo: https://github.com/${this.env.GITHUB_ORG}/${id}
Engine: Zensical
Source: docs/
Config: zensical.toml
Build command: python3 -m pip install zensical && python3 -m zensical build --strict
Build output: site/
Cloudflare Pages project: ${id}
Production URL: ${domain}
Custom domain: ${custom_domain ?? "(none yet)"}

Required repo files:
- README.md
- zensical.toml
- .gitignore
- .github/workflows/deploy.yml
- docs/index.md
- docs/<topic-pages>.md

Suggested first pages:
- docs/index.md - overview, audience, scope
- docs/first-principles.md - first-principles model
- docs/assessment-method.md - how to evaluate evidence
- docs/register.md - public register or index

Prompt to turn into Markdown:
${prompt}

Registry record:
\`\`\`json
{
  "id": "${id}",
  "title": "${title}",
  "description": "${prompt.slice(0, 180).replace(/"/g, '\\"')}",
  "engine": "zensical",
  "source": {
    "repo": "${this.env.GITHUB_ORG}/${id}",
    "branch": "main",
    "docs_dir": "docs",
    "config": "zensical.toml"
  },
  "cloudflare": {
    "pages_project": "${id}",
    "production_url": "${domain}",
    "custom_domains": ${custom_domain ? `["${custom_domain}"]` : "[]"}
  },
  "status": "draft-0.1"
}
\`\`\`
`);
      },
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        [
          "FreeDocStore MCP Server",
          "",
          "Connect: npx mcp-remote https://mcp.freedocstore.online/mcp",
          "",
          "Zensical-only knowledge base publishing:",
          "- one GitHub repo per KB",
          "- Markdown in docs/",
          "- zensical.toml at repo root",
          "- Cloudflare Pages project per KB",
          "- custom domains per KB",
          "",
          "Tools: whoami, platform_guide, list_knowledge_bases, knowledge_base_info, check_zensical_repo, list_files, read_file, deploy_status, publish_plan",
          "",
          "Auth: OAuth 2.1 via GitHub sign-in when connected through mcp-remote or Claude.",
        ].join("\n"),
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    return oauthProvider.fetch(request, env, ctx);
  },
};

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: FreeDocStoreMcp.serve("/mcp"),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["read", "write"],
  accessTokenTTL: 86_400,
});
