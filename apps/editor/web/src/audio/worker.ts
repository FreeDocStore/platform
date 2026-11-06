import manifest from './model-manifest.json'
import { encodeWav, MAX_AUDIO_BYTES } from './format'
import { verifiedDownload } from './download'

// Only immutable public assets leave the worker. Page text is used in local inference.
const nativeFetch = globalThis.fetch.bind(globalThis)
const prefix = `https://huggingface.co/${manifest.model}/resolve/`
const assets = manifest.files as Record<string, { bytes: number; sha256: string }>
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith(prefix)) return nativeFetch(input, init)
  const pathname = url.slice(prefix.length).split('/').slice(1).join('/').split('?')[0]
  const expected = assets[pathname]
  if (!expected) return new Response('Not in the pinned model manifest', { status: 404 })
  const pinned = `${prefix}${manifest.revision}/${pathname}`
  let cache: Cache | undefined
  try { cache = await caches.open('fds-audio-model-v1') } catch { /* generation also works without persistent cache */ }
  return verifiedDownload(pinned, expected, {
    fetch: nativeFetch, cache,
    progress: percent => postMessage({ type: 'progress', message: `Loading ${pathname} · ${percent}%` }),
  })
}

let running = false
let ttsPromise: Promise<any> | undefined
async function loadTts() {
  if (!ttsPromise) ttsPromise = (async () => {
    const [{ KokoroTTS, env }, { env: transformersEnv }] = await Promise.all([import('kokoro-js'), import('@huggingface/transformers')])
    transformersEnv.useBrowserCache = false
    transformersEnv.allowLocalModels = false
    transformersEnv.backends.onnx.wasm!.numThreads = 1
    env.wasmPaths = new URL('/audio-runtime/', self.location.origin).href
    try { await caches.delete('kokoro-voices') } catch { /* optional cache */ }
    return KokoroTTS.from_pretrained(manifest.model, { dtype: 'q8', device: 'wasm' })
  })()
  return ttsPromise
}
onmessage = async (event: MessageEvent<{ chunks?: string[]; chunk?: string; chunkIndex?: number }>) => {
  if (running) return
  running = true
  try {
    if (typeof event.data.chunk === 'string') {
      const tts = await loadTts()
      postMessage({ type: 'progress', message: 'Generating audio chunk' })
      const result = await tts.generate(event.data.chunk, { voice: 'af_heart' })
      const wav = encodeWav(result.audio as Float32Array)
      postMessage({ type: 'chunk-complete', chunkIndex: event.data.chunkIndex, wav }, { transfer: [wav] })
      return
    }
    const chunks = event.data.chunks
    if (!Array.isArray(chunks) || !chunks.length || chunks.join('').length > 6000 || chunks.some(c => typeof c !== 'string' || c.length > 200)) throw new Error('Choose a page with at most 6,000 spoken characters.')
    const tts = await loadTts()
    const parts: Float32Array[] = []
    let length = 0
    for (let i = 0; i < chunks.length; i++) {
      postMessage({ type: 'progress', message: `Generating sentence ${i + 1} of ${chunks.length}` })
      const audio = await tts.generate(chunks[i], { voice: 'af_heart' })
      const samples = audio.audio as Float32Array
      length += samples.length
      if (length * 2 + 44 > MAX_AUDIO_BYTES) throw new Error('Narration exceeds 12 MiB. Split this page into shorter pages.')
      parts.push(samples)
    }
    const samples = new Float32Array(length)
    let offset = 0
    for (const part of parts) { samples.set(part, offset); offset += part.length }
    const wav = encodeWav(samples)
    postMessage({ type: 'complete', wav, revision: manifest.revision }, { transfer: [wav] })
  } catch (error) {
    postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally { running = false }
}
