import manifest from './model-manifest.json'
import { encodeWav, MAX_AUDIO_BYTES } from './format'

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
  const cached = await cache?.match(pinned)
  const response = cached ?? await nativeFetch(pinned, { credentials: 'omit' })
  if (!response.ok) throw new Error(`Model download failed (${response.status}): ${pathname}`)
  const reader = response.body!.getReader()
  const parts: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > expected.bytes) { await reader.cancel(); throw new Error(`Model download is larger than expected: ${pathname}`) }
    parts.push(value)
    postMessage({ type: 'progress', message: `Loading ${pathname} · ${Math.round(bytes / expected.bytes * 100)}%` })
  }
  const buffer = new Uint8Array(bytes)
  let offset = 0
  for (const part of parts) { buffer.set(part, offset); offset += part.byteLength }
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(n => n.toString(16).padStart(2, '0')).join('')
  if (bytes !== expected.bytes || sha !== expected.sha256) {
    await cache?.delete(pinned)
    throw new Error(`Model integrity check failed: ${pathname}. Try again to download a clean copy.`)
  }
  const verified = new Response(buffer, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes) } })
  if (!cached && cache) { try { await cache.put(pinned, verified.clone()) } catch { /* quota failure must not prevent synthesis */ } }
  return verified
}

let running = false
onmessage = async (event: MessageEvent<{ chunks: string[] }>) => {
  if (running) return
  running = true
  try {
    const chunks = event.data.chunks
    if (!Array.isArray(chunks) || !chunks.length || chunks.join('').length > 6000 || chunks.some(c => typeof c !== 'string' || c.length > 200)) throw new Error('Choose a page with at most 6,000 spoken characters.')
    const [{ KokoroTTS, env }, { env: transformersEnv }] = await Promise.all([import('kokoro-js'), import('@huggingface/transformers')])
    transformersEnv.useBrowserCache = false
    transformersEnv.allowLocalModels = false
    transformersEnv.backends.onnx.wasm!.numThreads = 1
    env.wasmPaths = new URL('/audio-runtime/', self.location.origin).href
    // The library has a separate voice cache; discard it so the voice passes the same integrity check.
    try { await caches.delete('kokoro-voices') } catch { /* optional cache */ }
    const tts = await KokoroTTS.from_pretrained(manifest.model, { dtype: 'q8', device: 'wasm' })
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
