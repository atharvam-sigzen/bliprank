/**
 * Collection orchestrator — the sanctioned funnel for spending money on a cell.
 * PHASES.md 1.1/1.4; rules R3, R4, R6.
 *
 * This is the "cache-check → collect-on-miss → R2 write" entry point the P0
 * review (measurement-engineer F5) said must be the sole caller of
 * `adapter.collect()` in production. It enforces, in order:
 *
 *   R6  — Redis cache lookup BEFORE any provider call. A complete hit spends
 *         nothing. A partial prior collection (n < requested) is NOT a hit — it
 *         falls through so `n` is completed, never capped (rule R8).
 *   R3  — COLLECTION_ENABLED gate for real adapters, then every attempt charged
 *         to the Budget before it is made; the rate budget paces it; retries are
 *         bounded and dead-lettered.
 *   —    Shared prompt-pool dedupe: one atomic claim per (cell, adapter), so 15
 *        agency clients on the same category cause one collection, not fifteen.
 *   R4  — all runs of the cell are written as ONE blob (one object per cell per
 *        collection path, ADR-0003), never one per answer; Postgres untouched.
 *
 * The P0 pilot (`pilot/collect.ts`) is a SEPARATE path: it deliberately
 * re-collects every day to measure variance, so it does not use the cache. This
 * orchestrator is what the P1.1 production runner (QStash → fleet) calls.
 */

import { AdapterError, type CacheCell, type EngineAdapter, type EngineId, type RawAnswer } from '@bliprank/contracts'
import type { BlobStore } from './blob-store.js'
import { BudgetExceeded } from './budget.js'
import { AnswerIndex, r2KeyFor, type IndexEntry } from './cache-index.js'
import type { DeadLetter } from './dead-letter.js'
import type { RateBudget } from './rate-budget.js'
import type { SpendLedger } from './spend-ledger.js'
import { DEFAULT_RETRY, retryDecision, type RetryConfig } from './retry.js'

export interface OrchestratorDeps {
  readonly index: AnswerIndex
  readonly blob: BlobStore
  readonly rateBudget: RateBudget
  /**
   * The USD ceiling (R3). A SpendLedger, not a Budget: this orchestrator runs
   * one instance per QStash delivery, and a file-backed in-memory Budget would
   * enforce the cap per container rather than globally. See spend-ledger.ts.
   */
  readonly budget: SpendLedger
  readonly deadLetter: DeadLetter
  /** Identifies this worker/process in a claim, for debugging who is collecting. */
  readonly owner: string
  readonly retry?: RetryConfig
  /** Seconds a claim is held before it expires (a crashed worker must not orphan the cell). */
  readonly claimLeaseSec?: number
  readonly timeoutMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => Date
  /**
   * Rule R3 spend gate for real (non-offline) adapters. Defaults to
   * `process.env.COLLECTION_ENABLED === 'true'`. Injected for tests.
   */
  readonly collectionEnabled?: () => boolean
}

export interface CollectCellRequest {
  readonly cell: CacheCell
  /** Prompt as sent (raw), not the normalised form on the cell. */
  readonly prompt: string
  readonly runs: number
  readonly adapter: EngineAdapter
  readonly signal?: AbortSignal
}

export type CollectOutcome =
  | { status: 'cache-hit'; entry: IndexEntry; providerCalls: 0 }
  | { status: 'claimed-elsewhere'; providerCalls: 0 }
  | { status: 'collected'; entry: IndexEntry; providerCalls: number; answers: RawAnswer[] }
  | { status: 'budget-exhausted'; entry: IndexEntry | null; providerCalls: number; answers: RawAnswer[] }
  | { status: 'aborted'; entry: IndexEntry | null; providerCalls: number; answers: RawAnswer[] }
  | { status: 'failed'; providerCalls: number }

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const isAbort = (e: unknown): boolean => (e as { name?: string })?.name === 'AbortError'

export class CollectionOrchestrator {
  constructor(private readonly d: OrchestratorDeps) {}

  private spendAllowed(): boolean {
    return this.d.collectionEnabled ? this.d.collectionEnabled() : process.env['COLLECTION_ENABLED'] === 'true'
  }

  /** Read an orphaned blob (crash between blob.put and markCollected) and re-index it. */
  private async recoverOrphan(cell: CacheCell, adapterId: string, r2Key: string): Promise<IndexEntry | null> {
    try {
      const body = await this.d.blob.get(r2Key)
      if (!body) return null
      const runs = (JSON.parse(body) as { runs?: unknown[] }).runs
      if (!Array.isArray(runs) || runs.length === 0) return null
      return await this.d.index.markCollected(cell, adapterId, runs.length, r2Key)
    } catch {
      return null // unreadable orphan: fall through and re-collect (overwrites it)
    }
  }

  /** The runs already stored in an orphaned blob, so they are not re-bought. */
  private async orphanRuns(r2Key: string): Promise<RawAnswer[]> {
    try {
      const body = await this.d.blob.get(r2Key)
      if (!body) return []
      const runs = (JSON.parse(body) as { runs?: unknown[] }).runs
      return Array.isArray(runs) ? (runs as RawAnswer[]) : []
    } catch {
      return []
    }
  }

  /**
   * Collect one cell, cache-first. Never calls the provider on a complete cache
   * hit or when another worker holds the claim. On a miss it collects `runs`
   * answers, writes them as one blob, and records the index entry. Always
   * returns a typed outcome — an abort persists whatever was already collected.
   */
  async collectCell(req: CollectCellRequest): Promise<CollectOutcome> {
    const { cell, adapter } = req
    const engine = adapter.engine as EngineId
    const adapterId = adapter.id
    const retry = this.d.retry ?? DEFAULT_RETRY
    const sleep = this.d.sleep ?? defaultSleep
    const now = this.d.now ?? (() => new Date())
    const r2Key = r2KeyFor(cell, adapterId) // B1: path-qualified so paths don't collide

    // R6 — cache lookup before any spend. A COMPLETE prior collection is a hit;
    // a partial one (fewer runs than requested) falls through to be completed.
    const { hits } = await this.d.index.lookup([cell], adapterId)
    const cached = hits.get(cell.key)
    if (cached && cached.runs >= req.runs) return { status: 'cache-hit', entry: cached, providerCalls: 0 }

    // R3 — a real adapter may only collect when collection is deliberately enabled.
    if (!adapter.offline && !this.spendAllowed()) {
      throw new Error('refusing to collect: COLLECTION_ENABLED is not "true" (rule R3, orchestrator guard). Enable it deliberately for the run.')
    }

    // Dedupe — exactly one worker per (cell, adapter, lease) collects.
    if (!(await this.d.index.claim(cell, adapterId, this.d.owner, this.d.claimLeaseSec ?? 1800))) {
      return { status: 'claimed-elsewhere', providerCalls: 0 }
    }

    // Recover an orphaned blob left by a crash between blob.put and markCollected.
    // A complete orphan is a hit; a PARTIAL one is carried forward rather than
    // discarded — those runs were already paid for, and overwriting the blob
    // with a fresh collection would buy them a second time.
    const answers: RawAnswer[] = []
    if (!cached && (await this.d.blob.has(r2Key))) {
      const recovered = await this.recoverOrphan(cell, adapterId, r2Key)
      if (recovered && recovered.runs >= req.runs) return { status: 'cache-hit', entry: recovered, providerCalls: 0 }
      if (recovered) answers.push(...(await this.orphanRuns(r2Key)))
    }
    let providerCalls = 0
    let stopped: 'budget' | 'abort' | null = null

    for (let run = answers.length; run < req.runs && !stopped; run++) {
      let attempt = 0
      for (;;) {
        attempt++
        try {
          await this.d.budget.charge(engine) // R3: charge before the call
        } catch (e) {
          if (e instanceof BudgetExceeded) {
            stopped = 'budget'
            break
          }
          throw e
        }
        providerCalls++
        const ac = new AbortController()
        const timer = this.d.timeoutMs ? setTimeout(() => ac.abort(), this.d.timeoutMs) : undefined
        try {
          await this.d.rateBudget.acquire(engine, req.signal) // inside try (M2): an abort here persists partial
          const answer = await adapter.collect({ cell, prompt: req.prompt, run, signal: req.signal ?? ac.signal })
          for (let extra = 1; extra < answer.providerCalls; extra++) {
            try {
              await this.d.budget.charge(engine)
              providerCalls++
            } catch (e) {
              if (e instanceof BudgetExceeded) {
                stopped = 'budget'
                break
              }
              throw e
            }
          }
          answers.push(answer)
          break
        } catch (e) {
          if (isAbort(e) && req.signal?.aborted) {
            stopped = 'abort' // caller/deadline cancelled — stop, persist what we have
            break
          }
          const err = e instanceof AdapterError ? e : new AdapterError('provider', String(e), false)
          const decision = retryDecision(err, attempt, retry)
          if (!decision.retry) {
            this.d.deadLetter.record({ engine, cellKey: cell.key, prompt: req.prompt, run, kind: err.kind, message: err.message, attempts: attempt, at: now().toISOString() })
            break // this run failed; move on
          }
          await sleep(decision.delayMs)
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
    }

    if (answers.length === 0) {
      if (stopped === 'budget') return { status: 'budget-exhausted', entry: null, providerCalls, answers }
      if (stopped === 'abort') return { status: 'aborted', entry: null, providerCalls, answers }
      return { status: 'failed', providerCalls }
    }

    // R4 — one object per cell (per path), holding all runs collected so far.
    await this.d.blob.put(r2Key, JSON.stringify({ cell, adapter: adapterId, runs: answers }))
    const entry = await this.d.index.markCollected(cell, adapterId, answers.length, r2Key)

    if (stopped === 'budget') return { status: 'budget-exhausted', entry, providerCalls, answers }
    if (stopped === 'abort') return { status: 'aborted', entry, providerCalls, answers }
    return { status: 'collected', entry, providerCalls, answers }
  }
}
