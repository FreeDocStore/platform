import {
  Check,
  Copy,
  Download,
  FileText,
  GitPullRequest,
  Github,
  Loader2,
  Sparkles,
} from 'lucide-react'
import {
  type EditForm,
  type Proposal,
  type RegistryKb,
  githubEditUrl,
} from '../model'
import { Field } from './ui'

export function EditPanel({
  form,
  setForm,
  busy,
  onLoad,
  onAsk,
  onApply,
  onSelectLibrary,
  proposal,
  library,
}: {
  form: EditForm
  setForm: (form: EditForm) => void
  busy: boolean
  onLoad: () => void
  onAsk: () => void
  onApply: (mode: 'pr' | 'direct') => void
  onSelectLibrary: (kb: RegistryKb) => void
  proposal: Proposal | null
  library: RegistryKb[]
}) {
  const update = <K extends keyof EditForm>(key: K, value: EditForm[K]) => setForm({ ...form, [key]: value })
  const githubEdit = githubEditUrl(form)
  const selectedKbId = library.find((kb) => kb.source.repo.toLowerCase() === form.repo.trim().toLowerCase())?.id ?? ''
  return (
    <div className="section-block">
      <div className="section-title">
        <FileText size={18} />
        <div>
          <h2>Edit existing Markdown</h2>
          <p>AI drafts a full replacement. Manual edits stay in GitHub.</p>
        </div>
      </div>
      {library.length > 0 && (
        <label className="field">
          <span>Library</span>
          <select
            value={selectedKbId}
            onChange={(event) => {
              const kb = library.find((entry) => entry.id === event.target.value)
              if (kb) onSelectLibrary(kb)
            }}
          >
            <option value="">Pick a published knowledge base…</option>
            {library.map((kb) => (
              <option key={kb.id} value={kb.id}>
                {kb.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="field-grid two">
        <Field label="Repo" value={form.repo} onChange={(v) => update('repo', v)} placeholder="owner/repo" />
        <Field label="Branch" value={form.branch} onChange={(v) => update('branch', v)} />
      </div>
      <Field label="Path" value={form.path} onChange={(v) => update('path', v)} placeholder="docs/index.md" />
      <label className="field">
        <span>Change request</span>
        <textarea value={form.instruction} onChange={(e) => update('instruction', e.target.value)} rows={8} />
      </label>
      <div className="action-row">
        <button className="secondary-action" type="button" onClick={onLoad} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <Download size={17} />}
          Load source
        </button>
        <button className="primary-action" type="button" onClick={onAsk} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
          Ask AI
        </button>
      </div>
      <div className="action-row">
        <button className="primary-action" type="button" disabled={busy || !proposal} onClick={() => onApply('pr')}>
          {busy ? <Loader2 className="spin" size={17} /> : <GitPullRequest size={17} />}
          Propose as PR
        </button>
        <button className="secondary-action" type="button" disabled={busy || !proposal} onClick={() => onApply('direct')}>
          <Check size={17} />
          Commit to branch
        </button>
      </div>
      <p className="edit-apply-hint">
        Applying uses your GitHub sign-in. A PR is reviewable before it publishes; a direct commit deploys on the next build.
      </p>
      <div className="action-row compact-actions">
        <a className="secondary-action as-link" href={githubEdit} target="_blank" rel="noreferrer">
          <Github size={17} />
          Open GitHub editor
        </a>
        <button
          className="secondary-action"
          type="button"
          disabled={!proposal}
          onClick={() => proposal && navigator.clipboard.writeText(proposal.content)}
        >
          <Copy size={17} />
          Copy proposal
        </button>
      </div>
    </div>
  )
}
