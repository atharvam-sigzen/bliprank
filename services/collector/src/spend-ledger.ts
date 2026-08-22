/**
 * Shared spend ledger — rule R3. HUMAN-OWNED (CLAUDE.md §4: spend-control logic).
 *
 * WHY THIS EXISTS, from the cost review of the QStash runner:
 *
 * `Budget` (budget.ts) reads `ledger.json` once at construction and charges in
 * memory. That is exactly right for the pilot, which is one process. It is
 * wrong for the P1.1 topology, where a QStash cron fans one message per cell out
 * to auto-scaling ephemeral instances: each cold container constructs its own
 * `Budget` over its own local disk, so `COLLECTION_BUDGET_USD_DAILY` — the value
 * CLAUDE.md calls "a hard ceiling, enforced by the collector" — silently becomes
 * a ceiling *per container*. Realised spend would then be bounded only by
 * achievable throughput. That is the "five-figure invoice before anyone notices"
 * R3 was written to prevent, arriving through a coordination gap rather than a
 * retry bug.
 *
 * Same seam as `RateBudget`: an interface with a local implementation for the
 * single-process paths and a shared-counter implementation for the fleet. The
 * orchestrator depends on the interface, so pointing it at production is a
 * constructor change rather than a rewrite.
 *
 * THE ORDER MATTERS. Charge is increment-then-check, never check-then-increment:
 * two workers each increment atomically and each sees its own post-increment
 * total, so at most one of them can observe a total within the cap. A refused
 * charge decrements back. Check-then-increment would let both read $74.99 and
 * both proceed. A worker that dies between charging and calling leaves the money
 * counted but unspent — conservative, which is the correct direction to fail for
 * a ceiling.
 */

import { Budget, BudgetExceeded } from './budget.js'
import type { KV } from './cache-index.js'

export interface SpendLedger {
  /**
   * Reserve the cost of one call before it is made. Throws `BudgetExceeded`
   * when the cap would be breached; the caller must not proceed.
   */
  charge(engine: string): Promise<void>
  spentUsd(): Promise<number>
  readonly capUsd: number
}

/**
 * Single-process ledger over the existing file-backed `Budget`. Correct for the
 * pilot runner and for tests. NOT safe across concurrent processes — see the
 * header; use `KvSpendLedger` anywhere more than one worker can run.
 */
export class LocalSpendLedger implements SpendLedger {
  /** Public so /cost-audit and tests can read the per-engine breakdown. */
  constructor(readonly budget: Budget) {}
  async charge(engine: string): Promise<void> {
    this.budget.charge(engine)
  }
  async spentUsd(): Promise<number> {
    return this.budget.state.spentUsd
  }
  get capUsd(): number {
    return this.budget.state.capUsd
  }
}

export interface KvSpendLedgerOptions {
  readonly kv: KV
  readonly capUsd: number
  readonly priceUsd: (engine: string) => number
  /**
   * Ledger identity. Include the window (e.g. `spend:2026-08-21`) so a daily cap
   * resets by construction rather than by a cleanup job that might not run.
   */
  readonly key: string
  /** Expiry for the counter; should outlive the window comfortably. */
  readonly ttlSec?: number
}

/**
 * Fleet-safe ledger over an atomic shared counter (Upstash Redis in production).
 * Every charge is one round-trip — that is the cost of a ceiling that actually
 * holds across instances, and it is the same trade ADR-0002 accepts for the rate
 * budget until the fixed worker fleet lands.
 */
export class KvSpendLedger implements SpendLedger {
  constructor(private readonly o: KvSpendLedgerOptions) {}

  get capUsd(): number {
    return this.o.capUsd
  }

  async spentUsd(): Promise<number> {
    const raw = await this.o.kv.get(this.o.key)
    return raw === null ? 0 : Number(raw)
  }

  async charge(engine: string): Promise<void> {
    const price = this.o.priceUsd(engine)
    const after = await this.o.kv.incrByFloat(this.o.key, price, { ttlSec: this.o.ttlSec ?? 172_800 })
    if (after > this.o.capUsd) {
      // Put it back. A failed refund would over-count, which stops collection
      // early rather than overspending, so it is not retried.
      await this.o.kv.incrByFloat(this.o.key, -price, { ttlSec: this.o.ttlSec ?? 172_800 }).catch(() => undefined)
      throw new BudgetExceeded({ capUsd: this.o.capUsd, spentUsd: after - price, calls: 0, byEngine: {}, updatedAt: new Date().toISOString() }, price)
    }
  }
}
