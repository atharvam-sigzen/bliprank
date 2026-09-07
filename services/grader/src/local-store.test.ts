import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileKV } from './local-store.js'

describe("FileKV — the local runner's index store", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'filekv-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('delIfEquals removes a key only while it holds the expected value, and the removal reaches the disk', async () => {
    const file = join(dir, 'index.json')
    const kv = new FileKV(file)
    await kv.set('claim:x', 'a')
    expect(await kv.delIfEquals('claim:x', 'b')).toBe(false)
    expect(await kv.get('claim:x')).toBe('a')
    expect(await kv.delIfEquals('claim:x', 'a')).toBe(true)
    expect(await kv.get('claim:x')).toBeNull()
    expect(await new FileKV(file).get('claim:x')).toBeNull() // gone on disk, not only in this instance
    expect(await kv.delIfEquals('claim:x', 'a')).toBe(false)
  })
})
