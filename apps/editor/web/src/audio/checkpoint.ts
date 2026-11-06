export const CHECKPOINT_LIMIT_BYTES = 200 * 1024 * 1024
const DB_NAME = 'fds-audio-checkpoints-v1'
const STORE_NAME = 'chunks'
const LOCAL_PREFIX = 'fds:audio:checkpoint:'

export interface Checkpoint {
  key: string
  data?: ArrayBuffer
  status: 'complete' | 'failed'
  bytes: number
  updatedAt: number
  error?: string
}

export class CheckpointStorageError extends Error {
  readonly cause?: unknown
  constructor(message: string, cause?: unknown) { super(message); this.cause = cause; this.name = 'CheckpointStorageError' }
}

function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new CheckpointStorageError('Device storage is unavailable.'))
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function localRead(): Checkpoint[] {
  if (typeof localStorage === 'undefined') throw new CheckpointStorageError('Device storage is unavailable.')
  const values: Checkpoint[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(LOCAL_PREFIX)) continue
    try { values.push(JSON.parse(localStorage.getItem(key)!) as Checkpoint) } catch { localStorage.removeItem(key) }
  }
  return values
}

function toBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data); let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}
function fromBase64(value: string): ArrayBuffer {
  const raw = atob(value); const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes.buffer
}

async function allEntries(): Promise<Checkpoint[]> {
  let db: IDBDatabase
  try { db = await database() } catch { return localRead() }
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll()
    request.onsuccess = () => resolve(request.result as Checkpoint[])
    request.onerror = () => reject(new CheckpointStorageError('Could not read saved audio checkpoints.', request.error))
  })
}

async function write(entry: Checkpoint): Promise<void> {
  let db: IDBDatabase | null = null
  try { db = await database() } catch { /* Use localStorage only when IndexedDB cannot be opened. */ }
  if (db) {
    try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(entry)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
    } catch (error) { throw new CheckpointStorageError('Could not save this audio checkpoint. Device storage may be full or unavailable.', error) }
    return
  }
  try {
    const payload = { ...entry, data: undefined, dataBase64: entry.data ? toBase64(entry.data) : undefined }
    localStorage.setItem(LOCAL_PREFIX + encodeURIComponent(entry.key), JSON.stringify(payload))
  } catch (error) { throw new CheckpointStorageError('Could not save this audio checkpoint. Device storage may be full or unavailable.', error) }
}

export async function saveChunk(key: string, audioData: ArrayBuffer): Promise<void> {
  if (!(audioData instanceof ArrayBuffer) || !audioData.byteLength) throw new CheckpointStorageError('Audio checkpoint is empty or invalid.')
  const existing = await allEntries()
  let used = existing.reduce((sum, item) => sum + item.bytes, 0) - (existing.find(item => item.key === key)?.bytes ?? 0)
  const victims = existing.filter(item => item.key !== key).sort((a, b) => a.updatedAt - b.updatedAt)
  while (used + audioData.byteLength > CHECKPOINT_LIMIT_BYTES && victims.length) {
    await deleteCheckpoint(victims.shift()!.key)
    used = (await allEntries()).reduce((sum, item) => sum + item.bytes, 0)
  }
  if (used + audioData.byteLength > CHECKPOINT_LIMIT_BYTES) throw new CheckpointStorageError('Audio checkpoint exceeds the device storage limit.')
  await write({ key, data: audioData.slice(0), status: 'complete', bytes: audioData.byteLength, updatedAt: Date.now() })
}

export async function saveFailure(key: string, error: string): Promise<void> {
  await write({ key, status: 'failed', bytes: 0, updatedAt: Date.now(), error })
}

export async function loadChunk(key: string): Promise<ArrayBuffer | null> {
  const entry = (await allEntries()).find(item => item.key === key)
  if (entry?.data) return entry.data.slice(0)
  if (entry && 'dataBase64' in entry) return fromBase64((entry as Checkpoint & { dataBase64: string }).dataBase64)
  return null
}

export async function listCheckpoints(): Promise<Checkpoint[]> { return allEntries() }
export async function getStorageStats(): Promise<{ usedBytes: number; limitBytes: number; available: boolean }> {
  try { return { usedBytes: (await allEntries()).reduce((sum, item) => sum + item.bytes, 0), limitBytes: CHECKPOINT_LIMIT_BYTES, available: true } }
  catch { return { usedBytes: 0, limitBytes: CHECKPOINT_LIMIT_BYTES, available: false } }
}
export async function deleteCheckpoint(key: string): Promise<void> {
  let db: IDBDatabase | null = null
  try { db = await database() } catch { /* Use localStorage when IndexedDB cannot be opened. */ }
  if (db) {
    try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(key)
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error)
    })
    } catch (error) { throw new CheckpointStorageError('Could not delete the audio checkpoint.', error) }
    return
  }
  try { localStorage.removeItem(LOCAL_PREFIX + encodeURIComponent(key)) } catch (error) { throw new CheckpointStorageError('Could not delete the audio checkpoint.', error) }
}
export async function clearCheckpoints(prefix: string): Promise<void> {
  for (const entry of await allEntries()) if (entry.key.startsWith(prefix)) await deleteCheckpoint(entry.key)
}
