/**
 * Hard spend ceiling for a collection run — CLAUDE.md rule R3.
 *
 * HUMAN-OWNED (CLAUDE.md §4: spend-control logic). Every provider *attempt* is
 * charged before it is made — retries included, failures included — so the
 * ledger can only over-count, never under-count. The ledger is a JSON file
 * rewritten synchronously after every charge, so a crash or restart resumes
 * against what was actually spent.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Ledger {
  capUsd: number
  spentUsd: number
  calls: number
  byEngine: Record<string, { calls: number; usd: number }>
  updatedAt: string
  /** Set once a charge was refused; a refused run never silently continues. */
  exhaustedAt?: string
}

export class BudgetExceeded extends Error {
  override readonly name: string = 'BudgetExceeded'
  constructor(readonly ledger: Ledger, readonly attemptedUsd: number, message?: string) {
    super(
      message ??
        `budget exhausted: spent $${ledger.spentUsd.toFixed(4)} of $${ledger.capUsd.toFixed(2)} cap; ` +
          `refusing a $${attemptedUsd.toFixed(4)} call`,
    )
  }
}

/**
 * THIS RUN has used its allowance of attempts (ADR-0017, 2026-09-07). A
 * subclass of BudgetExceeded so the orchestrator stops the run the same way;
 * NOT the lifetime cap, so the ledger is not marked exhausted and the next
 * run starts clean. A retry storm is stopped here, at the allowance, rather
 * than discovered afterwards in the ledger.
 */
export class RunAllowanceExceeded extends BudgetExceeded {
  override readonly name = 'RunAllowanceExceeded'
  constructor(ledger: Ledger, attemptedUsd: number, readonly runCalls: number, readonly runAllowanceCalls: number) {
    super(ledger, attemptedUsd, `run allowance exhausted: this run has made ${runCalls} of its ${runAllowanceCalls} allowed provider attempts; refusing another`)
  }
}

export class Budget {
  private ledger: Ledger
  /** Attempts charged by THIS instance, i.e. this run. Never persisted: the allowance is per run, the ledger is per data dir. */
  private runCallCount = 0

  constructor(
    private readonly file: string,
    capUsd: number,
    private readonly priceUsd: (engine: string) => number,
    private readonly now: () => Date = () => new Date(),
    /**
     * The most attempts this run may make, retries included (ADR-0017). Absent
     * means unbounded within the lifetime cap, which is what every run did
     * before 2026-09-07. Checked before the lifetime cap, so an allowance
     * refusal never marks the ledger exhausted.
     */
    private readonly runAllowanceCalls?: number,
  ) {
    if (!Number.isFinite(capUsd) || capUsd <= 0) throw new RangeError(`capUsd must be > 0, got ${capUsd}`)
    if (runAllowanceCalls !== undefined && (!Number.isInteger(runAllowanceCalls) || runAllowanceCalls < 0)) throw new RangeError(`runAllowanceCalls must be a non-negative integer, got ${runAllowanceCalls}`)
    if (existsSync(file)) {
      this.ledger = JSON.parse(readFileSync(file, 'utf8')) as Ledger
      // A cap can only be lowered by resuming with a smaller value, never raised silently.
      if (capUsd < this.ledger.capUsd) this.ledger.capUsd = capUsd
      if (capUsd > this.ledger.capUsd) {
        throw new RangeError(`ledger ${file} was opened with cap $${this.ledger.capUsd}; raise it deliberately by editing the ledger`)
      }
    } else {
      this.ledger = { capUsd, spentUsd: 0, calls: 0, byEngine: {}, updatedAt: this.now().toISOString() }
      this.persist()
    }
  }

  get state(): Readonly<Ledger> {
    return this.ledger
  }

  /** Attempts this run has charged so far. */
  get runCalls(): number {
    return this.runCallCount
  }

  /** Attempts this run may still make under its allowance; Infinity when unbounded. */
  runRemaining(): number {
    return this.runAllowanceCalls === undefined ? Number.POSITIVE_INFINITY : Math.max(0, this.runAllowanceCalls - this.runCallCount)
  }

  remainingUsd(): number {
    return Math.max(0, this.ledger.capUsd - this.ledger.spentUsd)
  }

  /** Would one more call on `engine` still fit? (No side effects.) */
  canAfford(engine: string): boolean {
    return this.ledger.spentUsd + this.priceUsd(engine) <= this.ledger.capUsd + 1e-9
  }

  /**
   * Charge one provider attempt on `engine`. Throws BudgetExceeded *before* the
   * money is spent if it would breach the cap; the caller must not call the
   * provider after a throw.
   */
  charge(engine: string): void {
    const price = this.priceUsd(engine)
    if (!Number.isFinite(price) || price < 0) throw new RangeError(`bad price for ${engine}: ${price}`)
    // The run's own allowance first: a refusal here is about this run, not the ledger, and leaves the ledger untouched.
    if (this.runAllowanceCalls !== undefined && this.runCallCount + 1 > this.runAllowanceCalls) {
      throw new RunAllowanceExceeded(this.ledger, price, this.runCallCount, this.runAllowanceCalls)
    }
    if (this.ledger.spentUsd + price > this.ledger.capUsd + 1e-9) {
      this.ledger.exhaustedAt = this.now().toISOString()
      this.persist()
      throw new BudgetExceeded(this.ledger, price)
    }
    this.ledger.spentUsd += price
    this.ledger.calls += 1
    this.runCallCount += 1
    const e = (this.ledger.byEngine[engine] ??= { calls: 0, usd: 0 })
    e.calls += 1
    e.usd += price
    this.persist()
  }

  private persist(): void {
    this.ledger.updatedAt = this.now().toISOString()
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.ledger, null, 2) + '\n')
  }
}
