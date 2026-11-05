import { useEffect, useRef, useState } from 'react'
import { fds } from '../lib/fds'
import { githubHeaders, repoApiPath } from '../model'

type Entry = { path: string; type: string }
type Pull = { number: number; title: string; html_url: string }
type Run = { id: number; name: string; status: string; conclusion: string | null; html_url: string }

export function RepositoryPanel({ repo, branch, onFile }: { repo: string; branch: string; onFile: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<Entry[]>([])
  const [pulls, setPulls] = useState<Pull[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [messages, setMessages] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const sequence = useRef(0)
  useEffect(() => {
    const mine = ++sequence.current
    setFiles([]); setPulls([]); setRuns([]); setMessages([])
    if (!open || !repo) return
    setBusy(true)
    const base = `api.github.com/repos/${repoApiPath(repo)}`
    const get = async (path: string) => {
      const res = await fds.proxy.fetch(`${base}${path}`, { headers: githubHeaders() })
      if (!res.ok) {
        const detail = res.status === 403 || res.status === 401 ? 'Check the GitHub connection, repository access, and rate limit.' : res.status === 404 ? 'Check the repository, branch, and GitHub App installation.' : 'Retry or open GitHub to inspect the failure.'
        throw new Error(`HTTP ${res.status}. ${detail}`)
      }
      return res.json()
    }
    void Promise.allSettled([
      get(`/git/trees/${encodeURIComponent(branch || 'main')}?recursive=1`),
      get('/pulls?state=open&per_page=10'),
      get(`/actions/runs?branch=${encodeURIComponent(branch || 'main')}&per_page=5`),
    ]).then(results => {
      if (mine !== sequence.current) return
      const notices: string[] = []
      const [tree, prs, builds] = results
      if (tree.status === 'fulfilled') {
        setFiles((tree.value.tree ?? []).filter((file: Entry) => file.type === 'blob' && /^docs\/.*\.(?:md|mdx|markdown)$/.test(file.path)))
        if (tree.value.truncated) notices.push('The repository tree is truncated. Use GitHub to browse the complete file list.')
      } else notices.push(`Files: ${tree.reason.message}`)
      if (prs.status === 'fulfilled') setPulls(prs.value)
      else notices.push(`Proposals: ${prs.reason.message}`)
      if (builds.status === 'fulfilled') setRuns(builds.value.workflow_runs ?? [])
      else notices.push(`Builds: ${builds.reason.message}`)
      setMessages(notices); setBusy(false)
    })
    return () => { sequence.current++ }
  }, [repo, branch, open, refresh])
  if (!repo) return null
  return <details className="section-block repository-panel" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>Repository files, proposals and builds</summary>
    <button type="button" className="secondary-action" disabled={busy} onClick={() => setRefresh(v => v + 1)}>{busy ? 'Checking GitHub…' : 'Refresh status'}</button>
    {messages.map(message => <p role="status" key={message}>{message}</p>)}
    <label className="field"><span>Open source page</span><select aria-label="Open source page" value="" onChange={e => e.target.value && onFile(e.target.value)}><option value="">Choose a file…</option>{files.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label>
    <h3>Open proposals</h3>
    {!busy && !pulls.length && !messages.some(m => m.startsWith('Proposals:')) && <p>No open proposals.</p>}
    <ul>{pulls.map(pr => <li key={pr.number}><a href={pr.html_url} target="_blank" rel="noreferrer">#{pr.number} {pr.title}</a></li>)}</ul>
    <h3>Recent builds</h3>
    {!busy && !runs.length && !messages.some(m => m.startsWith('Builds:')) && <p>No workflow runs found for this branch.</p>}
    <ul>{runs.map(run => <li key={run.id}><a href={run.html_url} target="_blank" rel="noreferrer">{run.name} · {run.conclusion || run.status}</a></li>)}</ul>
    <a href={`https://github.com/${repo}/actions`} target="_blank" rel="noreferrer">Open build logs on GitHub</a>
  </details>
}
