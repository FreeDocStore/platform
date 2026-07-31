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
      if (isProtocolClient(request)) return wrongEndpoint();
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

/**
 * Is this an MCP protocol client rather than a person in a browser?
 *
 * A client pointed at the origin instead of `/mcp` asks for the event stream
 * with `GET / Accept: text/event-stream` (the legacy SSE transport), or POSTs
 * JSON-RPC. Answering either with 200 and a short non-stream body tells the
 * client "stream opened" and then drops it — and the spec-correct response to a
 * dropped stream is to reconnect, so it redials ~1/sec, forever. The flood is
 * invisible: every response is a 200, nothing throws, no AI tokens are spent,
 * nothing is written to storage, and the rate limiter only sees `tools/call`
 * traffic carrying an account, which a bare GET has neither of.
 *
 * OPTIONS and HEAD deliberately return false so CORS preflight is unaffected.
 */
function isProtocolClient(request: Request): boolean {
  if (request.method === "POST") return true;
  return (request.headers.get("accept") ?? "").includes("text/event-stream");
}

/** The JSON-RPC 405 the MCP spec requires from an endpoint with no stream to offer. */
function wrongEndpoint(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: "Method Not Allowed — the MCP endpoint is https://mcp.freedocstore.online/mcp",
      },
    }),
    { status: 405, headers: { "content-type": "application/json", allow: "GET, HEAD" } },
  );
}

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
