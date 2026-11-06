import manifest from './model-manifest.json'
import { clearCheckpoints, deleteCheckpoint, listCheckpoints, loadChunk, saveChunk, saveFailure } from './checkpoint'
import { readableBlocks, toChunks } from '../../../../../templates/read-aloud/src/reader.js'
import { renderMarkdown } from '../lib/markdown'
import { encodeWav } from './format'
import { prepareNarration, type NarrationFormat } from '../../../../../templates/read-aloud/src/opus-encoder.js'

export const AUDIO_VOICE = 'af_heart'
export type RecordingStatus = 'current' | 'missing' | 'stale' | 'disabled' | 'failed'
export type QueuePageState = 'pending' | 'generating' | 'done' | 'failed' | 'cancelled'
export interface PageSpec { title: string; slug: string; path: string; sourceText: string; sourceVersion: string; disabled?: boolean; verifySourceVersion?: () => Promise<string>; publish?: (audio: ArrayBuffer, format: NarrationFormat, sourceVersion: string, signal: AbortSignal) => Promise<void> }
export interface PageInventory { page: PageSpec; status: RecordingStatus; chunksComplete: number; chunksTotal: number; updatedAt?: number; fileSize: number; error?: string }
export interface QueueProgress { total: number; completed: number; reusedChunks: number; current: string | null; estimatedSecondsRemaining: number; throughputCalibrated: boolean }
export interface QueueState { page: PageSpec; state: QueuePageState; error?: string }
type GenerateChunk = (text: string, index: number, page: PageSpec) => Promise<ArrayBuffer>

const throughputKey = 'fds:audio:throughput:v1'
const PAGE_KEY = 'fds-audio-page:'
export function checkpointPrefix(page: PageSpec) { return `${PAGE_KEY}${encodeURIComponent(page.slug)}|` }
export function chunkKey(page: PageSpec, index: number) { return `${checkpointPrefix(page)}${page.sourceVersion}:${manifest.revision}:${AUDIO_VOICE}:${index}` }
export function chunksFor(sourceText: string): string[] {
  const root = document.createElement('article')
  root.innerHTML = renderMarkdown(sourceText.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ''))
  return toChunks(readableBlocks(root)).map(chunk => chunk.text)
}

function pcmSamples(wav: ArrayBuffer): Int16Array {
  const view = new DataView(wav)
  if (wav.byteLength < 46 || view.getUint32(24, true) !== 24000 || view.getUint16(34, true) !== 16) throw new Error('A generated narration chunk had an unsupported audio format.')
  return new Int16Array(wav.slice(44))
}
export function combineWav(chunks: ArrayBuffer[]): ArrayBuffer {
  const data = chunks.map(pcmSamples)
  const count = data.reduce((n, chunk) => n + chunk.length, 0)
  const floats = new Float32Array(count)
  let offset = 0
  for (const chunk of data) { for (let i = 0; i < chunk.length; i++) floats[offset + i] = chunk[i] / (chunk[i] < 0 ? 32768 : 32767); offset += chunk.length }
  return encodeWav(floats)
}

function browserGenerator(): GenerateChunk {
  let worker: Worker | null = null
  let pending: { resolve: (value: ArrayBuffer) => void; reject: (error: Error) => void } | null = null
  const getWorker = () => {
    if (worker) return worker
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = event => {
      if (event.data.type === 'progress') return
      if (event.data.type === 'chunk-complete') pending?.resolve(event.data.wav)
      if (event.data.type === 'error') pending?.reject(new Error(event.data.message))
      pending = null
    }
    worker.onerror = () => { pending?.reject(new Error('The audio worker could not start.')); pending = null; worker?.terminate(); worker = null }
    return worker
  }
  return (text, index) => new Promise((resolve, reject) => {
    pending = { resolve, reject }
    getWorker().postMessage({ chunk: text, chunkIndex: index })
  })
}

export async function inventoryPages(pages: PageSpec[]): Promise<PageInventory[]> {
  const entries = await listCheckpoints()
  return pages.map(page => {
    const prefix = checkpointPrefix(page)
    const related = entries.filter(entry => entry.key.startsWith(prefix))
    const chunks = chunksFor(page.sourceText)
    const exactPrefix = `${chunkKey(page, 0).replace(/0$/, '')}`
    const exact = related.filter(entry => entry.key.startsWith(exactPrefix))
    const done = exact.filter(entry => entry.status === 'complete')
    const failure = exact.find(entry => entry.status === 'failed')
    const old = related.filter(entry => !entry.key.startsWith(exactPrefix))
    let status: RecordingStatus = page.disabled ? 'disabled' : failure ? 'failed' : chunks.length > 0 && done.length >= chunks.length ? 'current' : old.length ? 'stale' : 'missing'
    if (page.disabled) status = 'disabled'
    return { page, status, chunksComplete: done.length, chunksTotal: chunks.length, updatedAt: done.reduce((latest, item) => Math.max(latest, item.updatedAt), 0) || undefined, fileSize: done.reduce((sum, item) => sum + item.bytes, 0), error: failure?.error }
  })
}

export class KBQueueManager extends EventTarget {
  private queue: QueueState[] = []
  private paused = false
  private cancelled = false
  private activeController?: AbortController
  private wake?: () => void
  private current: string | null = null
  private measured: number[] = []
  private completedChunks = 0
  private totalChunks = 0
  private reusedChunks = 0
  private readonly generateChunk: GenerateChunk

  constructor(generateChunk?: GenerateChunk) {
    super(); this.generateChunk = generateChunk ?? browserGenerator()
    try { this.measured = JSON.parse(localStorage.getItem(throughputKey) || '[]').filter(Number.isFinite).slice(-20) } catch { /* Defaults remain available without storage. */ }
  }
  enqueue(pages: PageSpec[]) { this.queue = pages.map(page => ({ page, state: 'pending' })); this.completedChunks = 0; this.reusedChunks = 0; this.totalChunks = pages.reduce((sum, page) => sum + chunksFor(page.sourceText).length, 0); this.emit() }
  getStates() { return this.queue.map(item => ({ ...item })) }
  getProgress(): QueueProgress {
    const total = this.totalChunks
    const completed = this.completedChunks
    const remaining = Math.max(0, total - completed)
    const calibrated = this.measured.length >= 3
    const msPerChunk = calibrated ? this.measured.reduce((sum, n) => sum + n, 0) / this.measured.length : 8000
    return { total, completed, reusedChunks: this.reusedChunks, current: this.current, estimatedSecondsRemaining: Math.ceil(remaining * msPerChunk / 1000), throughputCalibrated: calibrated }
  }
  pause() { this.paused = true; this.emit() }
  resume() { this.paused = false; this.wake?.(); this.emit() }
  cancel() { this.cancelled = true; this.paused = false; this.activeController?.abort(new Error('Narration generation cancelled.')); this.wake?.(); for (const item of this.queue) if (item.state === 'pending') item.state = 'cancelled'; this.emit() }
  async start() {
    this.cancelled = false
    for (const item of this.queue) {
      if (this.cancelled) break
      if (item.state === 'done' || item.state === 'cancelled') continue
      this.current = item.page.title; item.state = 'generating'; this.emit()
      const { page } = item
      const controller = new AbortController()
      this.activeController = controller
      try {
        const chunks = chunksFor(page.sourceText)
        if (!chunks.length || chunks.join('').length > 6000) throw new Error('Choose a page with 1–6,000 spoken characters.')
        const existing = await listCheckpoints()
        const prefix = checkpointPrefix(page)
        const currentPrefix = `${chunkKey(page, 0).replace(/0$/, '')}`
        for (const stale of existing) if (stale.key.startsWith(prefix) && !stale.key.startsWith(currentPrefix)) await clearCheckpoints(stale.key)
        await deleteCheckpoint(`${chunkKey(page, 0)}:failure`)
        if (page.verifySourceVersion && await page.verifySourceVersion() !== page.sourceVersion) throw new Error('Source changed since this page was loaded. Reload it before generating.')
        const output: ArrayBuffer[] = []
        for (let index = 0; index < chunks.length; index++) {
          if (this.cancelled) { item.state = 'cancelled'; break }
          while (this.paused && !this.cancelled) await new Promise<void>(resolve => { this.wake = resolve })
          if (this.cancelled) { item.state = 'cancelled'; break }
          const key = chunkKey(page, index)
          const saved = await loadChunk(key)
          if (saved) { output.push(saved); this.completedChunks++; this.reusedChunks++; this.emit(); continue }
          if (page.verifySourceVersion && await page.verifySourceVersion() !== page.sourceVersion) throw new Error('Source changed during generation. Checkpointed audio was preserved.')
          const started = performance.now()
          const result = await this.generateChunk(chunks[index], index, page)
          await saveChunk(key, result)
          output.push(result)
          this.completedChunks++
          const duration = performance.now() - started
          this.measured.push(duration); this.measured = this.measured.slice(-20)
          try { localStorage.setItem(throughputKey, JSON.stringify(this.measured)) } catch { /* Calibration is optional. */ }
          this.emit()
        }
        if (item.state === 'cancelled' || this.cancelled) item.state = 'cancelled'
        else {
          if (page.verifySourceVersion && await page.verifySourceVersion() !== page.sourceVersion) throw new Error('Source changed before publication. Checkpointed audio was preserved.')
          const prepared = await prepareNarration(combineWav(output), { signal: controller.signal })
          if (this.cancelled) item.state = 'cancelled'
          else {
            if (page.publish) await page.publish(prepared.data, prepared.format, page.sourceVersion, controller.signal)
            await deleteCheckpoint(`${chunkKey(page, 0)}:failure`)
            item.state = 'done'
          }
        }
      } catch (error) {
        if (controller.signal.aborted || this.cancelled) item.state = 'cancelled'
        else {
          item.state = 'failed'; item.error = error instanceof Error ? error.message : String(error)
          try { await saveFailure(`${chunkKey(page, 0)}:failure`, item.error) } catch { /* The visible queue still reports the original failure. */ }
        }
      }
      if (this.activeController === controller) this.activeController = undefined
      this.emit()
    }
    this.current = null; this.emit()
  }
  async clearPage(page: PageSpec) { await clearCheckpoints(checkpointPrefix(page)); this.emit() }
  private emit() { this.dispatchEvent(new Event('change')) }
}
