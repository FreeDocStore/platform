# GitHub App migration

Replace the two GitHub **OAuth Apps** (console + MCP) with one GitHub **App**.

## Why

The current OAuth Apps request `public_repo workflow` — a coarse scope that grants
our tokens access to **every** public repo the signed-in user owns. A GitHub App is
installed on **selected repos** with **fine-grained permissions**, so a token can
only ever touch the repos the user explicitly granted. This is the gate before
inviting anyone other than the owner to publish.

## Design (chosen for a minimal, correct change)

- **User-to-server tokens only** for user-attributed writes (commits, PRs). These
  come from the App's OAuth flow — the *same* `github.com/login/oauth/*` endpoints
  we already call, using the App's `client_id`/`client_secret` and **no `scope`
  param** (permissions come from the App). Commits stay authored by the real user.
- **Disable user-token expiration** on the App, so user-to-server tokens are
  long-lived like today's OAuth tokens — no refresh-token machinery needed.
- **No private key / installation tokens / webhooks** in phase 1. We don't generate
  App JWTs or installation access tokens, so the App needs no private key and no
  webhook endpoint. (We can add these later for org automation.)
- **Repo creation stays on the platform PAT** (`GITHUB_TOKEN`), already used for
  registry writes. Creating repos in the FreeDocStore org is a platform-controlled
  operation into a platform-owned org — keeping it on the PAT means the App never
  needs org `Administration`, so the user grant stays as tight as possible. Only
  the per-repo content writes move to the App user token.

Net code change once the App exists: drop the `scope` param and point both workers
at the App's `client_id`/`client_secret`; switch `publish.ts` repo creation from the
user token to the platform PAT. Everything else (the commit/PR paths) is unchanged.

## What you register (one App, on the FreeDocStore org)

Create at: <https://github.com/organizations/FreeDocStore/settings/apps/new>

| Field | Value |
| --- | --- |
| GitHub App name | `FreeDocStore` (or `FreeDocStore Publisher` if the name is taken) |
| Homepage URL | `https://freedocstore.online` |
| Callback URL 1 | `https://api.freedocstore.online/auth/github/callback` |
| Callback URL 2 | `https://mcp.freedocstore.online/callback` |
| Expire user authorization tokens | **Unchecked** (disable) |
| Request user authorization (OAuth) during installation | Unchecked |
| Enable Device Flow | Unchecked |
| Webhook → Active | **Unchecked** (deactivate; no webhook URL needed) |

**Repository permissions:**

| Permission | Access |
| --- | --- |
| Contents | Read and write |
| Pull requests | Read and write |
| Workflows | Read and write |
| Metadata | Read-only (mandatory, auto-selected) |

**Organization permissions:** none.

**Where can this App be installed?** "Any account" (so users can later install it on
their own accounts to publish under their own namespace) — or "Only this account" if
KBs stay under the FreeDocStore org for now.

After creating it:

1. **Generate a client secret** (App settings → "Client secrets" → Generate).
2. **Install the App** (App settings → Install App → FreeDocStore org → All
   repositories). This is what lets user tokens reach the KB repos.

## The created App (2026-07-12)

- **App ID:** `4278932`
- **Client ID:** `Iv23li4lX93yd8MRMctL` (not secret — appears in authorize URLs)
- **Installed on:** "Only this account" (FreeDocStore org) — fine for phase 1; can be
  made public later (App settings → bottom → "Make public") when users publish under
  their own accounts.

Still needed before wiring (see checklist below):

- **Client secret** — generate + store in SOPS as `fdocs.GH_APP_CLIENT_SECRET`
- Second **callback URL** for MCP
- The four **repository permissions**
- **Install** the App on the FreeDocStore org (All repositories)

Private key (`.pem`) is not needed for phase 1 (user-to-server only); download it into
Bitwarden for later installation-token use.

## Post-creation checklist

- [ ] Add the MCP callback URL (`https://mcp.freedocstore.online/callback`) alongside
      the existing api one ("Add callback URL" on the settings page).
- [ ] Verify **"Expire user authorization tokens"** is unchecked.
- [ ] Verify **Webhook → Active** is unchecked.
- [ ] Permissions & events tab → Contents RW, Pull requests RW, Workflows RW.
- [ ] Generate a client secret → SOPS `fdocs.GH_APP_CLIENT_SECRET`.
- [ ] Install App → FreeDocStore org → All repositories.

## Rollout

1. Store the App client id/secret as new worker secrets (`GH_APP_CLIENT_ID`,
   `GH_APP_CLIENT_SECRET`) on both `freedocstore-api` and `freedocstore-mcp`.
2. Wire the workers (drop `scope`, use the App client id/secret; move repo creation
   to the platform PAT). Ship behind the swap — old OAuth apps keep working until
   the secrets are switched, so this is reversible.
3. Re-authenticate once (console sign-out/in; MCP reconnect). The consent screen now
   shows fine-grained repo selection instead of "all public repos."
4. Once verified, delete the two old OAuth Apps (3710352 console, 3710371 MCP).
