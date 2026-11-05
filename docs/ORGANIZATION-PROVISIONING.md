# Organization-owned publishing

The console's **Set up** page provisions public knowledge bases in the user's
own GitHub organization and Cloudflare account. FreeDocStore does not take
ownership of the repository or supply its own hosting credentials.

## User flow

1. Sign in with GitHub. Create an initialized public repository in your
   organization, then install the FreeDocStore GitHub App on the selected
   repository. Refresh GitHub access in the console after installation.
2. Select the installation and an active public repository you administer.
   The server independently checks access and the actual default branch.
3. Enter a Cloudflare API token, inspect accessible accounts and select the
   account. The token needs Account Settings read and Pages edit; a custom
   domain also needs Zone read and DNS edit restricted to its zone. Account
   and project listing checks read access; the deployment confirms write
   permissions. A read-only token cannot be declared deployment-ready solely
   from successful listing.
4. Connect hosting. The server uses the repository's GitHub Actions public key
   to seal the token and account ID before writing repository secrets. Existing
   credentials require an explicit replacement confirmation. A partial write
   records an incomplete connection and blocks deployment until reconnected.
   Tokens are never put in workspace KV, localStorage or sessionStorage.
5. Select an existing Pages project or explicitly choose to create a new one.
   Reusing a project can replace its current site and needs acknowledgement.
   Changing a previously configured account, project or domain needs a separate
   confirmation. Existing projects must use the repository's production branch.
6. Review the generated diff. Existing source and Zensical configuration are
   preserved; missing starter files are added. Replacing an existing deploy.yml
   requires acknowledgement. Apply through a setup PR or a reviewed direct
   commit. Protected branches can use the PR path.
7. Merge a setup PR or deploy/retry after a direct commit. The console reports
   matching Actions runs, failed job steps and recoverable provider errors.
8. A successful build is checked independently: the public deployment identity
   must name the selected repository, current source commit and Pages project,
   and the homepage must respond successfully. A custom domain is checked
   separately from the native Pages address. Only a verified live deployment
   is eligible for public-library registration and editing through the console.

Setup reviews expire after 15 minutes, belong to the initiating session and
check the reviewed source versions before application. A changed hosting
connection or default branch requires a new review. Deployed metadata is
stored per repository, with authorization rechecked against GitHub before it
can be inspected or changed.

## GitHub App configuration

The platform app must be available for installation in other organizations.
An app restricted to its owning organization cannot provide public onboarding;
the console detects an unavailable public app registration and explains this
instead of offering a broken installation link.

Configure the registered app with:

- Repository Contents: read/write.
- Repository Actions: read/write, for dispatch and build status.
- Repository Secrets: read/write, for encrypted repository credentials.
- Repository Workflows: read/write, for the reviewed deploy workflow.
- Metadata: read, as required by GitHub.
- Setup URL: `https://api.freedocstore.online/auth/github/setup`.
- OAuth callback: `https://api.freedocstore.online/auth/github/callback`.

Repository creation, organization administration, member enumeration, a private
key and installation-token minting are not required by this existing-repository
flow. Customer organizations approve the app and choose its repository access.
Existing installations may need to approve added permissions, then refresh
GitHub sign-in before using them.

The API deployment uses the public `GH_APP_ID` and `GH_APP_SLUG` variables;
OAuth credentials remain managed by the existing server secret store. No token
is embedded in a generated workflow, diff, browser URL or error response.

## Recovery and limits

- A previously configured target can be reviewed after a reload even if the
  saved Cloudflare project inventory predates its creation. This does not infer
  that the target exists in a different account.
- Status reads do not rewrite setup metadata. Dispatch intent is recorded
  separately for each setup revision, so retrying an older configuration cannot
  replace a newer setup record.
- Deployment polling resumes after temporary network/provider failures with
  increasing delays, honors provider cooldowns and pauses after five consecutive
  errors. Manual checks cannot bypass an active provider cooldown. PR review
  waits are checked less frequently than active builds.
- Public verification rechecks the current source before declaring the site
  live, including when the source changes during the public-page checks.

- GitHub/Cloudflare outages are reported separately from denied permissions.
- A closed, unmerged setup PR requires another review. A pending PR cannot be
  dispatched as though its workflow were already on the default branch.
- A changed workflow blocks redispatch until it is reviewed again.
- Provider secrets are never read back. Reconnection replaces them only with
  confirmation; failed writes may need to be repeated.
- Registry failure does not turn a verified public site into a failed build.
  Checking deployment again retries registration without discarding the setup.
- This setup currently supports Zensical's `[project]` configuration with
  `docs/` source and `site/` output. Unsupported configurations are explained
  before mutation; they are not silently converted.
- Private sites belong in ProDocStore. GitHub credential renewal is tracked in
  issue #20; expired or revoked authorization requires sign-in again.
