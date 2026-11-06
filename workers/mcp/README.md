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
| `search_documents` | read | Search a registered public KB with bounded excerpts |
| `list_proposals` | read | List open, closed or all proposal PRs for a registered KB |
| `inspect_pr` | read | Inspect proposal status, summary and changed files |
| `move_document` | read; write to confirm | Preview or open a reviewable move PR, including detected links to the old path |

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

## Repository targets and reviewed source versions

`read_file`, `list_files`, `check_zensical_repo`, `deploy_status` and
`update_files` share one target resolver. A registered KB id or an unambiguous
repository short name resolves to its registered `source.repo`, branch, docs
folder and configuration. An unregistered short name selects a repository under
FreeDocStore. An explicit `owner/name` is also supported. When the registry does
not specify a branch, the resolver reads the repository's actual default branch.
A validated `branch` parameter overrides that selection.

Ambiguous names, invalid registry data and failed registry requests stop target
resolution. During a registry outage, an explicit `owner/name` **and** `branch`
can still select a public source; the response explains that its docs/config
metadata uses platform defaults. When the registry is available, matching source
metadata is preserved even with an explicit branch override. Private repositories
are rejected, including when the signed-in account could otherwise access them. Connected reads
use the user’s GitHub token after this public-repository check; anonymous reads
remain supported.

Reads report the canonical repository, selected branch and exact source commit.
`read_file` returns the file's blob SHA and a ready-to-use `expected_files` entry.
A missing file returns a `null` baseline only after the source branch and commit
are resolved. `list_files` includes blob/tree SHAs; only a file's blob SHA is a
valid replacement/deletion baseline. Truncated trees are reported as errors.

Clients upgrading to MCP server 0.4.0 should refresh tool discovery or reconnect.
Every path in `files` or `delete_paths` requires an entry in `expected_files`:

```json
{
  "repo": "CustomerOrg/handbook",
  "branch": "release",
  "message": "Add the reviewed installation guide",
  "files": [{ "path": "docs/install.md", "content": "# Install\n\nReviewed instructions.\n" }],
  "expected_files": { "docs/install.md": null },
  "dry_run": true
}
```

Use `null` only for a file confirmed absent. Replacements and deletions use the
40-character blob SHA returned by a source read. A deletion-only proposal uses
`files: []` with `delete_paths` and the corresponding blob SHAs. Each request
supports up to 50 distinct paths; duplicate paths, update/delete overlaps and
unsafe paths are refused.

Both dry runs and actual writes inspect every baseline against one immutable
parent commit before writing Git objects. A stale replacement, deletion or
creation fails with instructions to reread the source and review a fresh
proposal. A dry run makes read-only requests to validate the target and versions;
it does not reserve the source or authorize a later direct commit. Actual direct
commits still require `confirm: true`. PRs remain the default.

The worker rechecks the base branch before creating a commit and again before
opening a proposal. Direct ref updates explicitly use `force: false` so GitHub
requires a fast-forward update; see the [GitHub reference API](https://docs.github.com/en/rest/git/refs#update-a-reference).
GitHub can still change after the final check and before a PR request is accepted;
the proposal remains based on the inspected commit and normal GitHub review,
merge checks and branch protections apply. An aborted proposal can leave an
unpublished branch; when its creation is confirmed, the tool reports its name
for inspection. No-op changes create no commit/PR or mutation audit entry.
