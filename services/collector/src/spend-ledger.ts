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
 * single-process paths and a shared-counter implementation for the fleet.
 *
 * FOUR THINGS ARE DELIBERATE HERE, each closing a review finding:
 *
 * 1. Choosing the unsafe implementation is an explicit, argued act. The review
 *    noted that nothing stopped a future wiring from passing `LocalSpendLedger`
 *    and silently reinstating the bug. `LocalSpendLedger` therefore has no
 *    public constructor: it is reached through `forSingleProcess()`, which
 *    demands a written reason, and which REFUSES outright when it detects a
 *    multi-instance runtime. A comment is not a guard.
 *
 * 2. Charge is increment-then-check, never check-then-increment. Two workers
 *    each increment atomically and each sees its own post-increment total, so
 *    at most one can observe a total within the cap. Check-then-increment would
 *    let both read $74.99 and both proceed.
 *
 * 3. A failed refund is loud. It still fails toward under-spending — the money
 *    stays counted, so collection stops early rather than overshooting — but
 *    silently shrinking the day's budget after a transient blip is not
 *    something anyone should have to infer from a low invoice.
 *
 * 4. The window is the ledger's business, not the caller's. Passing the date in
 *    the key meant forgetting to roll it stopped collection (safe) and rolling
 *    it wrongly reset the cap (not safe). The ledger derives the window from an
 *    injected clock.
 */

import { Budget, BudgetExceeded, type Ledger } from './budget.js'
import type { KV } from './cache-index.js'

/** Per-engine detail `/cost-audit` reconciles against the provider invoice. */
export interface SpendBreakdown {
  readonly spentUsd: number
  readonly calls: number
  readonly byEngine: Record<string, { calls: number; usd: number }>
  /** Which window these totals belong to, e.g. `2026-08-21`. */
  readonly window: string
}

export interface SpendLedger {
  /**
   * Reserve the cost of one call before it is made. Throws `BudgetExceeded`
   * when the cap would be breached; the caller must not proceed.
   */
  charge(engine: string): Promise<void>
  spentUsd(): Promise<number>
  /** Everything `/cost-audit` needs to reconcile against an invoice. */
  breakdown(): Promise<SpendBreakdown>
  readonly capUsd: number
}

/** Emitted when spend control degrades. Wire to Sentry / Better Stack. */
export interface SpendAlert {
  readonly kind: 'refund-failed' | 'cap-reached' | 'undeclared-topology-override' | 'charge-failed' | 'clock-skew'
  readonly engine: string
  readonly usd: number
  readonly window: string
  readonly message: string
}

export type AlertSink = (alert: SpendAlert) => void

const defaultAlertSink: AlertSink = (a) => {
  // eslint-disable-next-line no-console -- an unreported spend fault is worse than a log line
  console.error(`[spend:${a.kind}] ${a.message}`)
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

export type SpendWindow = 'daily' | 'hourly' | 'total'

/**
 * The window key, derived here so it cannot drift. UTC throughout, matching the
 * cache key's `date_bucket` (ADR-0003) — a spend day and a collection day being
 * different days would make the ledger impossible to reconcile.
 */
export function windowKey(window: SpendWindow, now: Date): string {
  const iso = now.toISOString()
  if (window === 'total') return 'total'
  return window === 'hourly' ? iso.slice(0, 13) : iso.slice(0, 10)
}

// ---------------------------------------------------------------------------
// Multi-instance detection
// ---------------------------------------------------------------------------

/**
 * Topology is DECLARED, not guessed.
 *
 * The first version of this guard inferred "am I in a fleet?" from a list of
 * PaaS environment markers. A review killed it: the P5 target is a Hetzner CAX
 * fleet (ADR-0002), and a bare ARM VM sets none of those markers — so
 * `detectMultiInstanceRuntime` returned null, null read as "safe", and worker 7
 * of 12 would have sailed through with a full private budget. That is the exact
 * bug this file exists to close, reinstated on the one topology it was written
 * for, by a guard that fails OPEN.
 *
 * So the default is now `undeclared`, and `undeclared` is refused. A deployment
 * has to say what it is. The marker list survives only as an override-proof
 * veto: it can force `fleet`, it can never grant `single-process`.
 */
export type RuntimeTopology = 'single-process' | 'fleet' | 'undeclared'

/** Markers that PROVE a fleet. Absence proves nothing — see above. */
const FLEET_MARKERS = ['VERCEL', 'VERCEL_ENV', 'AWS_LAMBDA_FUNCTION_NAME', 'AWS_EXECUTION_ENV', 'K_SERVICE', 'FUNCTIONS_WORKER_RUNTIME', 'FLY_ALLOC_ID', 'DYNO'] as const

/** The env var a deployment sets to declare itself. */
export const TOPOLOGY_ENV = 'COLLECTOR_TOPOLOGY'

export function detectMultiInstanceRuntime(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const marker of FLEET_MARKERS) if (env[marker]) return marker
  return null
}

/**
 * Resolve the topology. A detected PaaS marker wins over any declaration —
 * a process cannot declare its way out of being on Lambda.
 */
export function resolveTopology(env: NodeJS.ProcessEnv = process.env): { topology: RuntimeTopology; because: string } {
  const marker = detectMultiInstanceRuntime(env)
  if (marker) return { topology: 'fleet', because: `${marker} is set` }
  const declared = env[TOPOLOGY_ENV]
  if (declared === 'single-process') return { topology: 'single-process', because: `${TOPOLOGY_ENV}=single-process` }
  if (declared === 'fleet') return { topology: 'fleet', because: `${TOPOLOGY_ENV}=fleet` }
  if (declared) return { topology: 'undeclared', because: `${TOPOLOGY_ENV}="${declared}" is not a recognised value` }
  return { topology: 'undeclared', because: `${TOPOLOGY_ENV} is not set` }
}

export class UnsafeSpendLedgerError extends Error {
  override readonly name = 'UnsafeSpendLedgerError'
}

// ---------------------------------------------------------------------------
// Local (single process)
// ---------------------------------------------------------------------------

/**
 * Single-process ledger over the file-backed `Budget`. Correct for the pilot
 * runner and for tests, and WRONG anywhere more than one process can run.
 *
 * The constructor is private. `forSingleProcess()` is the only way in, it wants
 * a reason in writing, and it throws when a fleet runtime is detected. Reaching
 * for the unsafe version is meant to feel like a decision.
 */
export class LocalSpendLedger implements SpendLedger {
  private constructor(readonly budget: Budget) {}

  /**
   * @param reason why a per-process cap is acceptable here. Recorded in the
   *   error if the guard later fires, so the argument is available to whoever
   *   has to judge it.
   */
  /**
   * @param ack.reason why a per-process cap is acceptable here. Quoted back in
   *   the refusal, so the argument reaches whoever has to judge it.
   */
  static forSingleProcess(
    budget: Budget,
    ack: {
      readonly iUnderstandThisCapIsPerProcess: true
      readonly reason: string
      /**
       * Last resort for a runtime that genuinely is one process but cannot set
       * COLLECTOR_TOPOLOGY. Cannot override a detected PaaS marker, and always
       * alerts — this is meant to leave a trail, not to be convenient.
       */
      readonly overrideUndeclaredTopology?: boolean
      readonly env?: NodeJS.ProcessEnv
      readonly onAlert?: AlertSink
    },
  ): LocalSpendLedger {
    if (!ack.reason.trim()) {
      throw new UnsafeSpendLedgerError('LocalSpendLedger.forSingleProcess requires a written reason: this cap is enforced per process, not globally.')
    }
    const alert = ack.onAlert ?? defaultAlertSink
    const { topology, because } = resolveTopology(ack.env)

    if (topology === 'fleet') {
      throw new UnsafeSpendLedgerError(
        `refusing a per-process spend cap: ${because}, so each instance would get its own full budget (rule R3). ` +
          `Use KvSpendLedger. Stated reason for the local ledger was: "${ack.reason}".`,
      )
    }

    if (topology === 'undeclared') {
      if (!ack.overrideUndeclaredTopology) {
        // Fails CLOSED. A self-hosted worker looks exactly like a laptop from
        // in here, and guessing wrong costs a full cap per worker.
        throw new UnsafeSpendLedgerError(
          `refusing a per-process spend cap: ${because}, so this process cannot show it is the only one. ` +
            `Set ${TOPOLOGY_ENV}=single-process on a runtime that really is one process, or use KvSpendLedger. ` +
            `A bare VM or container sets no PaaS marker, so absence of one is not evidence. Stated reason was: "${ack.reason}".`,
        )
      }
      alert({
        kind: 'undeclared-topology-override',
        engine: '-',
        usd: 0,
        window: 'n/a',
        message: `per-process spend cap used with ${because}: "${ack.reason}". If more than one instance runs this, the USD ceiling is NOT global.`,
      })
    }

    return new LocalSpendLedger(budget)
  }

  async charge(engine: string): Promise<void> {
    this.budget.charge(engine)
  }
  async spentUsd(): Promise<number> {
    return this.budget.state.spentUsd
  }
  async breakdown(): Promise<SpendBreakdown> {
    const l: Ledger = this.budget.state
    return { spentUsd: l.spentUsd, calls: l.calls, byEngine: l.byEngine, window: 'process' }
  }
  get capUsd(): number {
    return this.budget.state.capUsd
  }
}

// ---------------------------------------------------------------------------
// Shared counter (fleet)
// ---------------------------------------------------------------------------

export interface KvSpendLedgerOptions {
  readonly kv: KV
  readonly capUsd: number
  readonly priceUsd: (engine: string) => number
  /** Key prefix only. The window suffix is derived here, never passed in. */
  readonly keyPrefix?: string
  readonly window?: SpendWindow
  readonly now?: () => Date
  /** Engines to report in the breakdown even when they have spent nothing. */
  readonly engines?: readonly string[]
  readonly ttlSec?: number
  readonly onAlert?: AlertSink
}

/**
 * Fleet-safe ledger over atomic shared counters (Upstash Redis in production).
 *
 * One round-trip per charge, carrying three increments: the authoritative
 * total, the per-engine USD, and the per-engine call count. Only the total
 * gates the cap, so the batch does not need to be a transaction.
 */
export class KvSpendLedger implements SpendLedger {
  private readonly prefix: string
  private readonly window: SpendWindow
  private readonly now: () => Date
  private readonly ttl: number
  private readonly alert: AlertSink
  /** Last window this instance verified against the shared high-water mark. */
  private verifiedWindow: string | null = null

  constructor(private readonly o: KvSpendLedgerOptions) {
    this.prefix = o.keyPrefix ?? 'spend'
    this.window = o.window ?? 'daily'
    this.now = o.now ?? (() => new Date())
    this.ttl = o.ttlSec ?? 172_800
    this.alert = o.onAlert ?? defaultAlertSink
  }

  get capUsd(): number {
    return this.o.capUsd
  }

  /** The current window, recomputed on every call so a long-lived worker rolls. */
  currentWindow(): string {
    return windowKey(this.window, this.now())
  }

  private totalKey(w: string): string {
    return `${this.prefix}:${w}:total`
  }
  private get highWaterKey(): string {
    return `${this.prefix}:window-high-water`
  }

  /**
   * Guard against a worker whose clock is wrong.
   *
   * On self-managed infrastructure there is no managed NTP. A worker whose
   * clock is stuck or drifts backwards keeps writing to a stale window key,
   * which is isolated from the counter every correctly-clocked sibling shares —
   * so it quietly gets its own private cap, and gets a fresh one every time the
   * stale key expires. The shared high-water mark is what makes that visible.
   *
   * Checked once per window transition, not per charge: the failure mode is a
   * clock, which does not change between two calls a millisecond apart, and a
   * round-trip on every charge would be real money at 20M calls/month.
   *
   * Windows are ISO-prefixed, so string order is time order.
   */
  private async verifyWindow(w: string): Promise<string> {
    if (this.verifiedWindow === w) return w
    const seen = await this.o.kv.get(this.highWaterKey)
    if (seen && seen > w) {
      this.alert({
        kind: 'clock-skew',
        engine: '-',
        usd: 0,
        window: w,
        message:
          `this process derived window ${w} but the shared ledger has already reached ${seen} — its clock is behind. ` +
          `Charging against ${seen} instead, so it shares the real cap rather than getting a private one. Fix NTP on this host.`,
      })
      this.verifiedWindow = seen
      return seen
    }
    if (!seen || w > seen) await this.o.kv.set(this.highWaterKey, w, { ttlSec: this.ttl })
    this.verifiedWindow = w
    return w
  }
  private engineUsdKey(w: string, engine: string): string {
    return `${this.prefix}:${w}:e:${engine}:usd`
  }
  private engineCallsKey(w: string, engine: string): string {
    return `${this.prefix}:${w}:e:${engine}:calls`
  }

  async spentUsd(): Promise<number> {
    const raw = await this.o.kv.get(this.totalKey(this.currentWindow()))
    return raw === null ? 0 : Number(raw)
  }

  async breakdown(): Promise<SpendBreakdown> {
    const w = this.currentWindow()
    const engines = [...new Set(this.o.engines ?? [])]
    const keys = [this.totalKey(w), ...engines.flatMap((e) => [this.engineUsdKey(w, e), this.engineCallsKey(w, e)])]
    const values = await this.o.kv.mget(keys)
    const byEngine: Record<string, { calls: number; usd: number }> = {}
    let calls = 0
    engines.forEach((e, i) => {
      const usd = Number(values[1 + i * 2] ?? 0)
      const c = Number(values[2 + i * 2] ?? 0)
      byEngine[e] = { calls: c, usd }
      calls += c
    })
    return { spentUsd: Number(values[0] ?? 0), calls, byEngine, window: w }
  }

  async charge(engine: string): Promise<void> {
    const price = this.o.priceUsd(engine)
    const w = await this.verifyWindow(this.currentWindow())
    const totalKey = this.totalKey(w)

    let after: number | undefined
    try {
      ;[after] = await this.o.kv.incrManyByFloat(
        [
          { key: totalKey, delta: price },
          { key: this.engineUsdKey(w, engine), delta: price },
          { key: this.engineCallsKey(w, engine), delta: 1 },
        ],
        { ttlSec: this.ttl },
      )
    } catch (e) {
      // The batch is not a transaction, so the total may already have been
      // incremented server-side before the failure. That can only over-count,
      // never breach the cap — but the refund path in this same file is loud
      // and this one was silent, which is inconsistent. Alert, then rethrow so
      // the caller still refuses the call.
      this.alert({
        kind: 'charge-failed',
        engine,
        usd: price,
        window: w,
        message:
          `charge of $${price.toFixed(4)} (${engine}) failed mid-batch: ${(e as Error).message}. ` +
          `Part of it may have applied, so window ${w} can over-count by up to that amount. Fails safe (under-spend); self-corrects at the next window roll.`,
      })
      throw e
    }
    const total = after ?? 0

    if (total > this.o.capUsd) {
      // Refund all three. Failing to refund over-counts, which stops collection
      // early rather than overspending — the right direction, but it silently
      // shrinks the remaining budget, so it is reported rather than swallowed.
      try {
        await this.o.kv.incrManyByFloat(
          [
            { key: totalKey, delta: -price },
            { key: this.engineUsdKey(w, engine), delta: -price },
            { key: this.engineCallsKey(w, engine), delta: -1 },
          ],
          { ttlSec: this.ttl },
        )
      } catch (e) {
        this.alert({
          kind: 'refund-failed',
          engine,
          usd: price,
          window: w,
          message:
            `refund of $${price.toFixed(4)} (${engine}) failed after a refused charge: ${(e as Error).message}. ` +
            `The ledger for window ${w} now over-counts by that amount, so the remaining cap is smaller than it should be. ` +
            `Fails safe (under-spend), but the ceiling is no longer the configured one.`,
        })
      }
      this.alert({ kind: 'cap-reached', engine, usd: price, window: w, message: `spend cap $${this.o.capUsd} reached for window ${w}; refusing further calls.` })
      throw new BudgetExceeded({ capUsd: this.o.capUsd, spentUsd: total - price, calls: 0, byEngine: {}, updatedAt: this.now().toISOString() }, price)
    }
  }
}
