# FreeDocStore MCP — live smoke test

Manual verification for the deployed MCP worker's OAuth 2.1 flow and tools. Run
this after a deploy that touches `workers/mcp/`, or when validating the OAuth
hardening from issue #2.

- **Base URL:** `https://mcp.freedocstore.online`
- **MCP endpoint:** `https://mcp.freedocstore.online/mcp`
- **OAuth provider:** `@cloudflare/workers-oauth-provider` (discovery, `/register`,
  `/token`); GitHub sign-in is handled by the FreeDocStore `/authorize` +
  `/callback` handler.

The OAuth provider endpoints only run under the Cloudflare runtime (workerd), so
they are verified here against the live worker rather than in the unit suite. The
`/authorize` and `/callback` logic has unit coverage in
`src/__tests__/auth-handler.test.ts`.

## 0. Prerequisites

```bash
# mcp-remote drives the full browser OAuth handshake
npx -y mcp-remote --help

# jq for readable JSON in the curl checks below
jq --version
```

## 1. One-command end-to-end (recommended)

`mcp-remote` performs discovery → dynamic registration → `/authorize` (opens a
browser for GitHub sign-in) → `/callback` → `/token`, then lists tools.

```bash
npx -y mcp-remote https://mcp.freedocstore.online/mcp
```

**Expected:** a browser opens to GitHub, you authorize the FreeDocStore App, the
tab returns to the client, and the CLI prints the tool list (`whoami`,
`list_knowledge_bases`, `update_files`, …). A stored token is cached under
`~/.mcp-auth/`. Delete that dir to re-test the cold OAuth path.

Or connect through a host:

```bash
claude mcp add --scope user --transport http freedocstore https://mcp.freedocstore.online/mcp
```

## 2. Endpoint-by-endpoint (curl)

### 2a. Authorization-server discovery

```bash
curl -s https://mcp.freedocstore.online/.well-known/oauth-authorization-server | jq
```

**Expect** `200` and JSON with:
- `authorization_endpoint` ending `/authorize`
- `token_endpoint` ending `/token`
- `registration_endpoint` ending `/register`
- `scopes_supported` containing `read` and `write`

Protected-resource metadata should also resolve:

```bash
curl -s https://mcp.freedocstore.online/.well-known/oauth-protected-resource | jq
```

### 2b. Dynamic client registration

```bash
curl -s -X POST https://mcp.freedocstore.online/register \
  -H 'content-type: application/json' \
  -d '{"redirect_uris":["http://localhost:9999/callback"],"client_name":"smoke-test","token_endpoint_auth_method":"none"}' | jq
```

**Expect** `201` and a body with a `client_id` and the `redirect_uris` echoed
back. Save the `client_id` for the next step.

### 2c. Authorize (redirect to GitHub)

```bash
CLIENT_ID='<client_id from 2b>'
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  "https://mcp.freedocstore.online/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=http://localhost:9999/callback&scope=read+write&state=xyz"
```

**Expect** `302` redirecting to `https://github.com/login/oauth/authorize?...`
with `client_id`, `state`, and a `redirect_uri` pointing back at
`/callback?nonce=...`. If the GitHub App is unconfigured the worker returns
`503 GitHub App OAuth is not configured` (that is the correct disabled-provider
response, not a failure of the worker).

### 2d. Callback error states

The real callback requires a GitHub `code` and a matching one-time `nonce`, so it
can only be completed through the browser flow (step 1). Its guard rails are
verifiable directly:

```bash
# mismatched nonce/state -> 400
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://mcp.freedocstore.online/callback?nonce=a&state=b&code=c"

# expired / unknown nonce -> 400 "Expired OAuth request"
curl -s -w '\n%{http_code}\n' \
  "https://mcp.freedocstore.online/callback?nonce=zzz&state=zzz&code=c"
```

**Expect** `400` for both. (Token-exchange and user-fetch failures return `502`;
those paths are covered by the unit suite.)

### 2e. Token endpoint

```bash
curl -s -X POST https://mcp.freedocstore.online/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code&code=bogus&client_id=nope&redirect_uri=http://localhost:9999/callback' | jq
```

**Expect** `400` with an OAuth error body (`{"error":"invalid_grant"}` or
`invalid_request`). A valid token is only issued at the end of the browser flow.

### 2f. Wrong-endpoint protocol guard

A protocol client pointed at the origin instead of `/mcp` must get a JSON-RPC
`405`, while a browser gets the plain-text landing page.

```bash
# protocol client (SSE) -> 405 JSON-RPC
curl -s -w '\n%{http_code}\n' -H 'accept: text/event-stream' https://mcp.freedocstore.online/
# POST -> 405
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mcp.freedocstore.online/
# browser -> 200 landing page
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.freedocstore.online/
```

**Expect** `405`, `405`, `200` respectively.

## 3. Authenticated tool checks (after step 1)

With a connected session, confirm the read path and the write safety gates from
issue #2 AC #3:

- `whoami` → shows your GitHub login and `scopes: ["read","write"]`.
- `update_files` with `dry_run: true` → returns a change plan and **writes
  nothing** to GitHub.
- `update_files` with `mode: "direct"` and no `confirm` → refuses, asking for
  `confirm: true`.
- `update_files` in the default `pr` mode → opens a proposal PR on the target KB
  repo.

## 4. Result checklist

| Check | Endpoint | Expected |
| --- | --- | --- |
| Discovery | `/.well-known/oauth-authorization-server` | `200`, endpoints + scopes |
| Registration | `POST /register` | `201`, `client_id` |
| Authorize | `GET /authorize` | `302` to GitHub (or `503` if unconfigured) |
| Callback guard | `GET /callback` | `400` on bad/expired nonce |
| Token | `POST /token` | `400` OAuth error on invalid grant |
| Protocol guard | `GET/POST /` | `405` client / `200` browser |
| End-to-end | `mcp-remote` | tool list after GitHub sign-in |
| Write safety | `update_files` | dry-run/confirm gates enforced |
