import { useEffect, useMemo, useRef, useState } from 'react'
import { fds as app, useAuth, useSubscription, useTheme, type ByokProvider, type SecretStatus } from './lib/fds'
import {
  ACTIVE_KB_KEY,
  AI_PROVIDERS,
  BYOK_PROVIDER_IDS,
  type AiUsage,
  CONFIG_KEY,
  KBS_KEY,
  REGISTRY_URL,
  type AppRoute,
  type EditForm,
  type KnowledgeBaseDraft,
  type PlatformConnections,
  type Proposal,
  type PublishForm,
  type PublishStep,
  type RegistryKb,
  type Settings,
  buildLineDiff,
  cloneSteps,
  createKnowledgeBase,
  emptySecrets,
  emptySettings,
  githubHeaders,
  initialConnections,
  livePageUrl,
  markCurrentError,
  messageOf,
  nextAvailableSlug,
  normalizeKnowledgeBase,
  normalizeSettings,
  nowIso,
  parseStoredJson,
  locationFromUrl,
  pushLocation,
  replaceLocation,
  resetSteps,
  starterEdit,
  starterPublish,
  toPublishForm,
  updateStep,
  validateAi,
  validateKbFiles,
  validatePlatformAccess,
  validatePublishForm,
} from './model'
import { usePwa } from './hooks/usePwa'
import { generateEditProposal, generateKbFiles, pingAi } from './services/ai'
import { readGitHubFile } from './services/github'
import { LoadingScreen, SignedOutLanding } from './components/signin'
import { MobileTabBar, StoreHeader } from './components/header'
import { DashboardPage } from './components/dashboard'
import { PublishPanel, SelectedKbHeader } from './components/publish'
import { EditPanel } from './components/edit'
import { EditPreview, FilesPreview, PreviewTabs } from './components/preview'
import { SettingsPanel } from './components/settings'
import { ProfilePage } from './components/profile'

function App() {
  return <EditorApp />
}

function EditorApp() {
  const { user, loading: authLoading, signIn, signOut, deleteAccount } = useAuth()
  const { subscription, isPro, loading: subLoading, upgrade, manageBilling } = useSubscription()
  const { preference, setPreference } = useTheme()
  const [route, setRoute] = useState<AppRoute>(() => locationFromUrl().route)
  const [editKbId, setEditKbId] = useState(() => locationFromUrl().kbId)
  const [settings, setSettings] = useState<Settings>(emptySettings)
  const [secrets, setSecrets] = useState<SecretStatus>(emptySecrets)
  const [keyInputs, setKeyInputs] = useState<Record<ByokProvider, string>>({ openai: '', anthropic: '' })
  const [kbs, setKbs] = useState<KnowledgeBaseDraft[]>(() => [createKnowledgeBase(starterPublish)])
  const [platformLoaded, setPlatformLoaded] = useState(false)
  const [connections, setConnections] = useState<PlatformConnections>(initialConnections)
  const [activeKbId, setActiveKbId] = useState('')
  const [editForm, setEditForm] = useState<EditForm>(starterEdit)
  const [source, setSource] = useState('')
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [diff, setDiff] = useState('')
  const [activePreview, setActivePreview] = useState<'files' | 'source' | 'proposal' | 'diff' | 'live'>('files')
  const [library, setLibrary] = useState<RegistryKb[]>([])
  const [lastUsage, setLastUsage] = useState<AiUsage | null>(null)
  const [status, setStatus] = useState('Ready')
  const [busy, setBusy] = useState(false)
  const { installPrompt, pwaReady, updateAvailable, installApp, activateUpdate } = usePwa()
  const connectionCheckStarted = useRef(false)

  const activeKb = kbs.find((kb) => kb.id === activeKbId) ?? kbs[0] ?? createKnowledgeBase(starterPublish)
  const publishForm = toPublishForm(activeKb)
  const files = activeKb?.files ?? []
  const steps = activeKb?.steps ?? cloneSteps()
  const liveUrl = activeKb?.liveUrl ?? ''

  useEffect(() => {
    fetch(REGISTRY_URL)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { knowledge_bases?: RegistryKb[] } | null) => setLibrary(data?.knowledge_bases ?? []))
      .catch(() => setLibrary([]))
  }, [])

  useEffect(() => {
    const syncRoute = () => {
      const loc = locationFromUrl()
      setRoute(loc.route)
      setEditKbId(loc.kbId)
    }
    window.addEventListener('popstate', syncRoute)
    syncRoute()
    return () => window.removeEventListener('popstate', syncRoute)
  }, [])

  const loadedEditKey = useRef('')

  // Resolve /edit/<kbId>?file=… into the edit form and load the source, including
  // after a refresh or once the registry finishes loading.
  useEffect(() => {
    if (route !== 'edit' || !editKbId) return
    if (!library.length) return // registry still loading
    const kb = library.find((entry) => entry.id === editKbId)
    if (!kb) {
      setStatus(`"${editKbId}" isn't in the public registry. Pick a knowledge base from the dashboard.`)
      return
    }
    const file = locationFromUrl().file || 'docs/index.md'
    const key = `${editKbId}:${file}`
    if (loadedEditKey.current === key) return
    loadedEditKey.current = key
    const next = { repo: kb.source.repo, branch: kb.source.branch ?? 'main', path: file, instruction: starterEdit.instruction }
    setEditForm(next)
    loadSource(next)
  }, [route, editKbId, library])

  function goEdit(kbId?: string) {
    const target = kbId || editKbId || localStorage.getItem('fds:last-edit-kb') || library[0]?.id
    if (!target) {
      navigate('dashboard')
      return
    }
    localStorage.setItem('fds:last-edit-kb', target)
    setRoute('edit')
    setEditKbId(target)
    setActivePreview('source')
    pushLocation({ route: 'edit', kbId: target, file: 'docs/index.md' })
  }

  function navigate(route: AppRoute) {
    if (route === 'edit') {
      goEdit()
      return
    }
    setRoute(route)
    setEditKbId('')
    pushLocation({ route })
  }

  useEffect(() => {
    const saved = parseStoredJson<Partial<Settings>>(localStorage.getItem('fds-editor-settings'))
    if (saved) setSettings(normalizeSettings(saved))
    const savedKbs = parseStoredJson<unknown>(localStorage.getItem('fds-kb-drafts'))
    if (savedKbs) {
      const parsed = savedKbs
      if (Array.isArray(parsed) && parsed.length) {
        const normalized = parsed.map(normalizeKnowledgeBase)
        setKbs(normalized)
        const storedActive = localStorage.getItem('fds-active-kb')
        setActiveKbId(normalized.some((kb) => kb.id === storedActive) ? storedActive || normalized[0].id : normalized[0].id)
      }
    } else {
      const pub = parseStoredJson<Partial<PublishForm>>(localStorage.getItem('fds-publish-draft'))
      if (pub) {
        const legacy = createKnowledgeBase({ ...starterPublish, ...pub })
        setKbs([legacy])
        setActiveKbId(legacy.id)
      }
    }
    const edit = parseStoredJson<Partial<EditForm>>(localStorage.getItem('fds-edit-draft'))
    if (edit) setEditForm({ ...starterEdit, ...edit })
  }, [])

  useEffect(() => {
    if (!user) {
      setPlatformLoaded(false)
      setSecrets(emptySecrets)
      setKeyInputs({ openai: '', anthropic: '' })
      return
    }
    let cancelled = false
    async function loadPlatformState() {
      try {
        const [savedSettings, savedKbs, savedActive] = await Promise.all([
          app.kv.get<Partial<Settings>>(CONFIG_KEY),
          app.kv.get<KnowledgeBaseDraft[]>(KBS_KEY),
          app.kv.get<string>(ACTIVE_KB_KEY),
        ])
        if (cancelled) return
        if (savedSettings) setSettings(normalizeSettings(savedSettings))
        if (Array.isArray(savedKbs) && savedKbs.length) {
          const normalized = savedKbs.map(normalizeKnowledgeBase)
          setKbs(normalized)
          setActiveKbId(normalized.some((kb) => kb.id === savedActive) ? savedActive || normalized[0].id : normalized[0].id)
        }
        setStatus('Loaded platform workspace')
      } catch (error) {
        if (!cancelled) setStatus(`Platform workspace unavailable: ${messageOf(error)}`)
      } finally {
        if (!cancelled) setPlatformLoaded(true)
      }
    }
    loadPlatformState()
    return () => {
      cancelled = true
    }
  }, [user])

  useEffect(() => {
    if (!user) return
    refreshSecrets().catch((error) => setStatus(`Could not load BYOK key status: ${messageOf(error)}`))
  }, [user])

  useEffect(() => {
    if (kbs[0] && (!activeKbId || !kbs.some((kb) => kb.id === activeKbId))) setActiveKbId(kbs[0].id)
  }, [activeKbId, kbs])

  useEffect(() => {
    localStorage.setItem('fds-editor-settings', JSON.stringify(normalizeSettings(settings)))
    if (user && platformLoaded) app.kv.set(CONFIG_KEY, normalizeSettings(settings)).catch((error) => setStatus(`Could not save platform settings: ${messageOf(error)}`))
  }, [platformLoaded, settings, user])

  useEffect(() => {
    localStorage.setItem('fds-kb-drafts', JSON.stringify(kbs))
    if (user && platformLoaded) app.kv.set(KBS_KEY, kbs).catch((error) => setStatus(`Could not save platform KBs: ${messageOf(error)}`))
  }, [kbs, platformLoaded, user])

  useEffect(() => {
    if (activeKbId) localStorage.setItem('fds-active-kb', activeKbId)
    if (user && platformLoaded && activeKbId) app.kv.set(ACTIVE_KB_KEY, activeKbId).catch(() => {})
  }, [activeKbId, platformLoaded, user])

  useEffect(() => {
    localStorage.setItem('fds-edit-draft', JSON.stringify(editForm))
  }, [editForm])

  const generatedSummary = useMemo(() => {
    if (!files.length) return 'No files generated yet.'
    return `${files.length} file${files.length === 1 ? '' : 's'} ready: ${files.map((f) => f.path).join(', ')}`
  }, [files])

  function updateActiveKb(patch: Partial<KnowledgeBaseDraft>) {
    const id = activeKb?.id
    if (!id) return
    setKbs((current) => current.map((kb) => (kb.id === id ? { ...kb, ...patch, updatedAt: nowIso() } : kb)))
  }

  function updateActiveForm(form: PublishForm) {
    const changedGeneratedContract =
      form.title !== activeKb.title ||
      form.slug !== activeKb.slug ||
      form.owner !== activeKb.owner ||
      form.customDomain !== activeKb.customDomain ||
      form.prompt !== activeKb.prompt
    updateActiveKb({
      ...form,
      ...(changedGeneratedContract
        ? {
            files: [],
            liveUrl: '',
            repoUrl: '',
            lastStatus: 'Draft changed',
            steps: cloneSteps(),
          }
        : {}),
    })
  }

  function setKbSteps(id: string, updater: PublishStep[] | ((current: PublishStep[]) => PublishStep[])) {
    setKbs((current) =>
      current.map((kb) =>
        kb.id === id
          ? { ...kb, steps: typeof updater === 'function' ? updater(kb.steps) : updater, updatedAt: nowIso() }
          : kb,
      ),
    )
  }

  function setKbPatch(id: string, patch: Partial<KnowledgeBaseDraft>) {
    setKbs((current) => current.map((kb) => (kb.id === id ? { ...kb, ...patch, updatedAt: nowIso() } : kb)))
  }

  function createNewKb() {
    const owner = activeKb?.owner || starterPublish.owner
    const next = createKnowledgeBase({
      ...starterPublish,
      title: 'Untitled Knowledge Base',
      slug: nextAvailableSlug(kbs, 'new-knowledge-base'),
      owner,
      customDomain: '',
      prompt: '',
    })
    setKbs((current) => [next, ...current])
    setActiveKbId(next.id)
    navigate('publish')
    setActivePreview('files')
    setStatus('New KB draft ready')
  }

  function duplicateActiveKb() {
    if (!activeKb) return
    const copy = createKnowledgeBase({
      ...toPublishForm(activeKb),
      title: `${activeKb.title} Copy`,
      slug: nextAvailableSlug(kbs, `${activeKb.slug}-copy`),
      customDomain: '',
    })
    setKbs((current) => [copy, ...current])
    setActiveKbId(copy.id)
    navigate('publish')
    setActivePreview('files')
    setStatus('KB draft duplicated')
  }

  function deleteActiveKb() {
    if (!activeKb || kbs.length === 1) return
    const next = kbs.filter((kb) => kb.id !== activeKb.id)
    setKbs(next)
    setActiveKbId(next[0].id)
    setActivePreview('files')
    setStatus('KB draft removed')
  }

  async function generateFiles() {
    if (!activeKb) return
    const kbId = activeKb.id
    const form = toPublishForm(activeKb)
    setBusy(true)
    setStatus('Generating Zensical KB files')
    setKbSteps(kbId, resetSteps('plan', 'busy'))
    setKbPatch(kbId, { lastStatus: 'Generating files' })
    try {
      validatePublishForm(form)
      validatePlatformAccess(user)
      const active = usableSettings()
      validateAi(active)
      setKbSteps(kbId, updateStep('plan', 'ok', 'Zensical contract ready'))
      setKbSteps(kbId, updateStep('ai', 'busy', 'Asking AI for source files'))
      const { files: nextFiles, usage } = await generateKbFiles(active, form)
      setLastUsage(usage)
      validateKbFiles(nextFiles)
      setKbPatch(kbId, { files: nextFiles, lastStatus: 'Files generated' })
      setActivePreview('files')
      setKbSteps(kbId, updateStep('ai', 'ok', `${nextFiles.length} files generated`))
      setStatus('Files generated. Review, then publish.')
    } catch (error) {
      setStatus(messageOf(error))
      setKbPatch(kbId, { lastStatus: messageOf(error) })
      setKbSteps(kbId, markCurrentError)
    } finally {
      setBusy(false)
    }
  }

  async function publishToGitHub() {
    if (!activeKb) return
    const kbId = activeKb.id
    const form = toPublishForm(activeKb)
    setBusy(true)
    setStatus('Publishing KB repo')
    setKbPatch(kbId, { lastStatus: 'Publishing' })
    try {
      let readyFiles = activeKb.files
      if (!readyFiles.length) {
        validatePublishForm(form)
        validatePlatformAccess(user)
        const active = usableSettings()
        validateAi(active)
        setKbSteps(kbId, resetSteps('plan', 'busy'))
        setKbSteps(kbId, updateStep('plan', 'ok', 'Zensical contract ready'))
        setKbSteps(kbId, updateStep('ai', 'busy', 'Asking AI for source files'))
        const generated = await generateKbFiles(active, form)
        setLastUsage(generated.usage)
        readyFiles = generated.files
        validateKbFiles(readyFiles)
        setKbPatch(kbId, { files: readyFiles })
        setKbSteps(kbId, updateStep('ai', 'ok', `${readyFiles.length} files generated`))
      }
      validatePublishForm(form)
      validateKbFiles(readyFiles)
      validatePlatformAccess(user)

      setKbSteps(kbId, updateStep('repo', 'busy', 'Publishing through the platform'))
      const result = await app.publishKb({
        title: form.title,
        slug: form.slug,
        owner: form.owner,
        customDomain: form.customDomain || undefined,
        description: form.prompt,
        files: readyFiles,
      })
      for (const step of result.steps) {
        setKbSteps(kbId, updateStep(step.id, step.ok ? 'ok' : 'error', step.detail))
      }
      const failed = result.steps.find((step) => !step.ok)
      if (failed) throw new Error(failed.detail)

      setKbPatch(kbId, { repoUrl: result.repoUrl, liveUrl: result.liveUrl, lastStatus: 'Published' })
      setKbSteps(kbId, updateStep('deploy', 'ok', 'Workflow started on GitHub'))
      setStatus('Published. GitHub Actions is building the Zensical site.')
      window.open(`${result.repoUrl}/actions`, '_blank', 'noopener,noreferrer')
    } catch (error) {
      setStatus(messageOf(error))
      setKbPatch(kbId, { lastStatus: messageOf(error) })
      setKbSteps(kbId, markCurrentError)
    } finally {
      setBusy(false)
    }
  }

  async function loadSource(formOverride?: EditForm) {
    const form = formOverride ?? editForm
    setBusy(true)
    setStatus('Loading source')
    try {
      validatePlatformAccess(user)
      const content = await readGitHubFile(form.repo, form.path, form.branch)
      setSource(content)
      setProposal(null)
      setDiff('Source loaded. Ask AI for a proposal.')
      setActivePreview('source')
      setStatus('Source loaded')
      if (editKbId) {
        loadedEditKey.current = `${editKbId}:${form.path}`
        replaceLocation({ route: 'edit', kbId: editKbId, file: form.path })
      }
    } catch (error) {
      const message = messageOf(error)
      setStatus(message)
      setSource(`Could not load ${form.repo}/${form.path}\n\n${message}\n\nIf this is a 404/403, the FreeDocStore GitHub App may not have access to this repo — check that it's installed on the org with Contents read/write.`)
      setActivePreview('source')
    } finally {
      setBusy(false)
    }
  }

  async function askForEditProposal() {
    setBusy(true)
    setStatus('Asking AI for proposal')
    const active = usableSettings()
    try {
      validatePlatformAccess(user)
      validateAi(active)
      const current = source || (await readGitHubFile(editForm.repo, editForm.path, editForm.branch))
      setSource(current)
      const { proposal: next, usage } = await generateEditProposal(active, editForm, current)
      setLastUsage(usage)
      setProposal(next)
      setDiff(buildLineDiff(current, next.content))
      setActivePreview('diff')
      setStatus('Proposal ready')
    } catch (error) {
      const message = messageOf(error)
      setStatus(message)
      setProposal(null)
      setDiff(`AI request failed — ${AI_PROVIDERS[active.provider].label}\n\n${message}`)
      setActivePreview('diff')
    } finally {
      setBusy(false)
    }
  }

  async function applyProposal(mode: 'pr' | 'direct') {
    if (!proposal) return
    setBusy(true)
    setStatus(mode === 'pr' ? 'Opening a pull request' : 'Committing to the base branch')
    try {
      validatePlatformAccess(user)
      const result = await app.editFile({
        repo: editForm.repo,
        path: editForm.path,
        content: proposal.content,
        message: proposal.summary || `Update ${editForm.path} via FreeDocStore`,
        mode,
        branch: editForm.branch,
      })
      const link = result.prUrl || result.commitUrl
      setSource(proposal.content)
      setProposal(null)
      setDiff(mode === 'pr' ? `Opened PR #${result.prNumber}. Merge it to publish.` : 'Committed to the base branch. GitHub Actions will redeploy.')
      setStatus(result.prUrl ? `Opened PR #${result.prNumber}` : 'Committed to the base branch')
      if (link) window.open(link, '_blank', 'noopener,noreferrer')
    } catch (error) {
      setStatus(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  function aiReady(secretsObj: SecretStatus, provider: Settings['provider']): boolean {
    if (AI_PROVIDERS[provider].free) return true
    return !!secretsObj[provider as 'openai' | 'anthropic']?.configured
  }

  /**
   * If the chosen provider isn't usable (BYOK with no saved key), pick one that is:
   * a BYOK provider you have a key for, else the free GitHub Models tier.
   */
  function usableSettings(): Settings {
    if (aiReady(secrets, settings.provider)) return settings
    const configured = BYOK_PROVIDER_IDS.find((id) => secrets[id]?.configured)
    const target: Settings['provider'] = configured ?? 'github'
    const next: Settings = { ...settings, provider: target, model: AI_PROVIDERS[target].defaultModel }
    setSettings(next)
    setStatus(
      configured
        ? `Using ${AI_PROVIDERS[target].label} — the provider you have a key for.`
        : `No key for ${AI_PROVIDERS[settings.provider].label}; using the free GitHub Models tier.`,
    )
    return next
  }

  async function refreshSecrets() {
    const next = await app.secrets.get()
    setSecrets(next)
    // If the saved provider is a BYOK one with no key, but a different key exists,
    // switch to it so the UI reflects the provider you can actually use.
    if (!AI_PROVIDERS[settings.provider].free && !next[settings.provider as 'openai' | 'anthropic']?.configured) {
      const configured = BYOK_PROVIDER_IDS.find((id) => next[id]?.configured)
      if (configured) setSettings((s) => ({ ...s, provider: configured, model: AI_PROVIDERS[configured].defaultModel }))
    }
    const ready = aiReady(next, settings.provider)
    setConnections((current) => ({
      ...current,
      ai: ready ? current.ai : 'needs-setup',
      detail: ready
        ? current.detail
        : `${AI_PROVIDERS[settings.provider].label} generation uses your BYOK key. Save it once in your FreeDocStore account before prompting KBs.`,
    }))
  }

  async function saveKey(provider: ByokProvider) {
    const value = keyInputs[provider].trim()
    if (!value) {
      setStatus(`Paste your ${AI_PROVIDERS[provider].label} API key before saving.`)
      return
    }
    setBusy(true)
    setStatus(`Saving ${AI_PROVIDERS[provider].label} BYOK key`)
    try {
      const next = await app.secrets.setKey(provider, value)
      setSecrets(next)
      setKeyInputs((current) => ({ ...current, [provider]: '' }))
      // Saving a key means you want to use it — switch the AI provider to it.
      setSettings((current) => ({ ...current, provider, model: AI_PROVIDERS[provider].defaultModel }))
      setConnections((current) => ({ ...current, ai: 'unchecked', detail: `${AI_PROVIDERS[provider].label} is now your AI provider. Ask AI will use your key.` }))
      setStatus(`${AI_PROVIDERS[provider].label} key saved — now your AI provider`)
    } catch (error) {
      setStatus(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  async function clearKey(provider: ByokProvider) {
    setBusy(true)
    setStatus(`Removing ${AI_PROVIDERS[provider].label} BYOK key`)
    try {
      const next = await app.secrets.clearKey(provider)
      setSecrets(next)
      setConnections((current) => ({ ...current, ai: aiReady(next, settings.provider) ? current.ai : 'needs-setup' }))
      setStatus(`${AI_PROVIDERS[provider].label} BYOK key removed`)
    } catch (error) {
      setStatus(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  async function checkConnections() {
    const provider = settings.provider
    const free = !!AI_PROVIDERS[provider].free
    setConnections({ ...initialConnections, github: 'checking', ai: aiReady(secrets, provider) ? 'checking' : 'needs-setup' })
    setStatus('Checking platform connections')
    try {
      validatePlatformAccess(user)
      const github = await app.proxy.fetch('api.github.com/user', { headers: githubHeaders() })
      let currentSecrets = secrets
      if (!aiReady(currentSecrets, provider)) {
        currentSecrets = await app.secrets.get()
        setSecrets(currentSecrets)
      }
      const label = AI_PROVIDERS[provider].label
      const ready = aiReady(currentSecrets, provider)
      const ai = ready ? await pingAi(settings) : null
      setConnections({
        github: github.ok ? 'ready' : 'needs-setup',
        ai: ai?.ok ? 'ready' : 'needs-setup',
        cloudflare: 'ready',
        detail: ai?.ok && github.ok
          ? `Connections are ready. GitHub uses platform OAuth/proxy and ${label} ${free ? 'runs on your GitHub sign-in' : 'uses your BYOK key'}.`
          : ready
            ? `GitHub ${github.status}; ${label} check failed. ${ai?.error || 'Check your account/key.'}`
            : `GitHub ${github.status}; ${label} needs your BYOK key in Profile → API keys.`,
      })
      setStatus(github.ok && ai?.ok ? 'Platform connections ready' : 'Some platform connections need setup')
    } catch (error) {
      setConnections({ github: 'error', ai: aiReady(secrets, provider) ? 'error' : 'needs-setup', cloudflare: 'ready', detail: messageOf(error) })
      setStatus(messageOf(error))
    }
  }

  useEffect(() => {
    if (!user || !platformLoaded || connectionCheckStarted.current) return
    connectionCheckStarted.current = true
    checkConnections()
  }, [platformLoaded, user])

  if (authLoading) return <LoadingScreen />
  if (!user) return <SignedOutLanding signIn={signIn} />

  // 'files' is a publish-only preview tab; never let it leak into the edit view.
  const editPreview = activePreview === 'files' ? 'source' : activePreview

  const content = route === 'dashboard' ? (
    <DashboardPage
      kbs={kbs}
      activeId={activeKb?.id ?? ''}
      onSelect={(id) => {
        setActiveKbId(id)
        setActivePreview('files')
        navigate('publish')
      }}
      onCreate={createNewKb}
      onDuplicate={duplicateActiveKb}
      onDelete={deleteActiveKb}
      onPublish={() => navigate('publish')}
      onEdit={() => navigate('edit')}
      library={library}
      onEditKb={(kb) => goEdit(kb.id)}
    />
  ) : route === 'publish' ? (
    <div className="workspace-grid">
      <section className="panel control-panel">
        <SelectedKbHeader kb={activeKb} onBack={() => navigate('dashboard')} />
        <SettingsPanel
          settings={settings}
          setSettings={setSettings}
          secrets={secrets}
          connections={connections}
          onCheck={checkConnections}
          onOpenProfile={() => navigate('profile')}
          compact
        />
        <PublishPanel
          form={publishForm}
          setForm={updateActiveForm}
          steps={steps}
          busy={busy}
          onGenerate={generateFiles}
          onPublish={publishToGitHub}
          liveUrl={liveUrl}
        />
      </section>
      <section className="panel preview-panel">
        <PreviewTabs active={activePreview} setActive={setActivePreview} hasProposal={!!proposal} publish />
        <FilesPreview files={files} summary={generatedSummary} form={publishForm} />
      </section>
    </div>
  ) : route === 'edit' ? (
    <div className="workspace-grid">
      <section className="panel control-panel">
        <SettingsPanel
          settings={settings}
          setSettings={setSettings}
          secrets={secrets}
          connections={connections}
          onCheck={checkConnections}
          onOpenProfile={() => navigate('profile')}
          compact
        />
        <EditPanel
          form={editForm}
          setForm={setEditForm}
          busy={busy}
          onLoad={() => loadSource()}
          onAsk={askForEditProposal}
          onApply={applyProposal}
          applyMode={settings.applyMode}
          setApplyMode={(mode) => setSettings({ ...settings, applyMode: mode })}
          proposal={proposal}
        />
      </section>
      <section className="panel preview-panel">
        <PreviewTabs active={editPreview} setActive={setActivePreview} hasProposal={!!proposal} hasLive={!!livePageUrl(library, editForm)} />
        <EditPreview
          active={editPreview}
          source={source}
          proposal={proposal}
          diff={diff}
          path={editForm.path}
          liveUrl={livePageUrl(library, editForm)}
          onQuote={(text) => {
            const quoted = text.split('\n').map((line) => `> ${line}`).join('\n')
            setEditForm((current) => ({ ...current, instruction: current.instruction ? `${current.instruction}\n\n${quoted}\n\n` : `${quoted}\n\n` }))
            setStatus('Quoted selection into the change request')
          }}
        />
      </section>
    </div>
  ) : (
    <ProfilePage
      settings={settings}
      setSettings={setSettings}
      secrets={secrets}
      keyInputs={keyInputs}
      setKeyInput={(provider, value) => setKeyInputs((current) => ({ ...current, [provider]: value }))}
      onSaveKey={saveKey}
      onClearKey={clearKey}
      connections={connections}
      onCheck={checkConnections}
      kbs={kbs}
      user={user}
      signOut={signOut}
      deleteAccount={deleteAccount}
      subscription={subscription}
      isPro={isPro}
      subLoading={subLoading}
      upgrade={upgrade}
      manageBilling={manageBilling}
      themePreference={preference}
      setThemePreference={setPreference}
      installAvailable={!!installPrompt}
      pwaReady={pwaReady}
      updateAvailable={updateAvailable}
      onInstall={installApp}
      onUpdate={activateUpdate}
    />
  )

  return (
    <div className="app-frame">
      <StoreHeader
        route={route}
        navigate={navigate}
        user={user}
        signOut={signOut}
        pwaReady={pwaReady}
        updateAvailable={updateAvailable}
        onUpdate={activateUpdate}
        themePreference={preference}
        setThemePreference={setPreference}
      />
      <main className="app-shell">
        <div className="status-strip" aria-live="polite">
          <span className={busy ? 'pulse-dot busy' : 'pulse-dot'} />
          <span className="status-strip-text">{status}</span>
          <span className="status-strip-meta">
            <span title="AI model in use">{AI_PROVIDERS[settings.provider].label} · {settings.model}</span>
            {lastUsage && <span title="Tokens used by the last AI call">{lastUsage.total.toLocaleString()} tok</span>}
          </span>
        </div>
        {content}
      </main>
      <MobileTabBar route={route} navigate={navigate} />
    </div>
  )
}

export default App
