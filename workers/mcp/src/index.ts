import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuthHandler } from "./auth-handler.js";
import { type Env, type McpProps } from "./tools/helpers.js";
import { registerAccountTools } from "./tools/account.js";
import { registerKbTools } from "./tools/kb.js";
import { registerWriteTools } from "./tools/write.js";

export class FreeDocStoreMcp extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({
    name: "FreeDocStore",
    version: "0.2.0",
  });

  declare props: McpProps;

  async init() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const agent = {
      server: self.server,
      get env() { return self.env; },
      get props() { return self.props; },
    };
    registerAccountTools(agent);
    registerKbTools(agent);
    registerWriteTools(agent);
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
          "Tools: whoami, workspace_summary, list_workspace_drafts, create_workspace_draft, create_sample_knowledge_base, platform_guide, list_knowledge_bases, knowledge_base_info, check_zensical_repo, list_files, read_file, deploy_status, publish_plan, update_files",
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
