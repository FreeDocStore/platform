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
https://mcp.freedocstore.online/mcp
```

## Connect

```bash
codex mcp add freedocstore --url https://mcp.freedocstore.online/mcp
```

or:

```bash
claude mcp add --scope user --transport http freedocstore https://mcp.freedocstore.online/mcp
```

## Tools

| Tool | Auth | Description |
| --- | --- | --- |
| `whoami` | GitHub OAuth | Show the signed-in account |
| `workspace_summary` | GitHub OAuth | Show saved console workspace state for the signed-in account |
| `list_workspace_drafts` | GitHub OAuth | List KB drafts saved in the console workspace |
| `create_workspace_draft` | GitHub OAuth + write | Create a console-visible Zensical KB draft |
| `create_sample_knowledge_base` | GitHub OAuth + write | Create a sample KB draft for smoke testing |
| `platform_guide` | none | FreeDocStore rules and Zensical publishing contract |
| `list_knowledge_bases` | none | Read the public registry |
| `knowledge_base_info` | none | Show repo, Cloudflare project, URLs, custom domains |
| `check_zensical_repo` | none | Validate a public repo has `zensical.toml` and `docs/` Markdown |
| `list_files` | none | List files in a public KB repo |
| `read_file` | none | Read one source file from a public KB repo |
| `deploy_status` | none | Last GitHub Actions runs for a KB repo |
| `publish_plan` | none | Turn a prompt/topic into a repo, Zensical, Cloudflare, and domain plan |
| `update_files` | GitHub OAuth + write | Edit KB repo files as the signed-in user. Opens a proposal PR by default; `mode: "direct"` commits straight to the base branch |

`update_files` uses the signed-in user's GitHub token (the OAuth flow requests `public_repo`), so commits and PRs are authored by that user. Sessions created before this scope existed must reconnect to grant it.

OAuth sign-in is GitHub-based and uses the same remote MCP flow as the other stores:

```bash
claude mcp add --scope user --transport http freedocstore https://mcp.freedocstore.online/mcp
```

The Worker requires:

- `OAUTH_KV`
- `FDS_API_KV`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`

The GitHub OAuth callback URL is:

```text
https://mcp.freedocstore.online/callback
```

Remaining planned write tools:

- `create_knowledge_base`
- `register_custom_domain`
- `publish_from_prompt`

## Development

```bash
npm install
npm run typecheck
npm run dev
npm run deploy
```
