# Organization-owned publishing

The console's **Set up** page provisions public knowledge bases in the user's
own GitHub organization and Cloudflare account. FreeDocStore does not take
ownership of the repository or supply its own hosting credentials.

## User flow

1. Sign in with GitHub. Install the FreeDocStore GitHub App with access to an
   initialized public repository. You can use a repository that already exists;
   repository creation is optional. Refresh GitHub access after installation.
2. Select the installation and an active public repository where your GitHub
   account can write. Repository creation and organization administration are
   not required. The server checks access and the actual default branch.
3. Enter a Cloudflare API token, inspect accessible accounts and select the
   account. The token needs Account Settings read and Pages edit; a custom
   domain also needs Zone read and DNS edit restricted to its zone. Account
   and project listing checks read access; the deployment confirms write
   permissions. A read-only token cannot be declared deployment-ready solely
   from successful listing.
4. Stage hosting credentials. The server uses the repository's GitHub Actions public key
   to seal the token and account ID before writing repository secrets. Each attempt uses
   a new immutable pair of secret names. Existing workflow credentials are never
   overwritten. Partial failures leave the active deployment and latest ready
   candidate intact; stage again with a fresh version.
   Tokens are never put in workspace KV, localStorage or sessionStorage.
5. Select an existing Pages project or explicitly choose to create a new one.
   Reusing a project can replace its current site and needs acknowledgement.
   Changing a previously configured account, project or domain needs a separate
   confirmation. Existing projects must use the repository's production branch.
6. Review the generated diff. Existing source and Zensical configuration are
   preserved; missing starter files are added. Replacing an existing deploy.yml
   requires acknowledgement. Apply through a setup PR or a reviewed direct
   commit. The reviewed workflow binds the exact staged credential version, account
   and project. It activates that pair only when committed to the publishing
   branch or merged. Protected branches can use the PR path.
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

## Setup and AI content review

AI generated files stay in the workspace draft until the user chooses a
repository and Pages target. The setup plan then includes those files alongside
the shared managed workflow and missing scaffolding. Its diff shows current
repository content and requires explicit approval for generated content and
workflow replacement. Existing docs and configuration are never silently
replaced. Plan data is bound to the initiating session, expires after 15
minutes, validates paths and input sizes, and checks each source blob again
before applying by PR or direct commit. A draft is not published until a live
deployment is verified and registered.

New workspace drafts start blank. Once GitHub installations load, the first
accessible installation account becomes the default owner for a new draft. The
setup page allows selecting another installation and repository.

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
- Provider secrets are never read back. Restaging creates a new pair. Deployment
  retry resolves the reviewed version, independently of a newer staged candidate.
  Existing setups using the original common secret names remain retryable, but
  must stage a fresh version before reviewing a new workflow.
- Failed staging attempts can be listed and explicitly removed in the console.
  Cleanup only accepts failed, never-ready versions. It inspects workflows at
  every current branch and open PR head (including fork PRs) and rechecks refs
  before deletion. References to the selected pair, dynamic secret access,
  inherited secrets, unavailable source or an incomplete inventory stop cleanup.
  The automatic scan supports fewer than 100 branches/open PRs each, at most
  eight distinct heads and 20 workflow files across them. Larger repositories
  require manual review on GitHub. A concurrent manual push after the final ref
  check cannot be locked by this service; do not manually adopt failed versions.
- Ready credential versions are retained for active workflows, pending reviews
  and rollback. Their removal requires manual repository-wide review on GitHub.
  Cleanup failures retain failed metadata for retry, including partial deletion.
- Registry failure does not turn a verified public site into a failed build.
  Checking deployment again retries registration without discarding the setup.
- This setup currently supports Zensical's `[project]` configuration with
  `docs/` source and `site/` output. Unsupported configurations are explained
  before mutation; they are not silently converted.
- Private sites belong in ProDocStore. GitHub credential renewal is tracked in
  issue #20; expired or revoked authorization requires sign-in again.
