import { useEffect, useRef, useState } from 'react'
import { readableBlocks, toChunks } from '../../../../../templates/read-aloud/src/reader.js'
import { renderMarkdown } from '../lib/markdown'
import { audioBase64, sourceBlobSha } from '../audio/format'
import { fds } from '../lib/fds'
import manifest from '../audio/model-manifest.json'
import { inventoryPages, KBQueueManager, type PageInventory, type PageSpec } from '../audio/kb-queue'
import { getStorageStats } from '../audio/checkpoint'
import { listGitHubMarkdownSources, readGitHubFileVersion } from '../services/github'
import { isOpusSupported, prepareNarration, type NarrationFormat } from '../../../../../templates/read-aloud/src/opus-encoder.js'

export function AudioPanel({ repo, branch, path, source }: { repo: string; branch: string; path: string; source: string }) {
  const [status, setStatus] = useState('Generate narration locally, preview it, then publish a reviewed proposal.')
  const [busy, setBusy] = useState(false)
  const [audio, setAudio] = useState<{ data: ArrayBuffer; format: NarrationFormat; url: string; sha: string } | null>(null)
  const [resultUrl, setResultUrl] = useState('')
  const worker = useRef<Worker | null>(null)
  const encoderAbort = useRef<AbortController | null>(null)
  const run = useRef(0)
  const operating = useRef(false)
  const [showKb, setShowKb] = useState(false)
  const [inventory, setInventory] = useState<PageInventory[]>([])
  const [queue] = useState(() => new KBQueueManager())
  const [queueStates, setQueueStates] = useState(queue.getStates())
  const [queueProgress, setQueueProgress] = useState(queue.getProgress())
  const [storage, setStorage] = useState({ usedBytes: 0, limitBytes: 0, available: true })
  const [inventoryBusy, setInventoryBusy] = useState(false)
  useEffect(() => {
    run.current++
    operating.current = false
    encoderAbort.current?.abort(new Error('Narration cancelled.')); encoderAbort.current = null
    worker.current?.terminate(); worker.current = null
    setBusy(false); setAudio(null); setResultUrl('')
    return () => { run.current++; worker.current?.terminate() }
  }, [repo, branch, path, source])
  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio.url) }, [audio])
  useEffect(() => {
    const update = () => { setQueueStates(queue.getStates()); setQueueProgress(queue.getProgress()); void getStorageStats().then(setStorage) }
    queue.addEventListener('change', update)
    update()
    return () => queue.removeEventListener('change', update)
  }, [queue])
  async function loadInventory() {
    setInventoryBusy(true)
    try {
      const sources = await listGitHubMarkdownSources(repo, branch)
      const pages: PageSpec[] = sources.map(item => {
        const heading = item.sourceText.match(/^#\s+(.+)$/m)?.[1]?.trim()
        const frontmatter = item.sourceText.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? ''
        return {
          title: heading || item.path.split('/').pop()!.replace(/\.md$/, ''), slug: item.path, path: item.path,
          sourceText: item.sourceText, sourceVersion: item.sourceVersion,
          disabled: /^audio:\s*(false|disabled)\s*$/im.test(frontmatter),
          verifySourceVersion: () => readGitHubFileVersion(repo, item.path, branch),
          publish: async (data, format, sourceVersion, signal) => {
            const result = await fds.publishAudio({ repo, branch, path: item.path, sourceSha: sourceVersion, audio: audioBase64(data), format, modelRevision: manifest.revision }, signal)
            if (!result.unchanged && !result.prUrl) throw new Error(`No review link was returned for ${item.path}.`)
          },
        }
      })
      setInventory(await inventoryPages(pages))
      setShowKb(true)
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setInventoryBusy(false) }
  }
  function queuePages(pages: PageSpec[]) { queue.enqueue(pages); void queue.start() }
  async function clearPage(entry: PageInventory) {
    if (!window.confirm(`Delete saved audio checkpoints for “${entry.page.title}”?`)) return
    await queue.clearPage(entry.page)
    setInventory(await inventoryPages(inventory.map(row => row.page)))
  }
  async function generate() {
    if (operating.current) return
    operating.current = true
    const mine = ++run.current
    setAudio(null); setResultUrl(''); setBusy(true); setStatus('Preparing local narration…')
    const controller = new AbortController(); encoderAbort.current = controller
    try {
      const root = document.createElement('article')
      // Narrate the article body; YAML frontmatter config is not reader content.
      root.innerHTML = renderMarkdown(source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ''))
      const chunks = toChunks(readableBlocks(root)).map(c => c.text)
      if (!chunks.length || chunks.join('').length > 6000) throw new Error('Choose a page with 1–6,000 spoken characters. Code blocks are excluded.')
      const sha = await sourceBlobSha(source)
      if (mine !== run.current) return
      const next = new Worker(new URL('../audio/worker.ts', import.meta.url), { type: 'module' })
      worker.current = next
      setStatus('Loading the local model…')
      next.onmessage = event => {
        if (mine !== run.current) return
        const data = event.data
        if (data.type === 'progress') setStatus(data.message)
        if (data.type === 'complete') {
          next.terminate(); worker.current = null
          void prepareNarration(data.wav, { signal: controller.signal }).then(prepared => {
            if (mine !== run.current) return
            const mime = prepared.format === 'opus' ? 'audio/ogg; codecs=opus' : 'audio/wav'
            const url = URL.createObjectURL(new Blob([prepared.data], { type: mime }))
            setAudio({ data: prepared.data, format: prepared.format, sha, url })
            const reduction = prepared.format === 'opus' ? ` Opus is ${Math.round((1 - prepared.data.byteLength / data.wav.byteLength) * 100)}% smaller than WAV.` : ''
            setStatus(`${prepared.format === 'opus' ? 'Compact Opus' : 'WAV'} recording ready for preview.${reduction}`)
          }).catch(error => { if (mine === run.current) setStatus(error instanceof Error ? error.message : String(error)) })
            .finally(() => { if (mine === run.current) { setBusy(false); operating.current = false; encoderAbort.current = null } })
        }
        if (data.type === 'error') { setStatus(data.message); setBusy(false); operating.current = false; next.terminate(); worker.current = null }
      }
      next.onerror = () => { if (mine === run.current) { setStatus('The audio worker could not start. Check model downloads and available memory, then retry.'); setBusy(false); operating.current = false; next.terminate(); worker.current = null } }
      next.postMessage({ chunks })
    } catch (error) { if (mine === run.current) { setStatus(String(error)); setBusy(false); operating.current = false; worker.current?.terminate(); worker.current = null } }
  }
  async function publish() {
    if (!audio || operating.current) return
    operating.current = true
    const mine = run.current
    const controller = new AbortController(); encoderAbort.current = controller
    setBusy(true); setStatus('Creating narration proposal…')
    try {
      const result = await fds.publishAudio({ repo, branch, path, sourceSha: audio.sha, audio: audioBase64(audio.data), format: audio.format, modelRevision: manifest.revision }, controller.signal)
      if (mine !== run.current) return
      if (result.unchanged) { setResultUrl(''); setStatus('This recording is already on the base branch. No proposal was needed.'); return }
      if (!result.prUrl) throw new Error('The server did not return a review link.')
      setResultUrl(result.prUrl); setStatus('Narration proposal created. Review and merge it to publish.')
    } catch (error) { if (mine === run.current) setStatus(String(error)) }
    finally { if (mine === run.current) { setBusy(false); operating.current = false; encoderAbort.current = null } }
  }
  return <details className="section-block audio-panel">
    <summary>Page narration</summary>
    <p>English voice · runs on this device. The first generation downloads about 93 MB of model and voice assets plus the speech runtime. Page text stays in your browser during generation.</p>
    <p>Publishing uploads the resulting recording to your public GitHub repository. Audio is offered to readers only while its source version matches.</p>
    <div className="action-row">
      <button type="button" className="secondary-action" disabled={busy || !source || !path.endsWith('.md')} onClick={generate}>Generate audio</button>
      {busy && <button type="button" className="secondary-action" onClick={() => { run.current++; encoderAbort.current?.abort(new Error('Narration cancelled.')); encoderAbort.current = null; worker.current?.terminate(); worker.current = null; setBusy(false); operating.current = false; setStatus('Generation cancelled.') }}>Cancel</button>}
    </div>
    {audio && <><audio controls src={audio.url} aria-label="Narration preview" /><div className="action-row">
      <a className="secondary-action" href={audio.url} download={`narration.${audio.format === 'opus' ? 'opus' : 'wav'}`}>Download {audio.format === 'opus' ? 'Opus' : 'WAV'}</a>
      <button type="button" className="primary-action" disabled={busy} onClick={publish}>Propose audio publication</button>
    </div></>}
    <p role="status" aria-live="polite">{status}</p>
    {resultUrl && <a href={resultUrl} target="_blank" rel="noreferrer">Review narration proposal</a>}
    <section className="kb-recordings">
      <h3>Knowledge base recordings</h3>
      <button type="button" className="secondary-action" disabled={inventoryBusy || !repo} onClick={() => void loadInventory()}>{inventoryBusy ? 'Loading inventory…' : 'Load KB recording inventory'}</button>
      {showKb && <>
        <p>{storage.available ? `Device storage: ${(storage.usedBytes / 1024 / 1024).toFixed(1)} MB / ${(storage.limitBytes / 1024 / 1024).toFixed(0)} MB` : 'Device storage is unavailable.'}</p>
        <div className="action-row">
          <button type="button" className="primary-action" disabled={queueStates.some(item => item.state === 'generating') || !inventory.some(row => row.status !== 'disabled')} onClick={() => queuePages(inventory.filter(row => row.status !== 'disabled').map(row => row.page))}>Generate All</button>
          {queueStates.some(item => item.state === 'generating') && <>
            <button type="button" className="secondary-action" onClick={() => queue.pause()}>Pause</button>
            <button type="button" className="secondary-action" onClick={() => queue.resume()}>Resume</button>
            <button type="button" className="secondary-action" onClick={() => queue.cancel()}>Cancel</button>
          </>}
          <button type="button" className="secondary-action" onClick={async () => {
            if (!window.confirm('Clear all completed audio checkpoints?')) return
            for (const row of inventory) if (row.status === 'current') await queue.clearPage(row.page)
            setInventory(await inventoryPages(inventory.map(row => row.page)))
          }}>Clear completed</button>
        </div>
        {queueStates.length > 0 && <div aria-live="polite">
          <progress value={queueProgress.completed} max={Math.max(queueProgress.total, 1)} />
          <p>{queueProgress.current ? `Generating ${queueProgress.current}` : 'Queue ready'} · {queueProgress.estimatedSecondsRemaining}s remaining ({queueProgress.throughputCalibrated ? 'calibrated' : 'estimated'}) · {queueProgress.reusedChunks} saved chunks reused</p>
          {queueStates.filter(item => item.state === 'failed').map(item => <p key={item.page.slug} role="alert">{item.page.title}: {item.error}</p>)}
        </div>}
        <table><thead><tr><th>Page</th><th>Status</th><th>Last generated</th><th>Size</th><th>Actions</th></tr></thead><tbody>
          {inventory.map(entry => <tr key={entry.page.slug}>
            <td>{entry.page.title}</td><td><span data-status={entry.status}>{entry.status}</span>{entry.error && <small>{entry.error}</small>}</td>
            <td>{entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '—'}</td><td>{entry.fileSize ? `${(entry.fileSize / 1024).toFixed(0)} KB` : '—'}</td>
            <td><button type="button" className="secondary-action" disabled={entry.status === 'disabled' || queueStates.some(item => item.state === 'generating')} onClick={() => {
              if (entry.status === 'stale' && !window.confirm(`${entry.page.title} has a different source version. Regenerate from the currently verified source?`)) return
              queuePages([entry.page])
            }}>Generate</button> <button type="button" className="secondary-action" onClick={() => void clearPage(entry)}>Delete</button></td>
          </tr>)}
        </tbody></table>
      </>}
    </section>
  </details>
}
