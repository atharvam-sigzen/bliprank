/**
 * Collection orchestrator — the sanctioned funnel for spending money on a cell.
 * PHASES.md 1.1/1.4; rules R3, R4, R6.
 *
 * This is the "cache-check → collect-on-miss → R2 write" entry point the P0
 * review (measurement-engineer F5) said must be the sole caller of
 * `adapter.collect()` in production. It enforces, in order:
 *
 *   R6  — Redis cache lookup BEFORE any provider call. A hit spends nothing.
 *   —    Shared prompt-pool dedupe: one atomic claim per (cell, adapter), so 15
 *        agency clients on the same category cause one collection, not fifteen.
 *   R3  — every attempt is charged to the Budget before it is made; the rate
 *        budget paces it; retries are bounded and dead-lettered.
 *   R4  — all runs of the cell are written as ONE blob (one object per cell),
 *        never one per answer; Postgres is untouched here.
 *
 * The P0 pilot (`pilot/collect.ts`) is a SEPARATE path: it deliberately
 * re-collects every day to measure variance, so it does not use the cache. This
 * orchestrator is what the P1.1 production runner (QStash → fleet) calls.
 */

import { AdapterError, type CacheCell, type EngineAdapter, type EngineId, type RawAnswer } from '@bliprank/contracts'
import type { BlobStore } from './blob-store.js'
import { Budget, BudgetExceeded } from './budget.js'
import { AnswerIndex, r2KeyFor, type IndexEntry } from './cache-index.js'
import type { DeadLetter } from './dead-letter.js'
import type { RateBudget } from './rate-budget.js'
import { DEFAULT_RETRY, retryDecision, type RetryConfig } from './retry.js'

export interface OrchestratorDeps {
  readonly index: AnswerIndex
  readonly blob: BlobStore
  readonly rateBudget: RateBudget
  readonly budget: Budget
  readonly deadLetter: DeadLetter
  /** Identifies this worker/process in a claim, for debugging who is collecting. */
  readonly owner: string
  readonly retry?: RetryConfig
  /** Seconds a claim is held before it expires (a crashed worker must not orphan the cell). */
  readonly claimLeaseSec?: number
  readonly timeoutMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => Date
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
  | { status: 'budget-exhausted'; providerCalls: number; answers: RawAnswer[] }
  | { status: 'failed'; providerCalls: number }

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class CollectionOrchestrator {
  constructor(private readonly d: OrchestratorDeps) {}

  /**
   * Collect one cell, cache-first. Never calls the provider on a cache hit or
   * when another worker holds the claim. On a miss it collects `runs` answers,
   * writes them as one blob, and records the index entry.
   */
  async collectCell(req: CollectCellRequest): Promise<CollectOutcome> {
    const { cell, adapter } = req
    const engine = adapter.engine as EngineId
    const adapterId = adapter.id
    const retry = this.d.retry ?? DEFAULT_RETRY
    const sleep = this.d.sleep ?? defaultSleep
    const now = this.d.now ?? (() => new Date())

    // R6 — cache lookup before any spend. A path-qualified hit means this adapter
    // already collected this cell; serve it, zero provider calls.
    const { hits } = await this.d.index.lookup([cell], adapterId)
    const cached = hits.get(cell.key)
    if (cached) return { status: 'cache-hit', entry: cached, providerCalls: 0 }

    // Dedupe — exactly one worker per (cell, adapter, lease) collects; the rest
    // must wait for the winner's result rather than collecting again.
    if (!(await this.d.index.claim(cell, adapterId, this.d.owner, this.d.claimLeaseSec ?? 1800))) {
      return { status: 'claimed-elsewhere', providerCalls: 0 }
    }

    const answers: RawAnswer[] = []
    let providerCalls = 0
    let budgetExhausted = false

    for (let run = 0; run < req.runs && !budgetExhausted; run++) {
      let attempt = 0
      for (;;) {
        attempt++
        // R3 — charge before the call. A refusal stops the whole cell.
        try {
          this.d.budget.charge(engine)
        } catch (e) {
          if (e instanceof BudgetExceeded) {
            budgetExhausted = true
            break
          }
          throw e
        }
        providerCalls++
        await this.d.rateBudget.acquire(engine, req.signal)
        const ac = new AbortController()
        const timer = this.d.timeoutMs ? setTimeout(() => ac.abort(), this.d.timeoutMs) : undefined
        try {
          const answer = await adapter.collect({ cell, prompt: req.prompt, run, signal: req.signal ?? ac.signal })
          // A chaining adapter reports >1 provider call; charge the extra ones.
          for (let extra = 1; extra < answer.providerCalls; extra++) {
            try {
              this.d.budget.charge(engine)
              providerCalls++
            } catch (e) {
              if (e instanceof BudgetExceeded) {
                budgetExhausted = true
                break
              }
              throw e
            }
          }
          answers.push(answer)
          break
        } catch (e) {
          const err = e instanceof AdapterError ? e : new AdapterError('provider', String(e), false)
          const decision = retryDecision(err, attempt, retry)
          if (!decision.retry) {
            this.d.deadLetter.record({ engine, cellKey: cell.key, prompt: req.prompt, run, kind: err.kind, message: err.message, attempts: attempt, at: now().toISOString() })
            break // this run failed; move to the next run
          }
          await sleep(decision.delayMs)
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
    }

    if (answers.length === 0) {
      return budgetExhausted ? { status: 'budget-exhausted', providerCalls, answers } : { status: 'failed', providerCalls }
    }

    // R4 — one object per cell, holding all runs. Then record the index pointer.
    const r2Key = r2KeyFor(cell)
    await this.d.blob.put(r2Key, JSON.stringify({ cell, runs: answers }))
    const entry = await this.d.index.markCollected(cell, adapterId, answers.length, r2Key)

    return budgetExhausted ? { status: 'budget-exhausted', providerCalls, answers } : { status: 'collected', entry, providerCalls, answers }
  }
}
