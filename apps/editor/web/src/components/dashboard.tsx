import {
  BookOpen,
  Copy,
  Github,
  Globe2,
  LayoutDashboard,
  LibraryBig,
  PenLine,
  Plus,
  Trash2,
} from 'lucide-react'
import { type KnowledgeBaseDraft, type RegistryKb, liveTargetFor } from '../model'

export function DashboardPage({
  kbs,
  activeId,
  onSelect,
  onCreate,
  onDuplicate,
  onDelete,
  onPublish,
  onEdit,
  library,
  onEditKb,
}: {
  kbs: KnowledgeBaseDraft[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onDuplicate: () => void
  onDelete: () => void
  onPublish: () => void
  onEdit: () => void
  library: RegistryKb[]
  onEditKb: (kb: RegistryKb) => void
}) {
  const published = kbs.filter((kb) => registryEntryFor(library, kb)).length
  return (
    <div className="dashboard-grid">
      <section className="panel">
        <KnowledgeBaseShelf
          kbs={kbs}
          activeId={activeId}
          onSelect={onSelect}
          onCreate={onCreate}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          library={library}
        />
      </section>
      <section className="panel">
        <div className="section-block">
          <div className="section-title">
            <LayoutDashboard size={18} />
            <div>
              <h2>Workspace</h2>
              <p>Prompt, publish, and manage the KBs saved to your FreeDocStore account.</p>
            </div>
          </div>
          <div className="metric-grid">
            <div><span>Drafts</span><strong>{kbs.length}</strong></div>
            <div><span>Published</span><strong>{published}</strong></div>
            <div><span>Selected</span><strong>{kbs.find((kb) => kb.id === activeId)?.slug ?? 'None'}</strong></div>
          </div>
          <div className="action-row">
            <button className="primary-action" type="button" onClick={onPublish}>
              <LibraryBig size={17} />
              Prompt a KB
            </button>
            <button className="secondary-action" type="button" onClick={onEdit}>
              <PenLine size={17} />
              Edit existing docs
            </button>
          </div>
        </div>
        <div className="section-block">
          <div className="section-title">
            <LibraryBig size={18} />
            <div>
              <h2>Published library</h2>
              <p>Public knowledge bases in the FreeDocStore registry. Select one to edit it with AI.</p>
            </div>
          </div>
          <div className="kb-list" aria-label="Published knowledge bases">
            {library.map((kb) => (
              <article className="kb-card" key={kb.id}>
                <button className="kb-card-main" type="button" onClick={() => onEditKb(kb)}>
                  <span className="kb-card-title">{kb.title}</span>
                  <span className="kb-card-meta">{kb.source.repo}</span>
                  <span className="kb-card-status">Published</span>
                </button>
                <div className="kb-card-links">
                  {kb.cloudflare?.production_url && (
                    <a href={kb.cloudflare.production_url} target="_blank" rel="noreferrer" aria-label={`${kb.title} live site`}>
                      <Globe2 size={15} />
                    </a>
                  )}
                  <a href={`https://github.com/${kb.source.repo}`} target="_blank" rel="noreferrer" aria-label={`${kb.title} GitHub repository`}>
                    <Github size={15} />
                  </a>
                </div>
              </article>
            ))}
            {library.length === 0 && <p className="kb-card-meta">Registry is loading or unavailable.</p>}
          </div>
        </div>
      </section>
    </div>
  )
}

function registryEntryFor(library: RegistryKb[], draft: KnowledgeBaseDraft): RegistryKb | undefined {
  const repo = `${draft.owner}/${draft.slug}`.toLowerCase()
  return library.find((kb) => kb.source.repo.toLowerCase() === repo)
}

export function KnowledgeBaseShelf({
  kbs,
  activeId,
  onSelect,
  onCreate,
  onDuplicate,
  onDelete,
  library,
}: {
  kbs: KnowledgeBaseDraft[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onDuplicate: () => void
  onDelete: () => void
  library: RegistryKb[]
}) {
  return (
    <div className="section-block kb-shelf">
      <div className="section-title split-title">
        <div className="title-row">
          <BookOpen size={18} />
          <div>
            <h2>Drafts</h2>
            <p>{kbs.length} draft{kbs.length === 1 ? '' : 's'} in your workspace</p>
          </div>
        </div>
        <button className="icon-action" type="button" onClick={onCreate} aria-label="Create KB">
          <Plus size={18} />
        </button>
      </div>
      <div className="kb-list" aria-label="Knowledge base drafts">
        {kbs.map((kb) => {
          const active = kb.id === activeId
          const registered = registryEntryFor(library, kb)
          const target = registered?.cloudflare?.production_url ?? liveTargetFor(kb)
          return (
            <article className={active ? 'kb-card active' : 'kb-card'} key={kb.id}>
              <button className="kb-card-main" type="button" onClick={() => onSelect(kb.id)}>
                <span className="kb-card-title">{kb.title || 'Untitled KB'}</span>
                <span className="kb-card-meta">{kb.owner}/{kb.slug}</span>
                <span className="kb-card-status">{registered ? 'Published' : kb.lastStatus || 'Draft'}</span>
              </button>
              <div className="kb-card-links">
                <a href={target} target="_blank" rel="noreferrer" aria-label={`${kb.title} live target`}>
                  <Globe2 size={15} />
                </a>
                {(kb.repoUrl || registered) && (
                  <a
                    href={kb.repoUrl || `https://github.com/${registered!.source.repo}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${kb.title} GitHub repository`}
                  >
                    <Github size={15} />
                  </a>
                )}
              </div>
            </article>
          )
        })}
      </div>
      <div className="action-row compact-actions">
        <button className="secondary-action" type="button" onClick={onDuplicate}>
          <Copy size={17} />
          Duplicate
        </button>
        <button className="secondary-action danger-action" type="button" onClick={onDelete} disabled={kbs.length === 1}>
          <Trash2 size={17} />
          Delete
        </button>
      </div>
    </div>
  )
}
