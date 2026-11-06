import { test } from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error Node's built-in TypeScript stripping loads this module directly.
const { saveChunk, loadChunk, listCheckpoints, clearCheckpoints, CHECKPOINT_LIMIT_BYTES, CheckpointStorageError } = await import('./checkpoint.ts')

class MemoryStorage {
  values = new Map<string, string>()
  failWrites = false
  get length() { return this.values.size }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { if (this.failWrites) throw new DOMException('quota exceeded', 'QuotaExceededError'); this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  clear() { this.values.clear() }
}
const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined })
const bytes = (size: number) => new Uint8Array(size).buffer

test('checkpoint save and load roundtrip', async () => {
  storage.clear()
  await saveChunk('page:source:model:voice:0', bytes(12))
  assert.deepEqual(new Uint8Array((await loadChunk('page:source:model:voice:0'))!), new Uint8Array(12))
})

test('versioned keys leave mismatched source checkpoints stale and clearable', async () => {
  storage.clear()
  await saveChunk('page:old:model:voice:0', bytes(4))
  await saveChunk('page:new:model:voice:0', bytes(5))
  assert.equal((await listCheckpoints()).length, 2)
  await clearCheckpoints('page:old:')
  assert.deepEqual((await listCheckpoints()).map(item => item.key), ['page:new:model:voice:0'])
})

test('quota failure is reported to the caller', async () => {
  storage.clear(); storage.failWrites = true
  await assert.rejects(saveChunk('page:source:model:voice:0', bytes(4)), CheckpointStorageError)
  storage.failWrites = false
})

test('storage limit evicts oldest checkpoints before saving new audio', async () => {
  storage.clear()
  await saveChunk('page:old:model:voice:0', bytes(4))
  const oldKey = 'fds:audio:checkpoint:' + encodeURIComponent('page:old:model:voice:0')
  const old = JSON.parse(storage.getItem(oldKey)!)
  old.bytes = CHECKPOINT_LIMIT_BYTES
  old.updatedAt = 1
  storage.setItem(oldKey, JSON.stringify(old))
  await saveChunk('page:new:model:voice:0', bytes(8))
  assert.equal(await loadChunk('page:old:model:voice:0'), null)
  assert.equal((await loadChunk('page:new:model:voice:0'))?.byteLength, 8)
})
