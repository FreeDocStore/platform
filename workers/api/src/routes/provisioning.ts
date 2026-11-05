import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env, Variables } from '../types';
import { requireSession } from '../lib/session';
import { ProvisioningError } from '../lib/provisioning-http';
import { objectBody, stringField } from '../lib/validation';
import { installations, repositories, managedRepository, setupPlan, SETUP_WORKFLOW } from '../provisioning';
import { connectHosting, hostingAccounts, hostingProjects, hostingKey, type HostingConnection } from '../hosting';
import { commitFiles } from '../github';
import { registerManagedKnowledgeBase } from '../publish';
import { deploymentKey, deploymentStatus, dispatchDeployment, requireSetup, type DeploymentSetup } from '../deployment';

type Bindings = { Bindings: Env; Variables: Variables };
type App = Hono<Bindings>;
type Plan = Awaited<ReturnType<typeof setupPlan>> & { accountId: string; connectedAt: string };
const planKey = (session: string, id: string) => `setup-plan:${session}:${id}`;

async function body(c: Context<Bindings>) {
  try { return objectBody(await c.req.json()); }
  catch { throw new ProvisioningError(400, 'Expected a JSON object.'); }
}
function field(value: Record<string, unknown>, key: string) {
  try { return stringField(value, key); }
  catch { throw new ProvisioningError(400, `${key} must be text.`); }
}
function githubToken(c: Context<Bindings>) {
  const session = requireSession(c);
  if (!session.githubAccessToken) throw new ProvisioningError(403, 'Sign in with GitHub to configure an organization repository.');
  return session.githubAccessToken;
}

export function registerProvisioningRoutes(app: App) {
  app.use('/api/provisioning/*', async (c, next) => { githubToken(c); await next(); });
  app.use('/api/provisioning/*', bodyLimit({ maxSize: 8192, onError: c => c.json({ error: 'Setup request exceeds 8 KiB.' }, 413) }));

  app.get('/api/provisioning/installations', async c => {
    const items = await installations(githubToken(c), c.env);
    const slug = c.env.GH_APP_SLUG;
    let installUrl = slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : null;
    let installationWarning: string | null = null;
    if (slug) {
      try {
        const response = await fetch(`https://api.github.com/apps/${encodeURIComponent(slug)}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'freedocstore-api' }, signal: AbortSignal.timeout(10_000), redirect: 'manual', cf: { cacheTtl: 60, cacheEverything: true } });
        if (response.status === 404) {
          installUrl = null;
          installationWarning = 'The FreeDocStore GitHub App is not yet available for installation in additional organizations. Existing installations can still be configured.';
        } else if (response.ok) {
          const metadata = await response.json() as { id?: number };
          if (metadata.id !== Number(c.env.GH_APP_ID)) { installUrl = null; installationWarning = 'Organization setup is temporarily unavailable because the app configuration does not match. Contact FreeDocStore support.'; }
        } else installationWarning = 'GitHub could not confirm new app-installation availability. Retry the access check if installation fails.';
      } catch { installationWarning = 'GitHub could not confirm new app-installation availability. Retry the access check if installation fails.'; }
    }
    return c.json({ installations: items.map(item => ({ id: item.id, account: item.account, permissions: item.permissions, repositorySelection: item.repository_selection,
      configureUrl: item.account.type === 'Organization' ? `https://github.com/organizations/${encodeURIComponent(item.account.login)}/settings/installations/${item.id}` : `https://github.com/settings/installations/${item.id}` })),
      installUrl, installationWarning, setupUrl: `${new URL(c.req.url).origin}/auth/github/setup` });
  });
  app.get('/api/provisioning/repositories', async c => {
    const id = Number(c.req.query('installation'));
    if (!Number.isSafeInteger(id) || id <= 0) throw new ProvisioningError(400, 'Select an app installation.');
    const result = await repositories(githubToken(c), c.env, id);
    return c.json({ repositories: result.repositories.map(repo => ({ fullName: repo.full_name, name: repo.name, branch: repo.default_branch, canConfigure: repo.permissions?.admin === true && repo.permissions.push === true })) });
  });
  app.get('/api/provisioning/connection', async c => {
    const repo = await managedRepository(githubToken(c), c.req.query('repo') ?? '');
    const connection = await c.env.FDS_API_KV.get<HostingConnection>(hostingKey(repo.full_name), 'json');
    const setup = await c.env.FDS_API_KV.get<DeploymentSetup>(deploymentKey(repo.full_name), 'json');
    return c.json({ connection, setup: setup ? { project: setup.project, domain: setup.domain, branch: setup.branch, accountId: setup.accountId } : null });
  });
  app.post('/api/provisioning/accounts', async c => {
    const input = await body(c);
    const token = field(input, 'token');
    const accountId = field(input, 'accountId');
    const accounts = await hostingAccounts(token);
    if (!accountId) return c.json({ accounts });
    if (!accounts.some(account => account.id === accountId)) throw new ProvisioningError(403, 'Select an account accessible to this token.');
    return c.json({ accounts, projects: await hostingProjects(token, accountId) });
  });
  app.post('/api/provisioning/connect', async c => {
    const input = await body(c);
    const connection = await connectHosting(c.env, githubToken(c), { repo: field(input, 'repo'), token: field(input, 'token'), accountId: field(input, 'accountId'), confirmOverwrite: input.confirmOverwrite === true });
    return c.json({ connection });
  });
  app.post('/api/provisioning/plan', async c => {
    const input = await body(c);
    const plan = await setupPlan(githubToken(c), field(input, 'repo'), field(input, 'project'), field(input, 'domain').toLowerCase());
    const connection = await c.env.FDS_API_KV.get<HostingConnection>(hostingKey(plan.repo), 'json');
    if (connection?.status !== 'ready') throw new ProvisioningError(409, 'Connect this repository to your Cloudflare account before reviewing its deployment setup.');
    const previous = await c.env.FDS_API_KV.get<DeploymentSetup>(deploymentKey(plan.repo), 'json');
    const configuredProject = previous?.accountId === connection.accountId && previous.project === plan.project ? { name: previous.project, production_branch: previous.branch } : undefined;
    const existingProject = connection.projects?.find(project => project.name === plan.project) ?? configuredProject;
    if (existingProject && existingProject.production_branch !== plan.branch) throw new ProvisioningError(409, 'The Pages project uses another production branch. Choose the correct project or review its branch settings in Cloudflare.');
    if (existingProject && input.confirmUseProject !== true) throw new ProvisioningError(409, 'Confirm that this repository should publish to the selected Pages project. Its current site may be replaced.');
    if (previous && (previous.project !== plan.project || previous.domain !== plan.domain || previous.accountId !== connection.accountId) && input.confirmRepoint !== true) throw new ProvisioningError(409, 'This changes the previously configured hosting target. Confirm the move after checking the account, project and domain.');
    if (!existingProject && input.confirmCreateProject !== true) throw new ProvisioningError(409, 'Confirm creation of a new Pages project, or select an existing one.');
    const id = crypto.randomUUID();
    await c.env.FDS_API_KV.put(planKey(requireSession(c).id, id), JSON.stringify({ ...plan, accountId: connection.accountId, connectedAt: connection.updatedAt }), { expirationTtl: 900 });
    return c.json({ ...plan, planId: id, accountName: connection.accountName });
  });
  app.post('/api/provisioning/apply', async c => {
    const input = await body(c); const id = field(input, 'planId');
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new ProvisioningError(400, 'Review setup first.');
    const key = planKey(requireSession(c).id, id);
    const plan = await c.env.FDS_API_KV.get<Plan>(key, 'json');
    if (!plan) throw new ProvisioningError(409, 'The setup review expired. Generate a fresh review before applying.');
    const token = githubToken(c);
    const repo = await managedRepository(token, plan.repo);
    if (repo.default_branch !== plan.branch) throw new ProvisioningError(409, 'The default branch changed. Review setup again.');
    if (plan.replacesWorkflow && input.confirmReplaceWorkflow !== true) throw new ProvisioningError(409, 'Confirm replacement of the existing deployment workflow after reviewing its diff.');
    if (input.mode !== 'pr' && input.mode !== 'direct') throw new ProvisioningError(400, 'Choose a setup pull request or a reviewed direct commit.');
    const connection = await c.env.FDS_API_KV.get<HostingConnection>(hostingKey(plan.repo), 'json');
    if (connection?.status !== 'ready' || connection.accountId !== plan.accountId || connection.updatedAt !== plan.connectedAt) throw new ProvisioningError(409, 'The Cloudflare connection changed. Review setup again.');
    const result = plan.files.length ? await commitFiles({ token, repoFullName: plan.repo, baseBranch: plan.branch, message: 'Configure FreeDocStore public publishing', files: plan.files.map(file => ({ path: file.path, content: file.content })), expectedFiles: Object.fromEntries(plan.files.map(file => [file.path, file.expectedSha])), mode: input.mode, prBody: `Reviewed public publishing setup for ${plan.url}. Existing source and unrelated repository files are preserved.` }) : { ok: true, unchanged: true };
    if (!result.ok) return c.json(result, result.errorCode === 'source_conflict' ? 409 : 502);
    const setup: DeploymentSetup = { repo: plan.repo, branch: plan.branch, project: plan.project, domain: plan.domain, accountId: plan.accountId, workflow: plan.workflow,
      updatedAt: new Date().toISOString(), revision: crypto.randomUUID(), expectedSha: result.commitSha, prNumber: result.prNumber, prUrl: result.prUrl };

    await c.env.FDS_API_KV.put(deploymentKey(plan.repo), JSON.stringify(setup));
    await c.env.FDS_API_KV.delete(key);
    return c.json({ ...result, setup: { repo: setup.repo, branch: setup.branch, project: setup.project, domain: setup.domain, url: plan.url, accountName: connection.accountName } });
  });
  app.post('/api/provisioning/deploy', async c => {
    const input = await body(c); const token = githubToken(c);
    const setup = await requireSetup(c.env, token, field(input, 'repo'));
    const connection = await c.env.FDS_API_KV.get<HostingConnection>(hostingKey(setup.repo), 'json');
    if (connection?.status !== 'ready' || connection.accountId !== setup.accountId) throw new ProvisioningError(409, 'Reconnect the reviewed Cloudflare account before deploying.');
    await dispatchDeployment(c.env, token, setup);
    return c.json({ ok: true });
  });
  app.get('/api/provisioning/status', async c => {
    const token = githubToken(c);
    const setup = await requireSetup(c.env, token, c.req.query('repo') ?? '');
    return c.json(await deploymentStatus(c.env, token, setup));
  });
  app.post('/api/provisioning/register', async c => {
    const input = await body(c); const token = githubToken(c);
    const setup = await requireSetup(c.env, token, field(input, 'repo'));
    const status = await deploymentStatus(c.env, token, setup);
    if (status.state !== 'live' || !('url' in status) || !status.url) throw new ProvisioningError(409, 'The public deployment must be verified before adding it to the library.');
    try {
      const registryKbId = await registerManagedKnowledgeBase({ repo: setup.repo, branch: setup.branch, project: setup.project, domain: setup.domain, url: status.url, userToken: token, platformToken: c.env.GITHUB_TOKEN, org: c.env.GITHUB_ORG });
      return c.json({ ...status, registryKbId });
    } catch {
      return c.json({ ...status, registrationWarning: 'The site is verified live, but public-library registration could not be updated. Check deployment again to retry registration.' });
    }
  });
  app.get('/auth/github/setup', async c => {
    const id = Number(c.req.query('installation_id'));
    if (!Number.isSafeInteger(id) || id <= 0) return c.text('Missing GitHub installation. Return to the console and refresh installations.', 400);
    const target = new URL('/provision', c.env.EDITOR_BASE_URL);
    target.searchParams.set('installation', String(id));
    const session = c.get('session');
    if (!session?.githubAccessToken) return c.redirect(`/auth/github/start?next=${encodeURIComponent(target.href)}`);
    if (!(await installations(session.githubAccessToken, c.env)).some(item => item.id === id)) return c.text('This installation is not available to your GitHub account. Open the console to check access.', 403);
    return c.redirect(target.href);
  });
}
