export const MAX_OPUS_BYTES = 1_572_864
export const MAX_OPUS_CHUNK_BYTES = 2 * 1024 * 1024

// At about 32 kbps Opus is roughly 240 kB/minute, versus 2.9 MB/minute for mono 24 kHz 16-bit WAV.
export function opusMimeType(Recorder = globalThis.MediaRecorder) {
  if (!Recorder || typeof Recorder.isTypeSupported !== 'function') return null
  const ogg = 'audio/ogg; codecs=opus'
  return Recorder.isTypeSupported(ogg) ? ogg : null
}

export function isOpusSupported(Recorder = globalThis.MediaRecorder) {
  return opusMimeType(Recorder) !== null
}

export function recordOpus(stream, options = {}) {
  const Recorder = options.MediaRecorder ?? globalThis.MediaRecorder
  const mimeType = opusMimeType(Recorder)
  if (!mimeType) throw new Error('This browser cannot record Ogg Opus. WAV recording remains available.')
  const maxChunkBytes = options.maxChunkBytes ?? MAX_OPUS_CHUNK_BYTES
  const maxBytes = options.maxBytes ?? MAX_OPUS_BYTES
  const signal = options.signal
  let recorder
  let settled = false
  let stopped = false
  let total = 0
  let failure
  const chunks = []
  let cancelResolve
  const cancelled = new Promise(resolve => { cancelResolve = resolve })
  let blobResolve
  let blobReject
  const blob = new Promise((resolve, reject) => { blobResolve = resolve; blobReject = reject })
  const cancel = reason => {
    if (settled) return
    failure = reason instanceof Error ? reason : new Error('Opus recording cancelled.')
    cancelResolve()
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    else finish()
  }
  const cleanup = () => signal?.removeEventListener('abort', abort)
  const finish = () => {
    if (settled) return
    settled = true
    cleanup()
    if (failure) blobReject(failure)
    else blobResolve(new Blob(chunks, { type: mimeType }))
    chunks.length = 0
  }
  const abort = () => cancel(signal?.reason)
  if (signal?.aborted) cancel(signal.reason)
  else signal?.addEventListener('abort', abort, { once: true })
  if (!settled) {
    try {
      recorder = new Recorder(stream, { mimeType, audioBitsPerSecond: 32_000 })
      recorder.ondataavailable = event => {
        if (!event.data?.size || failure) return
        if (event.data.size > maxChunkBytes || total + event.data.size > maxBytes) {
          cancel(new Error('The Ogg Opus recording exceeded its size limit. Use WAV or shorten the page.'))
          return
        }
        total += event.data.size
        chunks.push(event.data)
      }
      recorder.onerror = () => cancel(new Error('The browser could not encode this Opus recording.'))
      recorder.onstop = finish
      recorder.start(1000)
    } catch (error) {
      cancel(error)
    }
  }
  return {
    stop() {
      if (settled || stopped) return
      stopped = true
      if (recorder?.state !== 'inactive') recorder.stop()
      else finish()
    },
    cancel: abort,
    cancelled,
    blob,
  }
}

export async function encodeWavAsOpus(wav, { signal, AudioContext: Context = globalThis.AudioContext ?? globalThis.webkitAudioContext } = {}) {
  if (!isOpusSupported()) throw new Error('This browser cannot record Ogg Opus.')
  if (signal?.aborted) throw signal.reason ?? new Error('Opus recording cancelled.')
  if (typeof Context !== 'function') throw new Error('Web Audio is unavailable; publish the compatible WAV recording instead.')
  const context = new Context()
  let source
  let recording
  try {
    const decoded = await context.decodeAudioData(wav.slice(0))
    if (signal?.aborted) throw signal.reason ?? new Error('Opus recording cancelled.')
    const destination = context.createMediaStreamDestination()
    source = context.createBufferSource()
    source.buffer = decoded
    source.connect(destination)
    recording = recordOpus(destination.stream, { signal })
    const completed = new Promise((resolve, reject) => {
      source.onended = () => recording.stop()
      source.onerror = () => reject(new Error('Could not play generated audio into the Opus encoder.'))
    })
    source.start()
    const encoded = await Promise.race([recording.blob, completed.then(() => recording.blob)])
    return encoded
  } finally {
    recording?.cancelled.catch?.(() => {})
    try { source?.stop() } catch { /* Already ended. */ }
    await context.close().catch(() => {})
  }
}

export async function prepareNarration(wav, { signal } = {}) {
  if (!isOpusSupported()) return { data: wav, format: 'wav' }
  const blob = await encodeWavAsOpus(wav, { signal })
  return { data: await blob.arrayBuffer(), format: 'opus' }
}
