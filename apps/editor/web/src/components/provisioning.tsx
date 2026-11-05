import { useEffect, useRef, useState } from 'react'
import { fds, type User } from '../lib/fds'
import { buildLineDiff, messageOf, type RegistryKb } from '../model'
import { startDeploymentPolling } from '../services/deployment-polling'
import { provisioning, type OrganizationInstallation, type SetupRepository, type HostingConnection, type HostingProject, type SetupPlan, type DeploymentStatus, type PublishingRecord } from '../services/provisioning'
import type { KnowledgeBaseDraft } from '../model/types'

export function ProvisioningPage({ user, draft, onEdit, onInstallationSelected }: { user: User; draft: KnowledgeBaseDraft; onEdit: (entry: RegistryKb) => void; onInstallationSelected: (owner: string) => void }) {
  const [installations, setInstallations] = useState<OrganizationInstallation[]>([])
  const [installation, setInstallation] = useState(Number(new URLSearchParams(location.search).get('installation')) || 0)
  const [repos, setRepos] = useState<SetupRepository[]>([])
  const [repo, setRepo] = useState(new URLSearchParams(location.search).get('repo') || '')
  const [installUrl, setInstallUrl] = useState<string | null>(null)
  const [installationWarning, setInstallationWarning] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (user.provider !== 'github') { setLoading(false); return }
    let cancelled = false
    setLoading(true); setError('')
    provisioning.installations().then(result => {
      if (cancelled) return
      setInstallations(result.installations); setInstallUrl(result.installUrl); setInstallationWarning(result.installationWarning)
      setInstallation(current => {
        const id = result.installations.some(item => item.id === current) ? current : result.installations[0]?.id || 0
        const account = result.installations.find(item => item.id === id)
        if (account) onInstallationSelected(account.account.login)
        return id
      })
    }).catch(error => { if (!cancelled) setError(messageOf(error)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [user.provider, refresh])
  useEffect(() => {
    if (!installation) { setRepos([]); return }
    let cancelled = false
    setLoading(true); setRepos([]); setError('')
    provisioning.repositories(installation).then(result => {
      if (cancelled) return
      setRepos(result.repositories)
      setRepo(current => result.repositories.some(repo => repo.fullName === current) ? current : '')
    }).catch(error => { if (!cancelled) setError(messageOf(error)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [installation, refresh])
  const selected = repos.find(item => item.fullName === repo)
  const org = installations.find(item => item.id === installation)
  const missing = org ? ['contents', 'actions', 'secrets', 'workflows'].filter(permission => org.permissions[permission] !== 'write') : []
  return <section className="panel provisioning-page">
    <div className="section-title"><div><h1>Set up your knowledge base</h1><p>Publish from your own GitHub organization to your own Cloudflare account.</p></div></div>
    {user.provider !== 'github' ? <p>Sign out and sign in with GitHub to configure a repository.</p> : <>
      <section className="section-block"><h2>1. Choose your organization and repository</h2>
        <p>Create a public repository in your organization, initialize it with a README, then grant the FreeDocStore GitHub App access to that repository.</p>
        <div className="action-row">{(org?.configureUrl || installUrl) && <a className="secondary-action" href={org?.configureUrl || installUrl!} target="_blank" rel="noreferrer">Install or configure GitHub App</a>}<button className="secondary-action" type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh GitHub access</button><a className="secondary-action" href={`${fds.apiBase}/auth/github/start?next=${encodeURIComponent(location.href)}`}>Refresh GitHub sign-in</a></div>
        {installationWarning && <p role="status">{installationWarning}</p>}
        {error && <p role="alert">{error}</p>}
        {!loading && !installations.length && !error && <p>No accessible app installations yet. Ask an organization owner to install FreeDocStore, then refresh.</p>}
        <label className="field"><span>GitHub organization or account</span><select value={installation || ''} disabled={loading} onChange={event => { const id = Number(event.target.value); setInstallation(id); setRepo(''); const account = installations.find(item => item.id === id); if (account) onInstallationSelected(account.account.login) }}><option value="">Choose an installation…</option>{installations.map(item => <option key={item.id} value={item.id}>{item.account.login}</option>)}</select></label>
        {org && <a href={`https://github.com/new?owner=${encodeURIComponent(org.account.login)}`} target="_blank" rel="noreferrer">Create a public repository on GitHub</a>}
        {missing.length > 0 && <p role="alert">The app installation needs these write permissions: {missing.join(', ')}. Ask an organization owner to approve the updated app permissions, then refresh.</p>}
        <label className="field"><span>Public repository</span><select value={selected ? repo : ''} disabled={loading || !installation} onChange={event => {
          const next = event.target.value; setRepo(next)
          const url = new URL(location.href); url.searchParams.set('installation', String(installation)); url.searchParams.set('repo', next); history.replaceState(null, '', url)
        }}><option value="">Choose a repository…</option>{repos.map(item => <option key={item.fullName} value={item.fullName} disabled={!item.canConfigure}>{item.fullName}{item.canConfigure ? '' : ' (write access required)'}</option>)}</select></label>
        {loading && <p role="status">Checking GitHub access…</p>}
        {!loading && installation > 0 && !repos.length && !error && <p>No active public repositories are available to this installation. Check repository selection and your organization permissions, then refresh.</p>}
      </section>
      {selected?.canConfigure && <RepositorySetup key={selected.fullName} repo={selected} draft={draft} onEdit={onEdit} />}
    </>}
  </section>
}

function RepositorySetup({ repo, draft, onEdit }: { repo: SetupRepository; draft: KnowledgeBaseDraft; onEdit: (entry: RegistryKb) => void }) {
  const [connection, setConnection] = useState<HostingConnection | null>(null)
  const [publishingRecord, setPublishingRecord] = useState<PublishingRecord | null>(null)
  const [reconciliation, setReconciliation] = useState<{ status: string; message: string } | null>(null)
  const [lifecycleDialog, setLifecycleDialog] = useState<{ action: 'unpublish' | 'disconnect'; effects: string[] } | null>(null)
  const [removeManagedSecrets, setRemoveManagedSecrets] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [token, setToken] = useState('')
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([])
  const [accountId, setAccountId] = useState('')
  const [projects, setProjects] = useState<HostingProject[]>([])
  const [project, setProject] = useState('')
  const [newProject, setNewProject] = useState(false)
  const [domain, setDomain] = useState(draft.customDomain)
  const [failedVersions, setFailedVersions] = useState<HostingConnection[]>([])
  const [stagingCursor, setStagingCursor] = useState<string | null>(null)
  const [stagingLoaded, setStagingLoaded] = useState(false)
  const [cleanupVersion, setCleanupVersion] = useState('')
  const [confirmCreate, setConfirmCreate] = useState(false)
  const [confirmUseProject, setConfirmUseProject] = useState(false)
  const [confirmRepoint, setConfirmRepoint] = useState(false)
  const [previousTarget, setPreviousTarget] = useState<{ project: string; domain: string; accountId: string } | null>(null)
  const [confirmWorkflow, setConfirmWorkflow] = useState(false)
  const [confirmDraft, setConfirmDraft] = useState(false)
  const [mode, setMode] = useState<'pr' | 'direct'>('pr')
  const [plan, setPlan] = useState<SetupPlan | null>(null)
  const [hasSetup, setHasSetup] = useState(false)
  const poller = useRef<ReturnType<typeof startDeploymentPolling<DeploymentStatus>> | null>(null)
  const [pollingError, setPollingError] = useState('')
  const [deployment, setDeployment] = useState<DeploymentStatus | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('Checking repository setup…')
  const operating = useRef(false)
  const mounted = useRef(true)
  const suggested = draft.slug || repo.fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 58).replace(/-$/, '')
  useEffect(() => {
    mounted.current = true
    provisioning.connection(repo.fullName).then(result => {
      if (!mounted.current) return
      setConnection(result.connection); setProjects(result.connection?.projects ?? [])
      if (result.setup) {
        setPublishingRecord(result.setup)
        setPreviousTarget(result.setup)
        setProject(result.setup.project); setDomain(result.setup.domain); setHasSetup(true)
        if (!result.connection?.projects?.some(project => project.name === result.setup!.project)) setProjects(current => [...current, { name: result.setup!.project, production_branch: result.setup!.branch, domains: [], configured: true }])
      }
      else if (!result.connection?.projects?.length) { setNewProject(true); setProject(suggested) }
    }).catch(error => { if (mounted.current) setError(messageOf(error)) }).finally(() => { if (mounted.current) setBusy('') })
    return () => { mounted.current = false }
  }, [repo.fullName, suggested])
  async function run(label: string, task: () => Promise<void>) {
    if (operating.current) return
    operating.current = true; setBusy(label); setError(''); setStatus('')
    try { await task() } catch (error) { if (mounted.current) setError(messageOf(error)) }
    finally { operating.current = false; if (mounted.current) setBusy('') }
  }
  async function checkDeployment(signal: AbortSignal) {
    const result = await provisioning.status(repo.fullName, signal)
    signal.throwIfAborted()
    if (result.state !== 'live') return result
    try { return await provisioning.register(repo.fullName, signal) }
    catch (error) { if (signal.aborted) throw error; return { ...result, registrationWarning: 'Your site is verified live, but library registration could not be completed. Check deployment again to retry.' } }
  }
  useEffect(() => {
    if (!hasSetup || publishingRecord?.status === 'unpublished' || publishingRecord?.status === 'disconnected') return
    const current = startDeploymentPolling({
      load: checkDeployment,
      onValue: value => { setDeployment(value); setPollingError('') },
      onError: (error, retry) => setPollingError(`${messageOf(error)} ${retry.retryInMs ? `Automatic checks will retry in ${Math.ceil(retry.retryInMs / 1000)} seconds.` : 'Automatic checks paused. Check deployment to try again.'}`),
    })
    poller.current = current
    return () => { current.stop(); if (poller.current === current) poller.current = null }
  }, [hasSetup, repo.fullName, publishingRecord?.status])
  const checkedAccounts = accounts.length > 0
  async function checkAccounts() {
    const result = await provisioning.accounts(token)
    if (!mounted.current) return
    setAccounts(result.accounts); setAccountId(''); setProjects([]); setPlan(null)
    if (!result.accounts.length) setStatus('The token cannot see any Cloudflare accounts. Include Account Settings:read and Pages:edit for the account you want to publish to.')
    if (result.accounts.length === 1) await selectAccount(result.accounts[0].id)
  }
  async function selectAccount(id: string) {
    setAccountId(id); setProjects([]); setProject(''); setPlan(null)
    const result = await provisioning.accounts(token, id)
    if (!mounted.current) return
    setProjects(result.projects ?? [])
    setNewProject(!result.projects?.length)
    if (!result.projects?.length) setProject(suggested)
  }
  async function connect() {
    const result = await provisioning.connect(repo.fullName, token, accountId)
    if (!mounted.current) return
    setConnection(result.connection); setProjects(result.connection.projects); setNewProject(!result.connection.projects.length); setProject(result.connection.projects.length ? '' : suggested); setDomain(''); setConfirmCreate(false); setToken(''); setAccounts([]); setAccountId(''); setPlan(null)
    setStatus(`Credentials staged for ${result.connection.accountName}. They activate when the reviewed workflow is committed or its setup pull request is merged.`)
  }
  async function loadFailedVersions(cursor = '') {
    const result = await provisioning.staging(repo.fullName, cursor)
    if (!mounted.current) return
    setFailedVersions(current => cursor ? [...current, ...result.versions.filter(item => !current.some(existing => existing.version === item.version))] : result.versions)
    setStagingCursor(result.cursor); setStagingLoaded(true); setCleanupVersion('')
  }
  function changeTarget() { setPlan(null); setConfirmWorkflow(false); setConfirmDraft(false); setConfirmCreate(false); setConfirmUseProject(false); setConfirmRepoint(false) }
  const repoints = previousTarget && connection && (previousTarget.project !== project || previousTarget.domain !== domain || previousTarget.accountId !== connection.accountId)
  return <>
    <section className="section-block"><h2>2. Connect your Cloudflare account</h2>
      <p>Deployments use your account and billing. Credentials are encrypted into this repository’s GitHub Actions secrets; they are never saved in browser storage. Staging uses new secret names and leaves existing deployments intact until you approve the workflow change.</p>
      {connection?.status === 'ready' && <p>{connection.version ? 'Staged credentials for' : 'Connected to'} <strong>{connection.accountName}</strong> · checked {new Date(connection.updatedAt).toLocaleString()}</p>}
      {connection?.status === 'ready' && !connection.version && <p>Stage a fresh credential version to review a new setup. Your existing deployment can still be checked or retried below.</p>}
      {!connection && <p role="status">Connect and stage a Cloudflare credential before setup can be reviewed. This draft is saved in your workspace and is not published yet.</p>}
      {connection?.status === 'failed' && <p role="alert">The previous connection was incomplete. Reconnect before deploying.</p>}
      <p>Create a token with Account Settings:read and Cloudflare Pages:edit for the chosen account. Custom domains also need Zone:read and DNS:edit scoped to their zone.</p>
      <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Create a Cloudflare API token</a>
      <label className="field"><span>Cloudflare API token</span><input type="password" autoComplete="off" spellCheck={false} value={token} disabled={Boolean(busy)} onChange={event => { setToken(event.target.value); if (!event.target.value) setProjects(connection?.projects ?? []); setAccounts([]); setAccountId(''); setPlan(null) }} /></label>
      <button className="secondary-action" type="button" disabled={Boolean(busy) || !token} onClick={() => void run('Checking Cloudflare accounts…', checkAccounts)}>Check token and accounts</button>
      {checkedAccounts && <><label className="field"><span>Cloudflare account</span><select value={accountId} disabled={Boolean(busy)} onChange={event => void run('Checking Pages access…', () => selectAccount(event.target.value))}><option value="">Choose an account…</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} · {account.id.slice(0, 8)}</option>)}</select></label>
        <button className="primary-action" type="button" disabled={Boolean(busy) || !accountId} onClick={() => void run('Staging Cloudflare credentials…', connect)}>Stage hosting credentials</button>
      </>}
    </section>
    {hasSetup && publishingRecord && <section className="section-block" aria-labelledby="publishing-lifecycle-title">
      <h2 id="publishing-lifecycle-title">Publishing lifecycle</h2>
      <p>State: <strong>{publishingRecord.status ?? 'active'}</strong>{reconciliation && <> · Reconciliation: <strong>{reconciliation.status.replaceAll('_', ' ')}</strong> — {reconciliation.message}</>}</p>
      {reconciliation && ['access_lost', 'suspended', 'not_found', 'provider_outage'].includes(reconciliation.status) && <p role="status">Last-known configuration is retained. {reconciliation.status === 'provider_outage' ? 'Retry reconciliation when GitHub is available.' : reconciliation.status === 'suspended' ? 'Ask an organization owner to restore the GitHub App installation.' : 'Restore repository access or review the GitHub App installation, then reconcile again.'}</p>}
      {reconciliation?.status === 'renamed' && <p role="status">Repository was renamed to {publishingRecord.repoFullName ?? repo.fullName}. Re-run setup to review the current target.</p>}
      {reconciliation?.status === 'branch_changed' && <p role="status">Default branch changed to {repo.branch}. Review setup before deploying.</p>}
      <div className="action-row"><button className="secondary-action" type="button" disabled={Boolean(busy)} onClick={() => void run('Reconciling GitHub repository…', async () => { const result = await provisioning.reconcile(publishingRecord.repoId ?? repo.id, publishingRecord.repoFullName ?? repo.fullName); setReconciliation({ status: result.status, message: result.record.message }); setPublishingRecord(result.setup) })}>Reconcile now</button>
        <button className="secondary-action" type="button" disabled={Boolean(busy) || publishingRecord.status === 'disconnected'} onClick={() => void run('Reviewing unpublish effects…', async () => { const result = await provisioning.unpublish(publishingRecord.repoId ?? repo.id, publishingRecord.repoFullName ?? repo.fullName, false); setLifecycleDialog({ action: 'unpublish', effects: result.effects }) })}>Unpublish</button>
        <button className="secondary-action" type="button" disabled={Boolean(busy) || publishingRecord.status === 'disconnected'} onClick={() => void run('Reviewing disconnect effects…', async () => { const result = await provisioning.disconnect(publishingRecord.repoId ?? repo.id, publishingRecord.repoFullName ?? repo.fullName, false); setLifecycleDialog({ action: 'disconnect', effects: result.effects }); setRemoveManagedSecrets(false) })}>Disconnect</button></div>
      <details open={showHistory} onToggle={event => setShowHistory(event.currentTarget.open)}><summary>Publishing history ({publishingRecord.history?.length ?? 0})</summary>{publishingRecord.history?.length ? <ol>{publishingRecord.history.map((item, index) => <li key={`${item.at}-${index}`}><strong>{item.event}</strong> · {item.actor} · {new Date(item.at).toLocaleString()}</li>)}</ol> : <p>No lifecycle events recorded.</p>}</details>
      {lifecycleDialog && <div role="dialog" aria-modal="true" aria-labelledby="lifecycle-confirm-title" className="setup-review"><h3 id="lifecycle-confirm-title">Review {lifecycleDialog.action} effects</h3><ul>{lifecycleDialog.effects.map(effect => <li key={effect}>{effect}</li>)}</ul>{lifecycleDialog.action === 'disconnect' && <label className="setup-checkbox"><input type="checkbox" checked={removeManagedSecrets} disabled={Boolean(busy)} onChange={event => setRemoveManagedSecrets(event.target.checked)} />Also remove the recorded repository credential secrets as a separate explicit action.</label>}<div className="action-row"><button className="secondary-action" type="button" disabled={Boolean(busy)} onClick={() => setLifecycleDialog(null)}>Cancel</button><button className="primary-action" type="button" disabled={Boolean(busy)} onClick={() => void run(`${lifecycleDialog.action === 'unpublish' ? 'Unpublishing' : 'Disconnecting'} repository…`, async () => { const result = lifecycleDialog.action === 'unpublish' ? await provisioning.unpublish(publishingRecord.repoId ?? repo.id, publishingRecord.repoFullName ?? repo.fullName, true) : await provisioning.disconnect(publishingRecord.repoId ?? repo.id, publishingRecord.repoFullName ?? repo.fullName, true, removeManagedSecrets); const refreshed = await provisioning.connection(publishingRecord.repoFullName ?? repo.fullName); if (refreshed.setup) setPublishingRecord(refreshed.setup); setLifecycleDialog(null); setStatus('registryWarning' in result ? result.registryWarning ?? 'Publishing disabled.' : lifecycleDialog.action === 'unpublish' ? 'Publishing disabled. The hosted site and repository content were preserved.' : 'Repository disconnected. The hosted site and repository content were preserved.') })}>{lifecycleDialog.action === 'unpublish' ? 'Confirm unpublish' : 'Confirm disconnect'}</button></div></div>}
    </section>}
    {connection?.status === 'ready' && connection.version && !token && <section className="section-block"><h2>3. Review the publishing setup</h2>
      <p>Draft: <strong>{draft.title}</strong> · {draft.files.length} AI generated files remain in workspace draft storage until you review and apply setup. Target repository: <strong>{repo.fullName}</strong> · default branch: <strong>{repo.branch}</strong>.</p><p><a href={`https://github.com/${repo.fullName}/tree/${encodeURIComponent(repo.branch)}/.github/workflows`} target="_blank" rel="noreferrer">View existing workflows on GitHub</a></p>
      <label className="field"><span>Pages project</span><select value={newProject ? '__new' : project} disabled={Boolean(busy)} onChange={event => { const create = event.target.value === '__new'; setNewProject(create); setProject(create ? suggested : event.target.value); changeTarget() }}><option value="">Choose an existing project…</option>{projects.map(item => <option key={item.name} value={item.name}>{item.name} · {item.configured ? 'configured target' : item.production_branch}</option>)}<option value="__new">Create a new Pages project</option></select></label>
      {newProject && <label className="field"><span>New Pages project name</span><input value={project} disabled={Boolean(busy)} onChange={event => { setProject(event.target.value.toLowerCase()); changeTarget() }} /></label>}
      <label className="field"><span>Custom domain (optional)</span><input value={domain} disabled={Boolean(busy)} placeholder="docs.example.com" onChange={event => { setDomain(event.target.value.toLowerCase()); changeTarget() }} /></label>
      <p>Public address: <strong>{domain ? `https://${domain}/` : project ? `https://${project}.pages.dev/` : 'Choose a project'}</strong></p>
      {newProject && <label className="setup-checkbox"><input type="checkbox" checked={confirmCreate} disabled={Boolean(busy)} onChange={event => setConfirmCreate(event.target.checked)} />Create a new Pages project in {connection.accountName}. This will not move an existing site.</label>}
      {!newProject && project && <label className="setup-checkbox"><input type="checkbox" checked={confirmUseProject} disabled={Boolean(busy)} onChange={event => setConfirmUseProject(event.target.checked)} />Publish this repository to the selected {projects.find(item => item.name === project)?.configured ? 'configured' : 'existing'} Pages project. This can replace the site currently hosted there.</label>}
      {repoints && <label className="setup-checkbox"><input type="checkbox" checked={confirmRepoint} disabled={Boolean(busy)} onChange={event => setConfirmRepoint(event.target.checked)} />Change the previous publishing target ({previousTarget.project}) to the account, project and domain shown above.</label>}
      <button className="secondary-action" type="button" disabled={Boolean(busy) || !project || (newProject ? !confirmCreate : !confirmUseProject) || Boolean(repoints && !confirmRepoint)} onClick={() => void run('Preparing setup review…', async () => { const markdown = draft.files.filter(file => /^docs\/(?:[^/]+\/)*[^/]+\.md$/.test(file.path)).map(({ path, content }) => ({ path, content })); const next = await provisioning.plan(repo.fullName, project, domain, confirmCreate, confirmUseProject, confirmRepoint, markdown, draft.title, draft.slug); if (mounted.current) { setPlan(next); setConfirmWorkflow(false); setConfirmDraft(false) } })}>Review setup changes</button>
      {plan && <div className="setup-review"><h3>Setup and draft review · {plan.accountName}</h3><p>{draft.title} ({draft.slug}) · {plan.repo} · {plan.branch} → {plan.url}</p><p>Credential version: <code>{plan.credentialVersion}</code>. Activation happens through this reviewed workflow commit or pull-request merge. Drafts are not published until reviewed changes are applied and deployment is verified live.</p>{plan.warning && <p role="status">{plan.warning}</p>}
        {!plan.files.length && <p>The reviewed publishing files are already installed. Apply to resume deployment tracking.</p>}
        {plan.files.map(file => <details key={file.path}><summary>{file.path} · {file.expectedSha ? 'update' : 'new file'}</summary><pre className="setup-diff">{buildLineDiff(file.before, file.content)}</pre></details>)}
        {plan.replacesWorkflow && <label className="setup-checkbox"><input type="checkbox" checked={confirmWorkflow} disabled={Boolean(busy)} onChange={event => setConfirmWorkflow(event.target.checked)} />Replace the existing deploy.yml workflow with the reviewed workflow and selected hosting target.</label>}
        {plan.hasDraftChanges && <label className="setup-checkbox"><input type="checkbox" checked={confirmDraft} disabled={Boolean(busy)} onChange={event => setConfirmDraft(event.target.checked)} />I reviewed and approve the generated content changes shown above, including any existing documents they replace.</label>}
        <label className="field"><span>Apply setup</span><select value={mode} disabled={Boolean(busy)} onChange={event => setMode(event.target.value as 'pr' | 'direct')}><option value="pr">Open a setup pull request for review</option><option value="direct">Commit reviewed setup to the default branch</option></select></label>
        <button className="primary-action" type="button" disabled={Boolean(busy) || (plan.replacesWorkflow && !confirmWorkflow) || (plan.hasDraftChanges && !confirmDraft)} onClick={() => void run('Applying reviewed setup…', async () => {
          const result = await provisioning.apply(plan.planId, mode, confirmWorkflow, confirmDraft)
          if (!mounted.current) return
          setPreviousTarget({ project: plan.project, domain: plan.domain, accountId: connection.accountId }); setPlan(null); setHasSetup(true); poller.current?.refresh()
          setDeployment(result.prUrl ? { state: 'awaiting-review', prUrl: result.prUrl, message: 'Review and merge the setup pull request. The first build starts when it is merged.' } : { state: 'waiting', message: 'Setup applied. Check the first deployment or trigger it below.' })
          setStatus(result.unchanged ? 'Setup is already current. Trigger deployment below.' : result.prUrl ? 'Setup pull request created.' : 'Setup committed. GitHub Actions will build the site.')
        })}>{mode === 'pr' ? 'Open setup pull request' : 'Commit reviewed setup'}</button>
      </div>}
    </section>}
    <section className="section-block"><h2>Failed credential staging</h2>
      <p>Only failed attempts can be removed here, after checking every branch and open pull request. Ready versions stay available for deployment and rollback.</p>
      <button className="secondary-action" type="button" disabled={Boolean(busy)} onClick={() => void run('Checking failed staging attempts…', () => loadFailedVersions())}>Review failed staging attempts</button>
      {stagingLoaded && !failedVersions.length && <p>No failed attempts on this page.</p>}
      {failedVersions.map(item => <div key={item.version}><label className="setup-checkbox"><input type="checkbox" checked={cleanupVersion === item.version} disabled={Boolean(busy)} onChange={event => setCleanupVersion(event.target.checked ? item.version! : '')} />Remove failed staging credentials for {item.accountName} · {item.version} · {new Date(item.updatedAt).toLocaleString()}</label>
        <button className="secondary-action" type="button" disabled={Boolean(busy) || cleanupVersion !== item.version} onClick={() => void run('Checking workflows and removing failed credentials…', async () => {
          await provisioning.cleanup(repo.fullName, item.version!)
          if (mounted.current) { setFailedVersions(current => current.filter(record => record.version !== item.version)); setCleanupVersion(''); setStatus('Failed staging credentials removed. Ready credential versions were retained.') }
        })}>Remove failed credentials</button></div>)}
      {stagingCursor && <button className="secondary-action" type="button" disabled={Boolean(busy)} onClick={() => void run('Loading more failed attempts…', () => loadFailedVersions(stagingCursor))}>Load more attempts</button>}
      <p><a href={`https://github.com/${repo.fullName}/settings/secrets/actions`} target="_blank" rel="noreferrer">Review repository secrets on GitHub</a></p>
    </section>
    {hasSetup && <section className="section-block"><h2>4. Deploy and verify</h2>
      {deployment && <><p role="status">{deployment.message}</p>{deployment.prUrl && <a href={deployment.prUrl} target="_blank" rel="noreferrer">Review setup pull request</a>}{deployment.runUrl && <p><a href={deployment.runUrl} target="_blank" rel="noreferrer">Open deployment logs</a></p>}{deployment.failedSteps?.map(step => <p key={step}>{step}</p>)}{deployment.pagesReady && deployment.pagesUrl && <p><a href={deployment.pagesUrl} target="_blank" rel="noreferrer">Open verified Pages site</a></p>}{deployment.registrationWarning && <p role="status">{deployment.registrationWarning}</p>}{deployment.registryKbId && <p><button className="secondary-action" type="button" onClick={() => onEdit({ id: deployment.registryKbId!, title: repo.name, source: { repo: repo.fullName, branch: repo.branch }, cloudflare: { production_url: deployment.url } })}>Edit this knowledge base in FreeDocStore</button></p>}{deployment.state === 'live' && deployment.url && <p><a className="primary-action" href={deployment.url} target="_blank" rel="noreferrer">Open published knowledge base</a></p>}</>}
      <div className="action-row"><button className="secondary-action" type="button" disabled={Boolean(busy)} onClick={() => poller.current?.refresh()}>Check deployment</button>
        <button className="primary-action" type="button" disabled={Boolean(busy) || deployment?.state === 'awaiting-review'} onClick={() => void run('Triggering deployment…', async () => { await provisioning.deploy(repo.fullName); if (mounted.current) { setDeployment({ state: 'waiting', message: 'Deployment requested. Check progress shortly.' }); poller.current?.refresh() } })}>Deploy / retry</button></div>
    </section>}
    {pollingError && <p role="status">{pollingError}</p>}
    {busy && <p role="status" aria-live="polite">{busy}</p>}{status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
  </>
}
