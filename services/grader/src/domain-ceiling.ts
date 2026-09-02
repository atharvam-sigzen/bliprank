/**
 * A per-DOMAIN monthly ceiling on provider calls.
 *
 * ⚠️ HUMAN-OWNED AREA (CLAUDE.md §4: "Rate-limit, retry and spend-control
 * logic"). Written, tested, and flagged for review rather than merged as
 * settled.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HOLE THIS CLOSES, AND WHY THE THREE EXISTING LIMITS DO NOT.
 *
 * The cost model's scenario: five engines at ~$25/mo each, and one Growth-tier
 * customer under a bad-retry scenario exceeding the whole monthly quota alone.
 * Everything already in place fails to stop it, each for its own reason:
 *
 *   Budget (USD cap)        global and per data dir. It stops the MONTH, which
 *                           is the outcome we are trying to avoid, not a way of
 *                           avoiding it. By the time it fires, everyone is out.
 *   LocalRateBudget (rps)   a throughput limit. A retry storm spread politely
 *                           over a day never touches it and still drains the
 *                           quota.
 *   visitor-throttle (IP)   the right shape, wrong subject. One customer is
 *                           many IPs — an office, a VPN, a CI runner — and one
 *                           IP is many customers behind a NAT.
 *
 * So the missing limit is per-SUBJECT, and it counts CALLS rather than scans.
 * `Budget` already proves why: `maxAttempts: 3` means a scan's realised call
 * count is above its nominal one, and a limit denominated in scans cannot see
 * the difference between a clean scan and one that retried every cell twice.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE DOMAIN AND NOT THE CUSTOMER.
 *
 * The scenario names a customer, and a customer is what should eventually be
 * metered. There are no accounts in this build — no auth, no workspaces table,
 * no subscription — so "the customer" is not a thing this code can name, and
 * inventing an identity here would be building the tenancy model sideways, in
 * the spend path, where getting it wrong is expensive twice.
 *
 * The domain IS nameable, is the subject of every scan, and is the unit the
 * runaway actually attaches to: a retry storm is a storm about one domain. When
 * accounts exist this generalises without changing shape — the ceiling moves
 * from one domain to the sum over a customer's domains, and everything below
 * stays the same arithmetic.
 *
 * ponytail: a UTC calendar month, not a rolling 30 days. The provider's own
 * quota resets on a cycle boundary, so a ceiling that drifts against it would
 * refuse scans the provider would happily serve, and permit scans it would not.
 * Upgrade path if the provider's cycle stops being calendar-aligned: read the
 * reset date out of `readQuota` and key on that instead.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ENGINES } from '@bliprank/contracts'
import { DEFAULT_PROMPTS_PER_SCAN } from './live-gate.js'

/**
 * Full cycles one domain is allowed in a UTC month. Two, because a trend needs
 * two points and the free tier's 50 requests per engine per month cannot fund
 * a third at 17 prompts (3 × 17 = 51). ADR-0013.
 */
export const CYCLES_PER_MONTH = 2

/**
 * How far above nominal a cycle's REALISED call count may run and still leave
 * room for the next one. `Budget` charges every attempt, retries included, so
 * a cycle costs more than its cell count. Observed on the three live scans to
 * date: 1.02, 1.02 and 1.16. Set a little above the worst of those; re-derive
 * from the ledger once more cycles have run. A starting value, not a law.
 */
export const RETRY_HEADROOM = 1.2

/** Calls one full cycle draws at the default prompt count: prompts × engines. */
export const DEFAULT_CELLS_PER_CYCLE = DEFAULT_PROMPTS_PER_SCAN * ENGINES.length

/**
 * The ceiling for a given cycle size: CYCLES_PER_MONTH cycles, each allowed to
 * run RETRY_HEADROOM above nominal. Exported so a caller with a non-default
 * prompt count gets the same margin, not the default's.
 */
export const ceilingFor = (cellsPerCycle: number): number => Math.ceil(CYCLES_PER_MONTH * cellsPerCycle * RETRY_HEADROOM)

/**
 * Calls one domain may draw in a month, across all engines, when nothing
 * overrides it: 2 × 85 × 1.2 = 204 at 17 prompts on five engines.
 *
 * THE MARGIN THIS ACTUALLY PROVIDES, at 17 prompts. `checkDomainCeiling`
 * admits a scan while `used + 85 ≤ 204`, so the second cycle of a month goes
 * ahead as long as the first realised no more than 119 calls — a retry ratio of
 * 1.40 on the first cycle alone — or both cycles run at up to 1.20. Every live
 * scan so far has retried, at 1.02 to 1.16, so both fit. A third full cycle in
 * the same month is refused (2 × 85 = 170 used, 85 more needed), which is what
 * the free tier would refuse anyway.
 *
 * The previous default of 170 described itself as "two full five-engine scans
 * with a wide margin for retries" and had none: 85 + 85 = 170 exactly, so a
 * single retry in cycle one refused cycle two. It was also a bare number tied
 * to nothing, so a change to the prompt count silently changed how many cycles
 * it allowed. This one is derived from the constants it depends on.
 *
 * Still a RUNAWAY BACKSTOP against the free tier's 50 requests per engine per
 * month: 204 over five engines is 40.8 per engine, so one domain cannot empty
 * an engine's allowance on its own. That property holds up to 20 prompts;
 * above that the derived ceiling passes 50 per engine, and the provider's own
 * quota gate (`checkGate`) is what enforces the tier — this only backstops it.
 * The cache is what makes repeat scans of the same day free; a domain
 * legitimately reaching this number is a domain something is wrong with.
 */
export const DEFAULT_MAX_CALLS_PER_DOMAIN_PER_MONTH = ceilingFor(DEFAULT_CELLS_PER_CYCLE)

export interface DomainCeilingConfig {
  readonly maxCallsPerMonth: number
  readonly ledgerFile: string
}

export type CeilingVerdict =
  | { readonly ok: true; readonly used: number; readonly limit: number; readonly remaining: number }
  | {
      readonly ok: false
      readonly reason: 'domain-ceiling'
      readonly message: string
      readonly used: number
      readonly limit: number
      readonly resetsOn: string
    }

/** `{ '2026-09': { 'pipedrive.com': 85 } }` — one object per month, pruned on write. */
type Ledger = Record<string, Record<string, number>>

export const utcMonth = (now: Date): string => now.toISOString().slice(0, 7)

/** First day of the next UTC month, as an ISO date. What a refusal tells you to wait for. */
export function resetDate(now: Date): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return next.toISOString().slice(0, 10)
}

const readLedger = (f: string): Ledger => {
  try {
    if (!existsSync(f)) return {}
    const parsed: unknown = JSON.parse(readFileSync(f, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Ledger
  } catch {
    /*
     * FAIL CLOSED, and it is a different failure from the other ledgers'.
     *
     * `live-gate` and `visitor-throttle` answer a corrupt file with "treat as
     * full", which refuses everything. Here that would refuse EVERY domain for
     * the rest of the month over one bad byte, taking the whole demo down. The
     * sentinel refuses only by making the month look spent for whatever domain
     * is asked about — same conservatism, contained to the request rather than
     * applied to the product.
     */
    return { __corrupt: {} }
  }
}

/** Provider calls this domain has drawn this month. */
export function callsThisMonth(domain: string, cfg: DomainCeilingConfig, now: Date = new Date()): number {
  const l = readLedger(cfg.ledgerFile)
  if ('__corrupt' in l) return cfg.maxCallsPerMonth
  const month = l[utcMonth(now)] ?? {}
  const used = month[domain]
  return typeof used === 'number' && Number.isFinite(used) && used > 0 ? used : 0
}

/**
 * May this domain draw `needed` more calls?
 *
 * Checked BEFORE the scan, against what the scan would cost at full size, so a
 * domain near the ceiling is refused outright rather than half-collected. A
 * partial scan is a smaller `n` and a wider interval — honest, but it is a
 * measurement nobody asked for, bought with the last of an allowance.
 */
export function checkDomainCeiling(
  domain: string,
  needed: number,
  cfg: DomainCeilingConfig,
  now: Date = new Date(),
): CeilingVerdict {
  const used = callsThisMonth(domain, cfg, now)
  if (used + needed > cfg.maxCallsPerMonth) {
    return {
      ok: false,
      reason: 'domain-ceiling',
      message: `${domain} has already drawn ${used} of its ${cfg.maxCallsPerMonth} provider requests this month, and this scan needs ${needed} more. This is a per-domain ceiling, not the shared quota: it exists so one domain's repeated scans cannot use up everyone else's. It resets on ${resetDate(now)}. Nothing was collected and nothing was charged, and any scan already collected for this domain still loads instantly from cache.`,
      used,
      limit: cfg.maxCallsPerMonth,
      resetsOn: resetDate(now),
    }
  }
  return { ok: true, used, limit: cfg.maxCallsPerMonth, remaining: cfg.maxCallsPerMonth - used - needed }
}

/**
 * Record calls actually made.
 *
 * ⚠️ TAKES THE REALISED COUNT, NOT THE PLANNED ONE. `ScanCounts.providerCalls`
 * is what the orchestrator says it spent, retries included; the planned figure
 * is what `checkDomainCeiling` was asked about. Recording the plan would
 * under-count exactly the scenario this module exists for — a retry storm draws
 * three times its nominal calls and would be booked as one scan's worth.
 *
 * Only the CURRENT month is kept. A ledger that grows forever is a file someone
 * eventually has to prune by hand, and nothing reads last month.
 */
export function recordDomainCalls(domain: string, calls: number, cfg: DomainCeilingConfig, now: Date = new Date()): void {
  if (!domain || !Number.isFinite(calls) || calls <= 0) return
  const l = readLedger(cfg.ledgerFile)
  const month = utcMonth(now)
  const current = ('__corrupt' in l ? {} : l)[month] ?? {}
  const next: Ledger = { [month]: { ...current, [domain]: (current[domain] ?? 0) + calls } }
  mkdirSync(dirname(cfg.ledgerFile), { recursive: true })
  writeFileSync(cfg.ledgerFile, JSON.stringify(next, null, 2) + '\n')
}

/**
 * The ceiling in force. An explicit `GRADER_MAX_CALLS_PER_DOMAIN_PER_MONTH` is
 * absolute and wins. Otherwise the default is derived from the prompt count in
 * force — `GRADER_PROMPTS_PER_SCAN` when set — so the margin stated above holds
 * at 10 prompts and at 20, rather than only at 17.
 */
export const defaultDomainCeilingConfig = (dataDir: string, env: NodeJS.ProcessEnv = process.env): DomainCeilingConfig => {
  const explicit = env['GRADER_MAX_CALLS_PER_DOMAIN_PER_MONTH']
  const prompts = Number(env['GRADER_PROMPTS_PER_SCAN'] ?? DEFAULT_PROMPTS_PER_SCAN)
  const derived = Number.isFinite(prompts) && prompts > 0 ? ceilingFor(prompts * ENGINES.length) : DEFAULT_MAX_CALLS_PER_DOMAIN_PER_MONTH
  return {
    maxCallsPerMonth: explicit !== undefined && explicit !== '' ? Number(explicit) : derived,
    ledgerFile: join(dataDir, 'domain-ceiling.json'),
  }
}
