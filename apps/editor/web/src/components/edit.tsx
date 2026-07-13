import {
  Copy,
  Download,
  GitPullRequest,
  Github,
  Loader2,
  Sparkles,
} from 'lucide-react'
import {
  type ApplyMode,
  type EditForm,
  type Proposal,
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
  applyMode,
  setApplyMode,
  proposal,
}: {
  form: EditForm
  setForm: (form: EditForm) => void
  busy: boolean
  onLoad: () => void
  onAsk: () => void
  onApply: (mode: ApplyMode) => void
  applyMode: ApplyMode
  setApplyMode: (mode: ApplyMode) => void
  proposal: Proposal | null
}) {
  const update = <K extends keyof EditForm>(key: K, value: EditForm[K]) => setForm({ ...form, [key]: value })
  const githubEdit = githubEditUrl(form)
  if (!form.repo) {
    return (
      <div className="section-block">
        <p className="empty-hint">Pick a knowledge base from the dashboard library to start editing.</p>
      </div>
    )
  }
  return (
    <div className="section-block">
      <div className="edit-repo-bar">
        <a href={`https://github.com/${form.repo}`} target="_blank" rel="noreferrer">{form.repo}</a>
        <span>· {form.branch}</span>
      </div>
      <div className="field-row">
        <Field label="File" value={form.path} onChange={(v) => update('path', v)} placeholder="docs/index.md" />
        <button className="secondary-action" type="button" onClick={onLoad} disabled={busy}>
          {busy ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
          Load
        </button>
      </div>
      <label className="field">
        <span>Change request</span>
        <textarea value={form.instruction} onChange={(e) => update('instruction', e.target.value)} rows={4} />
      </label>
      <div className="action-row">
        <button className="primary-action" type="button" onClick={onAsk} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
          Ask AI
        </button>
      </div>
      <div className="apply-block">
        <div className="view-toggle apply-mode">
          <button className={applyMode === 'pr' ? 'view-tab active' : 'view-tab'} type="button" onClick={() => setApplyMode('pr')}>
            Reviewed PR
          </button>
          <button className={applyMode === 'direct' ? 'view-tab active' : 'view-tab'} type="button" onClick={() => setApplyMode('direct')}>
            Direct commit
          </button>
        </div>
        <button className="primary-action full-action" type="button" disabled={busy || !proposal} onClick={() => onApply(applyMode)}>
          {busy ? <Loader2 className="spin" size={17} /> : <GitPullRequest size={17} />}
          {applyMode === 'pr' ? 'Apply as pull request' : 'Commit to branch'}
        </button>
      </div>
      <div className="action-row compact-actions">
        <a className="secondary-action as-link" href={githubEdit} target="_blank" rel="noreferrer">
          <Github size={16} />
          GitHub editor
        </a>
        <button
          className="secondary-action"
          type="button"
          disabled={!proposal}
          onClick={() => proposal && navigator.clipboard.writeText(proposal.content)}
        >
          <Copy size={16} />
          Copy
        </button>
      </div>
    </div>
  )
}
