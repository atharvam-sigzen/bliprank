/**
 * Disk-backed `BlobStore` and `KV` for a single-process local run.
 *
 * WHY THESE EXIST. R2 and Upstash credentials are not configured, and the only
 * implementations in the collector are `R2BlobStore`/`UpstashKV` (need
 * credentials) and `MemoryBlobStore`/`MemoryKV` (lose everything on exit). With
 * memory stores a demo re-run finds an empty cache and buys every answer again,
 * so the second run of a $0.18 scan costs $0.18 and the tenth costs $1.80.
 *
 * Persisting locally makes the re-run free, which is not merely convenient: the
 * cache is the margin lever (R6), and a demo that shows the second scan
 * returning instantly at zero provider calls is showing the actual economics.
 *
 * ⚠️ SINGLE-PROCESS ONLY, and that is not a soft warning. `incrByFloat` here is
 * a read-modify-write that is atomic only because one Node process is
 * single-threaded. Two processes over the same directory would each read the
 * same total and each believe it was under the cap — the exact failure
 * `spend-ledger.ts` documents and refuses. The runner declares
 * `COLLECTOR_TOPOLOGY=single-process` and holds an exclusive lock; these stores
 * are correct only under that declaration and must never be reached for by the
 * fleet path.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BlobStore, KV } from '@bliprank/collector'

/** `answers/2026-08-24/chatgpt/ab12__own:chatgpt.json` → a safe relative path. */
function safePath(root: string, key: string): string {
  if (!/^[A-Za-z0-9._:/-]+$/.test(key) || key.includes('..')) throw new Error(`unsafe blob key: ${key}`)
  return join(root, key.replace(/[:]/g, '_'))
}

export class FileBlobStore implements BlobStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true })
  }
  async has(key: string): Promise<boolean> {
    return existsSync(safePath(this.root, key))
  }
  async get(key: string): Promise<string | null> {
    const p = safePath(this.root, key)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  }
  async put(key: string, body: string): Promise<void> {
    const p = safePath(this.root, key)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body, 'utf8')
  }
  /** How many objects exist — the R4 batching check: one per cell, not per answer. */
  get size(): number {
    const walk = (d: string): number =>
      readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? walk(join(d, e.name)) : 1), 0)
    return existsSync(this.root) ? walk(this.root) : 0
  }
}

interface Entry {
  v: string
  expiresAt: number | null
}

export class FileKV implements KV {
  private readonly m = new Map<string, Entry>()

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file)) {
      for (const [k, e] of Object.entries(JSON.parse(readFileSync(file, 'utf8')) as Record<string, Entry>)) this.m.set(k, e)
    }
  }

  private flush(): void {
    writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.m), null, 0), 'utf8')
  }

  private live(key: string): string | null {
    const e = this.m.get(key)
    if (!e) return null
    if (e.expiresAt !== null && e.expiresAt <= this.now()) {
      this.m.delete(key)
      return null
    }
    return e.v
  }

  private expiry(ttlSec?: number): number | null {
    return ttlSec === undefined ? null : this.now() + ttlSec * 1000
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)
  }

  async mget(keys: readonly string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.live(k))
  }

  async set(key: string, value: string, opts?: { ttlSec?: number }): Promise<void> {
    this.m.set(key, { v: value, expiresAt: this.expiry(opts?.ttlSec) })
    this.flush()
  }

  async setnx(key: string, value: string, opts?: { ttlSec?: number }): Promise<boolean> {
    if (this.live(key) !== null) return false
    this.m.set(key, { v: value, expiresAt: this.expiry(opts?.ttlSec) })
    this.flush()
    return true
  }

  async incrByFloat(key: string, delta: number, opts?: { ttlSec?: number }): Promise<number> {
    return (await this.incrManyByFloat([{ key, delta }], opts))[0]!
  }

  async incrManyByFloat(ops: readonly { key: string; delta: number }[], opts?: { ttlSec?: number }): Promise<number[]> {
    const out = ops.map((o) => {
      const next = Number(this.live(o.key) ?? 0) + o.delta
      this.m.set(o.key, { v: String(next), expiresAt: this.expiry(opts?.ttlSec) })
      return next
    })
    this.flush()
    return out
  }
}
