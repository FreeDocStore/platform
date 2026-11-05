import type { Env } from './types';
import { githubRequest as gh, ProvisioningError } from './lib/provisioning-http';
import { managedRepository, publishingTarget, readSource, SETUP_WORKFLOW } from './provisioning';

export interface DeploymentSetup {
  repo: string; branch: string; project: string; domain: string; accountId: string;
  workflow: string; updatedAt: string; expectedSha?: string; prNumber?: number; prUrl?: string;
  dispatchedAt?: string; revision?: string; credentialVersion?: string;
}
export const deploymentKey = (repo: string) => `deployment:${repo.toLowerCase()}`;
export const dispatchKey = (setup: DeploymentSetup) => `deployment-dispatch:${setup.repo.toLowerCase()}:${setup.revision ?? setup.updatedAt}`;
interface DispatchIntent { expectedSha: string; requestedAt: string; refused?: string }

async function setupPull(token: string, setup: DeploymentSetup) {
  if (!setup.prNumber) return null;
  const pr = await gh<{ state: string; merged: boolean; merge_commit_sha: string }>(token, `/repos/${setup.repo}/pulls/${setup.prNumber}`);
  if (!pr || typeof pr.merged !== 'boolean') throw new ProvisioningError(502, 'Could not check the setup pull request. Retry.');
  return pr;
}

async function publishedIdentity(url: string, setup: DeploymentSetup, commit: string) {
  try {
    const response = await fetch(`${url}.well-known/freedocstore.json`, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    if (!response.ok || !response.body) return false;
    const reader = response.body.getReader();
    const parts: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) return false;
        parts.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    const identity = JSON.parse(new TextDecoder().decode(bytes));
    if (identity.repo?.toLowerCase() !== setup.repo.toLowerCase() || identity.commit !== commit || identity.project !== setup.project) return false;
    const home = await fetch(url, { method: 'HEAD', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(10_000) });
    return home.status === 200;
  } catch { return false; }
}

export async function requireSetup(env: Env, token: string, name: string) {
  const repo = await managedRepository(token, name);
  const setup = await env.FDS_API_KV.get<DeploymentSetup>(deploymentKey(repo.full_name), 'json');
  if (!setup) throw new ProvisioningError(404, 'Review and apply the repository setup before deploying.');
  if (setup.branch !== repo.default_branch) throw new ProvisioningError(409, 'The default branch changed. Review setup again before deploying.');
  return setup;
}

export async function dispatchDeployment(env: Env, token: string, setup: DeploymentSetup) {
  const pr = await setupPull(token, setup);
  if (pr && !pr.merged) throw new ProvisioningError(409, pr.state === 'closed' ? 'The setup pull request was closed without merging. Review setup again.' : 'Merge the setup pull request before deploying.');
  const workflow = await readSource(token, setup.repo, SETUP_WORKFLOW, setup.branch);
  if (workflow?.content !== setup.workflow) throw new ProvisioningError(409, 'The reviewed workflow is not on the default branch. Merge its setup pull request, or review setup again if the workflow changed.');
  const ref = await gh<{ object: { sha: string } }>(token, `/repos/${setup.repo}/git/ref/heads/${encodeURIComponent(setup.branch)}`);
  if (!ref?.object?.sha) throw new ProvisioningError(502, 'Could not resolve the deployment source version.');
  const intent: DispatchIntent = { expectedSha: ref.object.sha, requestedAt: new Date().toISOString() };
  // Retry state belongs to this setup revision. It must never rewrite the
  // repository's setup record, which another administrator may have replaced.
  await env.FDS_API_KV.put(dispatchKey(setup), JSON.stringify(intent), { expirationTtl: 86400 });
  try {
    await gh(token, `/repos/${setup.repo}/actions/workflows/deploy.yml/dispatches`, { method: 'POST', body: { ref: setup.branch } });
  } catch (error) {
    if (error instanceof ProvisioningError && [400, 401, 403, 404, 409, 422].includes(error.status)) {
      await env.FDS_API_KV.put(dispatchKey(setup), JSON.stringify({ ...intent, refused: error.message }), { expirationTtl: 86400 });
    }
    throw error;
  }
  return { ...setup, expectedSha: intent.expectedSha, dispatchedAt: intent.requestedAt };
}

export async function deploymentStatus(env: Env, token: string, setup: DeploymentSetup) {
  const pr = await setupPull(token, setup);
  if (pr && !pr.merged) return { state: pr.state === 'closed' ? 'setup-closed' : 'awaiting-review', prUrl: setup.prUrl, message: pr.state === 'closed' ? 'The setup pull request was closed without merging. Review setup again.' : 'Review and merge the setup pull request to install the publishing workflow.' };
  const intent = await env.FDS_API_KV.get<DispatchIntent>(dispatchKey(setup), 'json');
  const current = await gh<{ object: { sha: string } }>(token, `/repos/${setup.repo}/git/ref/heads/${encodeURIComponent(setup.branch)}`);
  if (!current?.object?.sha) throw new ProvisioningError(502, 'Could not check the current source version.');
  const result = await gh<{ workflow_runs: Array<{ id: number; status: string; conclusion: string | null; head_sha: string; html_url: string; created_at: string }> }>(token, `/repos/${setup.repo}/actions/workflows/deploy.yml/runs?branch=${encodeURIComponent(setup.branch)}&per_page=20`);
  if (!Array.isArray(result?.workflow_runs)) throw new ProvisioningError(502, 'Could not read deployment status.');
  const since = Date.parse(intent?.requestedAt ?? setup.dispatchedAt ?? setup.updatedAt) - 2000;
  const run = result.workflow_runs.filter(run => run.head_sha === current.object.sha && Date.parse(run.created_at) >= since).sort((a, b) => b.id - a.id)[0];
  if (!run && intent?.refused) return { state: 'failed', message: `Deployment request was refused. ${intent.refused}` };
  if (!run) return { state: 'waiting', message: 'Waiting for a matching deployment run. Refresh shortly or trigger deployment.' };
  if (run.status !== 'completed') return { state: 'building', runUrl: run.html_url, message: `GitHub Actions: ${run.status}.` };
  if (run.conclusion !== 'success') {
    const jobs = await gh<{ jobs: Array<{ name: string; conclusion: string; steps?: Array<{ name: string; conclusion: string }> }> }>(token, `/repos/${setup.repo}/actions/runs/${run.id}/jobs?per_page=100`);
    const failedSteps = (jobs?.jobs ?? []).flatMap(job => (job.steps ?? []).filter(step => step.conclusion === 'failure').map(step => `${job.name}: ${step.name}`));
    return { state: 'failed', runUrl: run.html_url, failedSteps, message: `Deployment ${run.conclusion ?? 'did not succeed'}. Review the failed steps, fix setup, then retry.` };
  }
  const target = publishingTarget(setup.project, setup.domain);
  const pagesUrl = `https://${setup.project}.pages.dev/`;
  const pagesReady = await publishedIdentity(pagesUrl, setup, run.head_sha);
  const domainReady = setup.domain ? await publishedIdentity(target.url, setup, run.head_sha) : pagesReady;
  if (pagesReady && domainReady) {
    const latest = await gh<{ object: { sha: string } }>(token, `/repos/${setup.repo}/git/ref/heads/${encodeURIComponent(setup.branch)}`);
    if (latest?.object?.sha !== run.head_sha) return { state: 'verifying', runUrl: run.html_url, message: 'The source changed during verification. Checking the new deployment before marking it live.' };
  }
  return { state: pagesReady && domainReady ? 'live' : 'verifying', runUrl: run.html_url, pagesUrl, url: target.url, pagesReady, domainReady,
    message: pagesReady && domainReady ? 'Verified: the public site serves this repository and deployed source version.' : pagesReady ? 'The Pages deployment is verified. The custom domain is not serving this version yet; check DNS and domain activation.' : 'The workflow succeeded, but the public site is not yet serving the expected repository and source version.' };
}
