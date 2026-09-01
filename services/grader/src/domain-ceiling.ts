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

/**
 * Calls one domain may draw in a month, across all engines.
 *
 * 170 = ten full scans at 17 prompts on one engine, or two full five-engine
 * scans with a wide margin for retries. Set against the free tier's 50 requests
 * per engine per month: a single domain cannot exhaust one engine's allowance,
 * which is the property that matters. Deliberately generous — this is a
 * RUNAWAY BACKSTOP, and the cache is what makes repeat scans free, so a domain
 * legitimately reaching this number is a domain something is wrong with.
 */
export const DEFAULT_MAX_CALLS_PER_DOMAIN_PER_MONTH = 170

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

export const defaultDomainCeilingConfig = (dataDir: string, env: NodeJS.ProcessEnv = process.env): DomainCeilingConfig => ({
  maxCallsPerMonth: Number(env['GRADER_MAX_CALLS_PER_DOMAIN_PER_MONTH'] ?? DEFAULT_MAX_CALLS_PER_DOMAIN_PER_MONTH),
  ledgerFile: join(dataDir, 'domain-ceiling.json'),
})
