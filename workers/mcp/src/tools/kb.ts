import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  findKnowledgeBase,
  getDeployStatus,
  listRepoFiles,
  readRegistry,
  readRepoFile,
} from "../github.js";
import {
  type Env,
  type McpProps,
  txt,
  toolError,
  renderKb,
  slugify,
} from "./helpers.js";

import { resolveTarget, renderTarget } from "./target.js";

interface Agent {
  server: McpServer;
  env: Env;
  props: McpProps;
}

/** Report a GitHub failure as tool text instead of passing it off as an empty result. */
async function withGitHub<T>(action: string, run: () => Promise<T>): Promise<T | ReturnType<typeof txt>> {
  try {
    return await run();
  } catch (err) {
    return toolError(`Error ${action}: ${err instanceof Error ? err.message : "Could not resolve the public source. Retry."}`);
  }
}

export function registerKbTools(agent: Agent) {
  agent.server.tool(
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
- update_files provides write-scoped MCP editing (PR proposals by default, direct commits on request) using the signed-in user's GitHub token
- not ready for broad self-serve until authenticated repo creation and custom-domain automation are finished

Editing flow (update_files):
1. read_file / list_files to load current content.
2. update_files with the changed Markdown. Default mode "pr" opens a reviewable pull request. Supply expected_files with reviewed blob versions (null for a confirmed missing file).
3. Merge the PR (or use mode "direct" to commit straight to the resolved publishing branch).
4. GitHub Actions rebuilds with Zensical and redeploys Cloudflare Pages automatically.

Recommended first flow:
1. User gives a topic/prompt.
2. Agent creates a Zensical repo plan with publish_plan.
3. Agent drafts Markdown content in docs/.
4. Repo builds with python3 -m zensical build --strict.
5. Cloudflare Pages publishes the repo.
6. Platform registry records repo, Pages project, production URL, and custom domains.
`),
  );

  agent.server.tool(
    "list_knowledge_bases",
    "List public FreeDocStore knowledge bases from the platform registry.",
    {},
    async () => {
      const registry = await readRegistry(agent.env.REGISTRY_URL);
      const kbs = registry.knowledge_bases ?? [];
      if (kbs.length === 0) return txt("No knowledge bases are registered yet.");
      return txt(`${kbs.length} knowledge base(s):\n\n${kbs.map(renderKb).join("\n\n---\n\n")}`);
    },
  );

  agent.server.tool(
    "knowledge_base_info",
    "Get repository, Zensical, Cloudflare, and domain metadata for one registered KB.",
    { id: z.string().describe("Knowledge base id, e.g. true-non-profit") },
    async ({ id }) => {
      const registry = await readRegistry(agent.env.REGISTRY_URL);
      const kb = findKnowledgeBase(registry, id);
      if (!kb) return txt(`No registered KB found for "${id}".`);
      return txt(renderKb(kb));
    },
  );

  agent.server.tool(
    "check_zensical_repo",
    "Validate that a public GitHub repo matches the FreeDocStore Zensical contract.",
    {
      repo: z.string().describe("Registered KB id, owner/name, or an unambiguous repository short name"),
      branch: z.string().optional().describe("Override the registered source branch or actual repository default"),
    },
    async ({ repo, branch }) => {
      return withGitHub(`checking ${repo}`, async () => {
        const target = await resolveTarget(agent.env, repo, branch, agent.props?.githubAccessToken);
        const fullRepo = target.repo;
        const files = await listRepoFiles(fullRepo, target.branch, target.commitSha, agent.props?.githubAccessToken);
        const docs = target.source.docs_dir;
        const paths = new Set(files.map((f) => f.path));
        const markdown = files.filter((f) => f.path.startsWith(`${docs}/`) && f.path.endsWith(".md")).map((f) => f.path);
        const checks = [
          [`${target.source.config} exists`, paths.has(target.source.config)],
          [`${docs}/index.md exists`, paths.has(`${docs}/index.md`)],
          [`${docs}/ contains Markdown`, markdown.length > 0],
          ["generated site/ is not committed", !files.some((f) => f.path === "site" || f.path.startsWith("site/"))],
          ["no embedded static HTML docs", !files.some((f) => f.path.startsWith(`${docs}/`) && f.path.endsWith(".html"))],
        ] as const;
        const passed = checks.filter(([, ok]) => ok).length;
        const lines = checks.map(([label, ok]) => `- ${ok ? "OK" : "FAIL"} ${label}`);
        return txt([
          renderTarget(target),
          `Zensical contract check for ${fullRepo}: ${passed}/${checks.length}`,
          "",
          lines.join("\n"),
          "",
          `Markdown pages: ${markdown.length ? markdown.join(", ") : "(none)"}`,
        ].join("\n"));
      });
    },
  );

  agent.server.tool(
    "list_files",
    "List files in a public KB repo.",
    {
      repo: z.string().describe("Registered KB id, owner/name, or an unambiguous repository short name"),
      branch: z.string().optional().describe("Override the registered source branch or actual repository default"),
    },
    async ({ repo, branch }) => {
      return withGitHub(`listing files in ${repo}`, async () => {
        const target = await resolveTarget(agent.env, repo, branch, agent.props?.githubAccessToken);
        const files = await listRepoFiles(target.repo, target.branch, target.commitSha, agent.props?.githubAccessToken);
        return txt(`${renderTarget(target)}

${files.length ? files.map(file => `- ${file.path} (${file.type}, blob/tree SHA: ${file.sha ?? 'unavailable'})`).join('\n') : 'No files at this source commit.'}`);
      });
    },
  );

  agent.server.tool(
    "read_file",
    "Read one source file from a public KB repo.",
    {
      repo: z.string().describe("Registered KB id, owner/name, or an unambiguous repository short name"),
      path: z.string().describe("File path, e.g. docs/index.md"),
      branch: z.string().optional().describe("Override the registered source branch or actual repository default"),
    },
    async ({ repo, path, branch }) => {
      return withGitHub(`reading ${path} from ${repo}`, async () => {
        const target = await resolveTarget(agent.env, repo, branch, agent.props?.githubAccessToken);
        const file = await readRepoFile(target.repo, path, target.commitSha, agent.props?.githubAccessToken);
        const baseline = JSON.stringify({ [path]: file?.sha ?? null });
        return txt(`${renderTarget(target)}
File: ${path}
Blob SHA: ${file?.sha ?? 'null (missing)'}
expected_files: ${baseline}

${file ? file.content : 'File is absent at this source commit. Use null only when creating it.'}`);
      });
    },
  );

  agent.server.tool(
    "deploy_status",
    "Check the last five GitHub Actions runs for a KB repo.",
    { repo: z.string().describe("Registered KB id, owner/name, or unambiguous repository short name"), branch: z.string().optional().describe("Override the registered source branch or repository default") },
    async ({ repo, branch }) => {
      return withGitHub(`checking deployments for ${repo}`, async () => {
        const target = await resolveTarget(agent.env, repo, branch, agent.props?.githubAccessToken);
        const runs = await getDeployStatus(target.repo, target.branch, agent.props?.githubAccessToken);
        if (!Array.isArray(runs)) return toolError(`Error: ${runs.error}`);
        const lines = runs.map(run => `- ${run.status} ${run.name} (${run.sha}) - ${run.updatedAt}\n  ${run.url}`);
        return txt(`${renderTarget(target)}

Deploy history:
${lines.length ? lines.join('\n') : 'No workflow runs found.'}`);
      });
    },
  );

  agent.server.tool(
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
      const domain = custom_domain ? `https://${custom_domain}/` : `https://${id}.${agent.env.DEFAULT_DOMAIN}/`;
      return txt(`# Publish Plan: ${title}

KB id: ${id}
Repo: https://github.com/${agent.env.GITHUB_ORG}/${id}
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
    "repo": "${agent.env.GITHUB_ORG}/${id}",
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
