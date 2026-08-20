/**
 * Answer-cache index + shared prompt-pool dedupe — PHASES.md 1.4, ADR-0003.
 *
 * The Redis-backed index answers two questions before any money is spent
 * (rule R6: cache lookup before every collection call):
 *
 *   1. "Is this cell already collected?" — `lookup`. The index key is the
 *      cell key verbatim; the path-qualified variant `${cell.key}:${adapterId}`
 *      answers it per collection path (ADR-0003 "Path-qualified lookups").
 *   2. "Is someone else already collecting it?" — `claim`, an atomic
 *      SET-if-absent with a TTL lease. This is the shared prompt-pool dedupe
 *      (ARCHITECTURE §3.4): an agency with 15 clients in one category produces
 *      identical cell keys, so one collection serves them all — visibility is
 *      a filtered join downstream, never a second collection.
 *
 * Storage is behind the four-method `KV` interface: MemoryKV for tests and the
 * in-process runner, UpstashKV (REST, injected fetch) for production. Values
 * are small JSON envelopes; raw answers stay in R2 (rule R4).
 */

import type { CacheCell } from '@bliprank/contracts'

export interface KV {
  get(key: string): Promise<string | null>
  mget(keys: readonly string[]): Promise<(string | null)[]>
  set(key: string, value: string, opts?: { ttlSec?: number }): Promise<void>
  /** Atomic set-if-absent. Returns true when this caller won the key. */
  setnx(key: string, value: string, opts?: { ttlSec?: number }): Promise<boolean>
}

export class MemoryKV implements KV {
  private readonly m = new Map<string, { v: string; expiresAt: number | null }>()
  constructor(private readonly now: () => number = Date.now) {}
  private live(key: string): string | null {
    const e = this.m.get(key)
    if (!e) return null
    if (e.expiresAt !== null && e.expiresAt <= this.now()) {
      this.m.delete(key)
      return null
    }
    return e.v
  }
  async get(key: string): Promise<string | null> {
    return this.live(key)
  }
  async mget(keys: readonly string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.live(k))
  }
  async set(key: string, value: string, opts?: { ttlSec?: number }): Promise<void> {
    this.m.set(key, { v: value, expiresAt: opts?.ttlSec ? this.now() + opts.ttlSec * 1000 : null })
  }
  async setnx(key: string, value: string, opts?: { ttlSec?: number }): Promise<boolean> {
    if (this.live(key) !== null) return false
    await this.set(key, value, opts)
    return true
  }
}

/**
 * Upstash Redis over REST. Uses the pipeline endpoint so mget is one round
 * trip. fetch is injected for tests; nothing here is called unless the caller
 * has credentials — construction alone performs no I/O.
 */
export class UpstashKV implements KV {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  private async pipeline(commands: (string | number)[][]): Promise<{ result?: unknown; error?: string }[]> {
    const res = await this.doFetch(`${this.url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    })
    if (!res.ok) throw new Error(`upstash pipeline HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return (await res.json()) as { result?: unknown; error?: string }[]
  }

  private one(r: { result?: unknown; error?: string } | undefined): unknown {
    if (!r) throw new Error('upstash: empty pipeline response')
    if (r.error) throw new Error(`upstash: ${r.error}`)
    return r.result
  }

  async get(key: string): Promise<string | null> {
    return (this.one((await this.pipeline([['GET', key]]))[0]) as string | null) ?? null
  }
  async mget(keys: readonly string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return []
    return (this.one((await this.pipeline([['MGET', ...keys]]))[0]) as (string | null)[]).map((v) => v ?? null)
  }
  async set(key: string, value: string, opts?: { ttlSec?: number }): Promise<void> {
    const cmd: (string | number)[] = ['SET', key, value]
    if (opts?.ttlSec) cmd.push('EX', opts.ttlSec)
    this.one((await this.pipeline([cmd]))[0])
  }
  async setnx(key: string, value: string, opts?: { ttlSec?: number }): Promise<boolean> {
    const cmd: (string | number)[] = ['SET', key, value, 'NX']
    if (opts?.ttlSec) cmd.push('EX', opts.ttlSec)
    // Redis returns OK when set, null when the key already existed.
    return this.one((await this.pipeline([cmd]))[0]) === 'OK'
  }
}

/** What the index stores per collected cell: a pointer, never the payload (rule R4). */
export interface IndexEntry {
  /** R2 object holding all runs of the cell. */
  readonly r2Key: string
  /** Adapter that collected it, e.g. 'openwebninja:chatgpt'. */
  readonly adapter: string
  /** Runs stored in the object. */
  readonly runs: number
  /** ISO 8601 of the write. */
  readonly storedAt: string
}

export interface LookupResult {
  readonly hits: Map<string, IndexEntry>
  readonly misses: CacheCell[]
}

const ANSWER_PREFIX = 'answer:'
const CLAIM_PREFIX = 'claim:'

/**
 * R2 object key for a cell — one object per cell PER collection path (ADR-0003
 * "R2 object unit"). Without `adapterId` the bare cell key is used (single-path,
 * the common case). With it, the key is path-qualified the same way the index is
 * (`__${adapterId}`), so an alternate-path re-collection (agreement monitor,
 * ADR-0001 §5) writes its own object instead of overwriting the primary's.
 */
export function r2KeyFor(cell: CacheCell, adapterId?: string): string {
  const base = `answers/${cell.dateBucket}/${cell.engine}/${cell.key}`
  return adapterId ? `${base}__${adapterId.replace(/[^a-z0-9:_-]/gi, '_')}.json` : `${base}.json`
}

export class AnswerIndex {
  /**
   * @param kv          the store
   * @param entryTtlSec index-entry TTL. Entries may outlive R2 retention; a
   *                    hit is a pointer, and readers must tolerate a pruned
   *                    object. Default 100 days ≈ raw-answer retention.
   */
  constructor(
    private readonly kv: KV,
    private readonly entryTtlSec: number = 100 * 86_400,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Index key for a cell; qualified by adapter for path-specific lookups (ADR-0003). */
  static keyFor(cellKey: string, adapterId?: string): string {
    return adapterId ? `${ANSWER_PREFIX}${cellKey}:${adapterId}` : `${ANSWER_PREFIX}${cellKey}`
  }

  /**
   * Batch "already collected?". With `adapterId` the question is path-specific
   * (the agreement monitor re-collecting via the alternate path must not be
   * short-circuited by the primary's entry — ADR-0003).
   */
  async lookup(cells: readonly CacheCell[], adapterId?: string): Promise<LookupResult> {
    const values = await this.kv.mget(cells.map((c) => AnswerIndex.keyFor(c.key, adapterId)))
    const hits = new Map<string, IndexEntry>()
    const misses: CacheCell[] = []
    cells.forEach((cell, i) => {
      const v = values[i]
      if (v === null || v === undefined) {
        misses.push(cell)
        return
      }
      try {
        hits.set(cell.key, JSON.parse(v) as IndexEntry)
      } catch {
        misses.push(cell) // a corrupt entry is a miss, never a crash
      }
    })
    return { hits, misses }
  }

  /**
   * Record a collected cell: the path-qualified entry (who collected it) and
   * the plain entry (collected at all — the spend-guard key of rule R6).
   * Idempotent; last write wins, which is fine for pointers to the same object.
   */
  async markCollected(cell: CacheCell, adapterId: string, runs: number, r2Key: string = r2KeyFor(cell)): Promise<IndexEntry> {
    const entry: IndexEntry = { r2Key, adapter: adapterId, runs, storedAt: this.now().toISOString() }
    const value = JSON.stringify(entry)
    // Path-qualified entry: authoritative for THIS adapter's runs/adapter.
    await this.kv.set(AnswerIndex.keyFor(cell.key, adapterId), value, { ttlSec: this.entryTtlSec })
    // Plain "collected at all?" entry (the rule R6 spend-guard key): first writer
    // wins so a later alternate-path collection (agreement monitor) does not
    // clobber the primary's runs/adapter. Only the qualified entries are
    // authoritative for runs/adapter; the plain one is presence + a valid pointer.
    const plainKey = AnswerIndex.keyFor(cell.key)
    if ((await this.kv.get(plainKey)) === null) await this.kv.set(plainKey, value, { ttlSec: this.entryTtlSec })
    return entry
  }

  /**
   * Shared prompt-pool dedupe: atomically claim a cell for collection. Exactly
   * one caller per (cell, adapter, lease window) gets true — every other
   * workspace/job wanting the same cell must wait for the winner's result
   * instead of collecting again. The lease expires so a crashed winner does
   * not orphan the cell.
   */
  async claim(cell: CacheCell, adapterId: string, owner: string, leaseSec = 1800): Promise<boolean> {
    return this.kv.setnx(`${CLAIM_PREFIX}${cell.key}:${adapterId}`, JSON.stringify({ owner, at: this.now().toISOString() }), { ttlSec: leaseSec })
  }
}
