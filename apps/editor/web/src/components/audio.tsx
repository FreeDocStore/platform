import { useEffect, useRef, useState } from 'react'
import { readableBlocks, toChunks } from '../../../../../templates/read-aloud/src/reader.js'
import { renderMarkdown } from '../lib/markdown'
import { audioBase64, sourceBlobSha } from '../audio/format'
import { fds } from '../lib/fds'
import manifest from '../audio/model-manifest.json'

export function AudioPanel({ repo, branch, path, source }: { repo: string; branch: string; path: string; source: string }) {
  const [status, setStatus] = useState('Generate narration locally, preview it, then publish a reviewed proposal.')
  const [busy, setBusy] = useState(false)
  const [audio, setAudio] = useState<{ wav: ArrayBuffer; url: string; sha: string } | null>(null)
  const [resultUrl, setResultUrl] = useState('')
  const worker = useRef<Worker | null>(null)
  const run = useRef(0)
  const operating = useRef(false)
  useEffect(() => {
    run.current++
    operating.current = false
    worker.current?.terminate(); worker.current = null
    setBusy(false); setAudio(null); setResultUrl('')
    return () => { run.current++; worker.current?.terminate() }
  }, [repo, branch, path, source])
  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio.url) }, [audio])
  async function generate() {
    if (operating.current) return
    operating.current = true
    const mine = ++run.current
    setAudio(null); setResultUrl(''); setBusy(true); setStatus('Preparing local narration…')
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
          setAudio({ wav: data.wav, sha, url: URL.createObjectURL(new Blob([data.wav], { type: 'audio/wav' })) })
          setStatus('Preview the narration before publishing.'); setBusy(false); operating.current = false; next.terminate(); worker.current = null
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
    setBusy(true); setStatus('Creating narration proposal…')
    try {
      const result = await fds.publishAudio({ repo, branch, path, sourceSha: audio.sha, audio: audioBase64(audio.wav), modelRevision: manifest.revision })
      if (mine !== run.current) return
      if (result.unchanged) { setResultUrl(''); setStatus('This recording is already on the base branch. No proposal was needed.'); return }
      if (!result.prUrl) throw new Error('The server did not return a review link.')
      setResultUrl(result.prUrl); setStatus('Narration proposal created. Review and merge it to publish.')
    } catch (error) { if (mine === run.current) setStatus(String(error)) }
    finally { if (mine === run.current) { setBusy(false); operating.current = false } }
  }
  return <details className="section-block audio-panel">
    <summary>Page narration</summary>
    <p>English voice · runs on this device. The first generation downloads about 93 MB of model and voice assets plus the speech runtime. Page text stays in your browser during generation.</p>
    <p>Publishing uploads the resulting recording to your public GitHub repository. Audio is offered to readers only while its source version matches.</p>
    <div className="action-row">
      <button type="button" className="secondary-action" disabled={busy || !source || !path.endsWith('.md')} onClick={generate}>Generate audio</button>
      {busy && worker.current && <button type="button" className="secondary-action" onClick={() => { run.current++; worker.current?.terminate(); worker.current = null; setBusy(false); operating.current = false; setStatus('Generation cancelled.') }}>Cancel</button>}
    </div>
    {audio && <><audio controls src={audio.url} aria-label="Narration preview" /><div className="action-row">
      <a className="secondary-action" href={audio.url} download="narration.wav">Download WAV</a>
      <button type="button" className="primary-action" disabled={busy} onClick={publish}>Propose audio publication</button>
    </div></>}
    <p role="status" aria-live="polite">{status}</p>
    {resultUrl && <a href={resultUrl} target="_blank" rel="noreferrer">Review narration proposal</a>}
  </details>
}
