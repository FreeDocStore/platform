interface Asset { bytes: number; sha256: string }
interface DownloadOptions {
  fetch: typeof fetch
  cache?: Pick<Cache, 'match' | 'put' | 'delete'>
  progress?: (percent: number) => void
  timeoutMs?: number
}

/** Verify immutable assets even when read from a browser-managed cache. */
export async function verifiedDownload(url: string, asset: Asset, options: DownloadOptions): Promise<Response> {
  const { cache } = options
  let cached: Response | undefined
  try { cached = await cache?.match(url) } catch { /* Optional cache access can be denied. */ }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 180_000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancelRead = () => { void reader?.cancel().catch(() => {}) }
  controller.signal.addEventListener('abort', cancelRead, { once: true })
  try {
    const response = cached ?? await options.fetch(url, { credentials: 'omit', signal: controller.signal })
    if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status})`)
    reader = response.body.getReader()
    // The manifest size bounds memory without keeping a second array of chunks.
    const buffer = new Uint8Array(asset.bytes)
    let bytes = 0
    let percent = -1
    while (true) {
      const { done, value } = await reader.read()
      controller.signal.throwIfAborted()
      if (done) break
      if (bytes + value.byteLength > buffer.length) throw new Error('Model download is larger than expected')
      buffer.set(value, bytes)
      bytes += value.byteLength
      const next = Math.round(bytes / asset.bytes * 100)
      if (next !== percent) { percent = next; options.progress?.(next) }
    }
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(n => n.toString(16).padStart(2, '0')).join('')
    if (bytes !== asset.bytes || sha !== asset.sha256) throw new Error('Model integrity check failed. Retry to download a clean copy.')
    const verified = new Response(buffer, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes) } })
    if (!cached && cache) {
      try { await cache.put(url, verified.clone()) } catch { /* Cache quota must not prevent synthesis. */ }
    }
    return verified
  } catch (error) {
    controller.abort()
    try { await reader?.cancel() } catch { /* Preserve the original error. */ }
    if (cached) {
      try { await cache?.delete(url) } catch { /* Cache failures must not hide integrity errors. */ }
    }
    throw error
  } finally {
    clearTimeout(timeout)
    controller.signal.removeEventListener('abort', cancelRead)
    reader?.releaseLock()
  }
}
