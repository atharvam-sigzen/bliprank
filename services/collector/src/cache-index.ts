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
  /**
   * Atomic add, returning the value AFTER the increment. The post-increment
   * read is the point: it is what lets a spend ledger decide, without a lock,
   * whether *this* caller is the one that crossed the cap (spend-ledger.ts).
   */
  incrByFloat(key: string, delta: number, opts?: { ttlSec?: number }): Promise<number>
  /**
   * Several atomic adds in ONE round-trip, returning each post-increment value
   * in order. The spend ledger needs a total plus a per-engine breakdown per
   * charge; done as three separate calls that would be three round-trips on
   * every provider call, which at 20M calls/month is not a rounding error.
   * Each individual increment is atomic; the batch is not a transaction, which
   * is fine because only the total gates the cap.
   */
  incrManyByFloat(ops: readonly { key: string; delta: number }[], opts?: { ttlSec?: number }): Promise<number[]>
  /**
   * Atomic delete-if-equal: remove `key` only while it still holds `expected`.
   * The lock-release primitive. A claim whose lease lapsed and was re-won by
   * another worker holds a different value, so a late release leaves it alone.
   * Returns true when the key was removed.
   */
  delIfEquals(key: string, expected: string): Promise<boolean>
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
  async incrByFloat(key: string, delta: number, opts?: { ttlSec?: number }): Promise<number> {
    const next = Number(this.live(key) ?? 0) + delta
    await this.set(key, String(next), opts ?? {})
    return next
  }
  async incrManyByFloat(ops: readonly { key: string; delta: number }[], opts?: { ttlSec?: number }): Promise<number[]> {
    const out: number[] = []
    for (const op of ops) out.push(await this.incrByFloat(op.key, op.delta, opts))
    return out
  }
  async delIfEquals(key: string, expected: string): Promise<boolean> {
    if (this.live(key) !== expected) return false
    this.m.delete(key)
    return true
  }
}

/** Compare-and-delete as one server-side step; a GET here followed by a DEL could delete a claim re-won in between. */
const DEL_IF_EQUALS = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end"

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
  async incrByFloat(key: string, delta: number, opts?: { ttlSec?: number }): Promise<number> {
    // INCRBYFLOAT is atomic and returns the post-increment value. EXPIRE rides
    // in the same pipeline so a counter cannot be created without a TTL.
    const cmds: (string | number)[][] = [['INCRBYFLOAT', key, delta]]
    if (opts?.ttlSec) cmds.push(['EXPIRE', key, opts.ttlSec])
    const res = await this.pipeline(cmds)
    return Number(this.one(res[0]))
  }
  async incrManyByFloat(ops: readonly { key: string; delta: number }[], opts?: { ttlSec?: number }): Promise<number[]> {
    if (ops.length === 0) return []
    const cmds: (string | number)[][] = ops.map((o) => ['INCRBYFLOAT', o.key, o.delta])
    if (opts?.ttlSec) for (const o of ops) cmds.push(['EXPIRE', o.key, opts.ttlSec])
    const res = await this.pipeline(cmds)
    return ops.map((_, i) => Number(this.one(res[i])))
  }
  async delIfEquals(key: string, expected: string): Promise<boolean> {
    return this.one((await this.pipeline([['EVAL', DEL_IF_EQUALS, 1, key, expected]]))[0]) === 1
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

  /**
   * Release the claim `owner` holds on a cell, once its collection has ended.
   *
   * The counterpart `claim` lacked until 2026-09-07: a claim ended only when
   * its lease expired, so every stop short of the cell — budget, allowance,
   * abort, a dead-lettered run — left it held for up to thirty minutes, and a
   * re-run inside that window saw `claimed-elsewhere` for a cell nobody was
   * collecting (ADR-0017, measured). Only THIS owner's claim is removed: the
   * value `claim` wrote is read back and deleted only while it is still exactly
   * that value, so a claim that lapsed and was re-won by another worker is
   * left to its holder. Returns true when a claim was removed.
   */
  async release(cell: CacheCell, adapterId: string, owner: string): Promise<boolean> {
    const key = `${CLAIM_PREFIX}${cell.key}:${adapterId}`
    // ponytail: two round-trips per release (GET, then EVAL). Fold the owner
    // check into the script with cjson if Upstash command volume matters at
    // fleet scale (cost-sentinel 2026-09-07: low, ~$10-80/month at 20M calls).
    const held = await this.kv.get(key)
    if (held === null) return false
    let holder: string | undefined
    try {
      holder = (JSON.parse(held) as { owner?: string }).owner
    } catch {
      return false // not a claim this code wrote; leave it to its lease
    }
    if (holder !== owner) return false
    return this.kv.delIfEquals(key, held)
  }
}
