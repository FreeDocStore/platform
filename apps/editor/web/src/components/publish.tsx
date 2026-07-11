import {
  BookOpen,
  CheckCircle2,
  ExternalLink,
  LibraryBig,
  Loader2,
  Sparkles,
} from 'lucide-react'
import {
  type KnowledgeBaseDraft,
  type PublishForm,
  type PublishStep,
  normalizeDomain,
  slugify,
} from '../model'
import { Field } from './ui'

export function SelectedKbHeader({ kb, onBack }: { kb: KnowledgeBaseDraft; onBack: () => void }) {
  return (
    <div className="section-block selected-kb">
      <button className="text-action" type="button" onClick={onBack}>
        Console
      </button>
      <div>
        <span>Selected knowledge base</span>
        <strong>{kb.title || 'Untitled KB'}</strong>
        <p>{kb.owner}/{kb.slug}</p>
      </div>
    </div>
  )
}

export function PublishPanel({
  form,
  setForm,
  steps,
  busy,
  onGenerate,
  onPublish,
  liveUrl,
}: {
  form: PublishForm
  setForm: (form: PublishForm) => void
  steps: PublishStep[]
  busy: boolean
  onGenerate: () => void
  onPublish: () => void
  liveUrl: string
}) {
  const update = <K extends keyof PublishForm>(key: K, value: PublishForm[K]) => setForm({ ...form, [key]: value })
  return (
    <div className="section-block">
      <div className="section-title">
        <BookOpen size={18} />
        <div>
          <h2>Publish selected KB</h2>
          <p>Generates a Zensical Markdown repo and deploy workflow.</p>
        </div>
      </div>
      <div className="field-grid two">
        <Field label="Title" value={form.title} onChange={(v) => update('title', v)} />
        <Field label="Slug / Pages project" value={form.slug} onChange={(v) => update('slug', slugify(v))} />
        <Field label="GitHub owner" value={form.owner} onChange={(v) => update('owner', v)} />
        <Field label="Custom domain" value={form.customDomain} onChange={(v) => update('customDomain', normalizeDomain(v))} placeholder="docs.example.com" />
      </div>
      <div className="target-grid">
        <div>
          <span>Pages URL</span>
          <strong>https://{form.slug || 'project'}.pages.dev/</strong>
        </div>
        <div className={form.customDomain ? 'target-domain active' : 'target-domain'}>
          <span>Custom domain</span>
          <strong>{form.customDomain ? `https://${form.customDomain}/` : 'Not attached'}</strong>
        </div>
      </div>
      <label className="field">
        <span>Knowledge-base prompt</span>
        <textarea value={form.prompt} onChange={(e) => update('prompt', e.target.value)} rows={8} />
      </label>
      <div className="inline-choice">
        <button type="button" className={form.visibility === 'public' ? 'choice active' : 'choice'} onClick={() => update('visibility', 'public')}>
          Public
        </button>
        <button type="button" className={form.visibility === 'private' ? 'choice active' : 'choice'} onClick={() => update('visibility', 'private')}>
          Private repo
        </button>
      </div>
      <div className="action-row">
        <button className="secondary-action" type="button" onClick={onGenerate} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
          Generate files
        </button>
        <button className="primary-action" type="button" onClick={onPublish} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <LibraryBig size={17} />}
          Publish repo
        </button>
      </div>
      <div className="steps" aria-label="Publish progress">
        {steps.map((step) => (
          <div className={`step ${step.state}`} key={step.id}>
            <span>{step.state === 'busy' ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}</span>
            <div>
              <strong>{step.label}</strong>
              <p>{step.detail}</p>
            </div>
          </div>
        ))}
      </div>
      {liveUrl && (
        <a className="live-link" href={liveUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={17} />
          Open live KB target
        </a>
      )}
    </div>
  )
}
