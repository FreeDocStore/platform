# FreeDocStore MCP Server

Remote MCP server for agents that publish and maintain FreeDocStore knowledge bases.

Canonical source: `workers/mcp/` in <https://github.com/FreeDocStore/platform>.

FreeDocStore is Zensical-only for now:

- one GitHub repo per KB
- Markdown source in `docs/`
- Zensical config in `zensical.toml`
- Cloudflare Pages project per KB
- optional custom domains per KB
- no embedded static HTML folders inside the platform repo

## Endpoint

Current deployed endpoint:

```bash
https://freedocstore-mcp.serge-the-dev.workers.dev/mcp
```

Production target once the domain is attached:

```bash
https://mcp.freedocstore.online/mcp
```

## Connect

```bash
codex mcp add freedocstore --url https://mcp.freedocstore.online/mcp
```

or:

```bash
claude mcp add --scope user --transport http freedocstore https://freedocstore-mcp.serge-the-dev.workers.dev/mcp
```

## Tools

| Tool | Auth | Description |
| --- | --- | --- |
| `whoami` | GitHub OAuth | Show the signed-in account |
| `platform_guide` | none | FreeDocStore rules and Zensical publishing contract |
| `list_knowledge_bases` | none | Read the public registry |
| `knowledge_base_info` | none | Show repo, Cloudflare project, URLs, custom domains |
| `check_zensical_repo` | none | Validate a public repo has `zensical.toml` and `docs/` Markdown |
| `list_files` | none | List files in a public KB repo |
| `read_file` | none | Read one source file from a public KB repo |
| `deploy_status` | none | Last GitHub Actions runs for a KB repo |
| `publish_plan` | none | Turn a prompt/topic into a repo, Zensical, Cloudflare, and domain plan |

OAuth sign-in is GitHub-based and uses the same remote MCP flow as the other stores:

```bash
claude mcp add --scope user --transport http freedocstore https://freedocstore-mcp.serge-the-dev.workers.dev/mcp
```

The Worker requires:

- `OAUTH_KV`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`

The GitHub OAuth callback URL is:

```text
https://freedocstore-mcp.serge-the-dev.workers.dev/callback
```

Write tools come next after the signed-in account can be mapped to repo ownership:

- `create_knowledge_base`
- `update_files`
- `register_custom_domain`
- `publish_from_prompt`

## Development

```bash
npm install
npm run typecheck
npm run dev
npm run deploy
```
