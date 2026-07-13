import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type Env,
  type McpProps,
  type WorkspaceDraft,
  txt,
  readWorkspace,
  renderDraft,
  requireWorkspaceWrite,
  makeWorkspaceDraft,
  nextDraftSlug,
  userKvKey,
} from "./helpers.js";

interface Agent {
  server: McpServer;
  env: Env;
  props: McpProps;
}

export function registerAccountTools(agent: Agent) {
  agent.server.tool(
    "whoami",
    "Show the authenticated FreeDocStore MCP account.",
    {},
    async () => txt(JSON.stringify({
      authenticated: Boolean(agent.props?.userId),
      userId: agent.props?.userId ?? null,
      provider: agent.props?.provider ?? null,
      login: agent.props?.login ?? null,
      name: agent.props?.name ?? null,
      githubUrl: agent.props?.githubUrl ?? null,
      scopes: agent.props?.scopes ?? [],
    }, null, 2)),
  );

  agent.server.tool(
    "workspace_summary",
    "Show the signed-in FreeDocStore console workspace stored for this account.",
    {},
    async () => {
      if (!agent.props?.userId) return txt("Not authenticated. Connect with GitHub OAuth first.");
      if (!agent.env.FDS_API_KV) return txt("FDS_API_KV is not bound to the MCP worker.");
      const [settings, drafts, activeId] = await Promise.all([
        readWorkspace<Record<string, unknown>>(agent.env, agent.props.userId, "fds:config:v1"),
        readWorkspace<WorkspaceDraft[]>(agent.env, agent.props.userId, "fds:kbs:v1"),
        readWorkspace<string>(agent.env, agent.props.userId, "fds:active-kb:v1"),
      ]);
      const list = Array.isArray(drafts) ? drafts : [];
      const active = list.find((draft) => draft.id === activeId) ?? list[0];
      return txt(JSON.stringify({
        authenticated: true,
        user: {
          userId: agent.props.userId,
          login: agent.props.login,
          name: agent.props.name,
          provider: agent.props.provider,
        },
        workspace: {
          draftCount: list.length,
          activeKnowledgeBase: active ? {
            id: active.id,
            title: active.title,
            slug: active.slug,
            owner: active.owner,
            status: active.lastStatus,
            repoUrl: active.repoUrl || null,
            liveUrl: active.liveUrl || null,
            customDomain: active.customDomain || null,
            generatedFileCount: active.files?.length ?? 0,
          } : null,
          settings: settings ?? null,
        },
      }, null, 2));
    },
  );

  agent.server.tool(
    "list_workspace_drafts",
    "List KB drafts saved in the signed-in FreeDocStore console workspace.",
    {},
    async () => {
      if (!agent.props?.userId) return txt("Not authenticated. Connect with GitHub OAuth first.");
      if (!agent.env.FDS_API_KV) return txt("FDS_API_KV is not bound to the MCP worker.");
      const drafts = await readWorkspace<WorkspaceDraft[]>(agent.env, agent.props.userId, "fds:kbs:v1");
      const list = Array.isArray(drafts) ? drafts : [];
      if (!list.length) return txt("No KB drafts saved in this FreeDocStore workspace.");
      return txt(`${list.length} workspace draft(s):\n\n${list.map(renderDraft).join("\n\n---\n\n")}`);
    },
  );

  agent.server.tool(
    "create_workspace_draft",
    "Create a FreeDocStore KB draft in the signed-in console workspace. This creates Zensical Markdown source files in the draft but does not publish a GitHub repo.",
    {
      title: z.string().describe("Knowledge base title"),
      prompt: z.string().describe("What this KB should cover"),
      slug: z.string().optional().describe("Preferred slug. A suffix is added if it already exists."),
      custom_domain: z.string().optional().describe("Optional custom domain, without scheme"),
      visibility: z.enum(["public", "private"]).optional().describe("Repo visibility to use when published"),
    },
    async ({ title, prompt, slug, custom_domain, visibility }) => {
      const userId = requireWorkspaceWrite(agent.env, agent.props);
      const current = await readWorkspace<WorkspaceDraft[]>(agent.env, userId, "fds:kbs:v1");
      const drafts = Array.isArray(current) ? current : [];
      const draft = makeWorkspaceDraft({
        title,
        prompt,
        slug: nextDraftSlug(drafts, slug ?? title),
        owner: agent.env.GITHUB_ORG,
        customDomain: custom_domain ?? "",
        visibility: visibility ?? "public",
      });
      await agent.env.FDS_API_KV!.put(userKvKey(userId, "fds:kbs:v1"), JSON.stringify([draft, ...drafts]));
      await agent.env.FDS_API_KV!.put(userKvKey(userId, "fds:active-kb:v1"), JSON.stringify(draft.id));
      return txt(`Created FreeDocStore workspace draft via MCP.\n\n${renderDraft(draft)}`);
    },
  );

  agent.server.tool(
    "create_sample_knowledge_base",
    "Create a small sample FreeDocStore KB draft through MCP for smoke testing.",
    {},
    async () => {
      const userId = requireWorkspaceWrite(agent.env, agent.props);
      const current = await readWorkspace<WorkspaceDraft[]>(agent.env, userId, "fds:kbs:v1");
      const drafts = Array.isArray(current) ? current : [];
      const title = "MCP Sample Knowledge Base";
      const draft = makeWorkspaceDraft({
        title,
        prompt: "A small sample knowledge base created through MCP to verify FreeDocStore account visibility and draft creation.",
        slug: nextDraftSlug(drafts, "mcp-sample-knowledge-base"),
        owner: agent.env.GITHUB_ORG,
      });
      await agent.env.FDS_API_KV!.put(userKvKey(userId, "fds:kbs:v1"), JSON.stringify([draft, ...drafts]));
      await agent.env.FDS_API_KV!.put(userKvKey(userId, "fds:active-kb:v1"), JSON.stringify(draft.id));
      return txt(`Created sample KB draft via MCP.\n\n${renderDraft(draft)}`);
    },
  );
}
