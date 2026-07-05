# FreeDocStore Editor

Self-serve editor and publisher for FreeDocStore knowledge bases, hosted on ProAppStore.

Live target: <https://freedocstore-editor.proappstore.online>

Canonical source: `apps/editor/` in <https://github.com/FreeDocStore/platform>.

The app is Zensical-only:

- one GitHub repo per KB
- Markdown source in `docs/`
- `zensical.toml` at repo root
- Cloudflare Pages project per KB
- optional custom domain per KB

## Workflows

- Publish a new KB from a prompt: generate a Zensical repo plan, draft Markdown files, and push them to GitHub with a browser-provided token.
- Edit an existing KB page: load Markdown from GitHub, ask AI for a complete replacement, review the diff, then copy or open GitHub for manual edits.

## Development

```bash
pnpm install
pnpm dev
pnpm build
```

## Deploy

Push to `main`; the PAS workflow builds `web/` and syncs to the `pas-apps` R2 bucket.
