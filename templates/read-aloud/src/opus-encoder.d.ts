export type NarrationFormat = 'wav' | 'opus'
export interface PreparedNarration { data: ArrayBuffer; format: NarrationFormat }
export function opusMimeType(Recorder?: typeof MediaRecorder): string | null
export function isOpusSupported(Recorder?: typeof MediaRecorder): boolean
export function recordOpus(stream: MediaStream, options?: { maxChunkBytes?: number; maxBytes?: number; signal?: AbortSignal; MediaRecorder?: typeof MediaRecorder }): {
  stop(): void; cancel(): void; cancelled: Promise<void>; blob: Promise<Blob>
}
export function encodeWavAsOpus(wav: ArrayBuffer, options?: { signal?: AbortSignal; AudioContext?: typeof AudioContext }): Promise<Blob>
export function prepareNarration(wav: ArrayBuffer, options?: { signal?: AbortSignal }): Promise<PreparedNarration>
