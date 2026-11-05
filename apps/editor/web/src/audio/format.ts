export const MAX_AUDIO_BYTES = 12 * 1024 * 1024

export function encodeWav(samples: Float32Array, sampleRate = 24000): ArrayBuffer {
  if (!samples.length || samples.length * 2 + 44 > MAX_AUDIO_BYTES) throw new Error('Audio exceeds the 12 MiB page limit. Split this page before generating narration.')
  const out = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(out)
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, out.byteLength - 8, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), true))
  return out
}

export async function sourceBlobSha(source: string): Promise<string> {
  const content = new TextEncoder().encode(source)
  const header = new TextEncoder().encode(`blob ${content.length}\0`)
  const blob = new Uint8Array(header.length + content.length)
  blob.set(header); blob.set(content, header.length)
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', blob))].map(n => n.toString(16).padStart(2, '0')).join('')
}

export function audioBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}
