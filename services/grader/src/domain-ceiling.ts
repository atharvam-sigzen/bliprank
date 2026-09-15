/**
 * A per-DOMAIN monthly ceiling on HAND-STARTED cycles, and the per-run
 * allowance that bounds one cycle's realised calls.
 *
 * ⚠️ HUMAN-OWNED AREA (CLAUDE.md §4: "Rate-limit, retry and spend-control
 * logic"). Written, tested, and flagged for review rather than merged as
 * settled.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR — decided 2026-09-07 (ADR-0017).
 *
 * The ceiling exists so one domain's repeated hand-started scans cannot use
 * up everyone else's quota: a person pressing "Collect a new cycle" many
 * times, from many browsers, over many hours, which the per-visitor throttle
 * cannot see (one customer is many IPs) and the daily burst cap cannot see
 * (it counts new domains, not repeats of one). It is sized for OCCASIONAL
 * MANUAL CYCLES: `CYCLES_PER_MONTH` of them, because a trend needs two points
 * and the free tier could not fund a third at 17 prompts.
 *
 * It is NOT the daily loop's bound. The loop (`daily-loop.ts`) has its own:
 * one cycle per UTC day, a daily cap in dollars derived from the tracked set
 * and bounded by the owner's hard ceiling, and this file's per-run allowance.
 * A loop-started cycle is never booked here; a manual one never books there.
 * The two usage patterns are different questions and got tangled when this
 * ceiling was denominated in calls with a limit that followed the cycle size:
 * ADR-0017 works the three failures with real numbers (an unfair refusal when
 * a prompt set shrank, an over-collection nobody decided when it grew, and a
 * loop refused from the third day of every month).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DENOMINATED IN CYCLES, WITH EACH CYCLE'S CALLS BOUNDED SEPARATELY.
 *
 * Two questions, two bounds, because they have different owners:
 *
 *   HOW MANY TIMES this month may a domain be hand-collected?  → this ledger,
 *   counting cycles that reached the provider. A change to the domain's
 *   prompt set (ADR-0016) changes what a cycle costs and never how many it
 *   gets, so neither of the two mid-month failures can happen.
 *
 *   HOW MANY CALLS may ONE cycle realise, retries included?  → the per-run
 *   allowance, `runAllowanceFor(cells) = ceil(cells × RETRY_HEADROOM)`,
 *   enforced inside the collector's `Budget` before every attempt, so a retry
 *   storm is stopped at the allowance rather than discovered in the ledger.
 *
 * The realised call count is still recorded beside the cycle count, so the
 * retry ratio every cycle actually ran at stays visible and `RETRY_HEADROOM`
 * can be re-derived from evidence.
 *
 * ponytail: a UTC calendar month, not a rolling 30 days. The provider's own
 * quota resets on a cycle boundary, so a ceiling that drifts against it would
 * refuse scans the provider would happily serve, and permit scans it would not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHOSE CEILING — decided by the oversight session, 2026-09-15 (MVP_PLAN B3d
 * item 1, ADR-0017 Amendment 2): ADMISSION IS PER WORKSPACE, THE MONEY IS
 * BOUNDED DEPLOYMENT-WIDE. The ledger is the deployment's, and keyed by bare
 * host it made one workspace's two hand-started cycles of a host refuse every
 * other workspace tracking the same host for the rest of the month, and made
 * the refusal a one-bit oracle that someone else scans it (B3c tenancy audit,
 * MAJOR 2). The key is now `${workspaceId}:${host}`; the dollars stay bounded
 * for everyone at once by the daily cap and the per-run allowance, which is
 * where a shared provider quota belongs. On a machine the workspace is
 * `local` and the key is the bare host, which is what the file has always
 * held, so a machine's month is unchanged.
 */

import { CORRUPT, fileLedgerDoc, type LedgerDoc } from './ledger-doc.js'
import type { LedgerStores } from './ledger-stores.js'
import { dirname, join } from 'node:path'
import { ENGINES } from '@bliprank/contracts'
import { DEFAULT_PROMPTS_PER_SCAN } from './live-gate.js'

/**
 * Hand-started cycles one domain is allowed in a UTC month. Two, because a
 * trend needs two points and the free tier's 50 requests per engine per month
 * cannot fund a third at 17 prompts (3 × 17 = 51). ADR-0013. The daily loop
 * does not count against this; it has its own bounds.
 */
export const CYCLES_PER_MONTH = 2

/**
 * How far above nominal a cycle's REALISED call count may run. `Budget`
 * charges every attempt, retries included, so a cycle costs more than its
 * cell count. Observed on the three live scans to date: 1.02, 1.02 and 1.16.
 * Set a little above the worst of those; re-derive from the ledger once more
 * cycles have run. A starting value, not a law.
 */
export const RETRY_HEADROOM = 1.2

/** Calls one full cycle draws at the default prompt count: prompts × engines. */
export const DEFAULT_CELLS_PER_CYCLE = DEFAULT_PROMPTS_PER_SCAN * ENGINES.length

/**
 * The per-run allowance: the most calls one cycle of this many cells may
 * realise, retries included. Enforced by the collector's `Budget` before every
 * attempt (`runAllowanceCalls`), so it bounds spend, not only who starts.
 * 102 at 17 prompts on five engines.
 */
export const runAllowanceFor = (cellsPerCycle: number): number => Math.ceil(cellsPerCycle * RETRY_HEADROOM)

/** The workspace of a machine with identity off: the machine is the tenant (apps/public/lib/workspace-access.ts). */
export const LOCAL_WORKSPACE = 'local'

/** Whose cycles of which host: the ledger is keyed by both (B3d item 1). */
export interface CeilingSubject {
  readonly workspaceId: string
  readonly host: string
}

/** The ledger key: `${workspaceId}:${host}` on a deployment, the bare host on a machine, whose file has always been keyed so. */
export const ceilingKey = (s: CeilingSubject): string => (s.workspaceId === LOCAL_WORKSPACE ? s.host : `${s.workspaceId}:${s.host}`)

export interface DomainCeilingConfig {
  readonly maxCyclesPerMonth: number
  readonly ledgerFile: string
  /** Where the ledger lives; the file at `ledgerFile` when absent (MVP_PLAN B3b). */
  readonly ledger?: LedgerDoc
  /** Cells one cycle drew when a pre-split ledger (a bare call count) was written; how many cycles that count implies. Defaults to the default cycle size. */
  readonly legacyCellsPerCycle?: number
}

export type CeilingVerdict =
  | { readonly ok: true; readonly cycles: number; readonly calls: number; readonly limit: number }
  | {
      readonly ok: false
      readonly reason: 'domain-ceiling'
      readonly message: string
      readonly cycles: number
      readonly limit: number
      readonly resetsOn: string
    }

/**
 * `{ '2026-09': { 'pipedrive.com': { cycles: 1, calls: 85 } } }` — one object
 * per month, pruned on write. A file from before 2026-09-07 holds a bare call
 * count per domain; it is read as the nearest whole number of default-size
 * cycles, at least one, so a domain mid-month keeps the history it had.
 */
type Entry = { readonly cycles: number; readonly calls: number }
type Ledger = Record<string, Record<string, Entry | number>>

export const utcMonth = (now: Date): string => now.toISOString().slice(0, 7)

/** First day of the next UTC month, as an ISO date. What a refusal tells you to wait for. */
export function resetDate(now: Date): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return next.toISOString().slice(0, 10)
}

const docOf = (cfg: DomainCeilingConfig): LedgerDoc => cfg.ledger ?? fileLedgerDoc(cfg.ledgerFile)
const shapeLedger = (parsed: unknown): Ledger => (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) ? {} : (parsed as Ledger))
const readLedger = async (cfg: DomainCeilingConfig): Promise<Ledger | { readonly __corrupt: true }> => {
  try {
    return shapeLedger(await docOf(cfg).read())
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
    return { __corrupt: true }
  }
}

const shape = (v: Entry | number | undefined, cellsPerCycle: number): Entry => {
  // A bare count from before the split: the nearest whole number of cycles at the size in force, at least one. 97 calls is one cycle that retried, not two.
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? { cycles: Math.max(1, Math.round(v / cellsPerCycle)), calls: v } : { cycles: 0, calls: 0 }
  if (typeof v === 'object' && v !== null) {
    const cycles = typeof v.cycles === 'number' && Number.isFinite(v.cycles) && v.cycles > 0 ? Math.floor(v.cycles) : 0
    const calls = typeof v.calls === 'number' && Number.isFinite(v.calls) && v.calls > 0 ? v.calls : 0
    return { cycles, calls }
  }
  return { cycles: 0, calls: 0 }
}

/** Hand-started cycles this workspace has run of this host this month, and the calls they realised. */
export async function cyclesThisMonth(subject: CeilingSubject, cfg: DomainCeilingConfig, now: Date = new Date()): Promise<Entry> {
  const l = await readLedger(cfg)
  if ('__corrupt' in l) return { cycles: cfg.maxCyclesPerMonth, calls: 0 }
  return shape(l[utcMonth(now)]?.[ceilingKey(subject)], cfg.legacyCellsPerCycle ?? DEFAULT_CELLS_PER_CYCLE)
}

/**
 * May this workspace hand-collect this host again this month? Checked BEFORE
 * the scan; a host at its count is refused outright rather than half-collected.
 */
export async function checkDomainCeiling(subject: CeilingSubject, cfg: DomainCeilingConfig, now: Date = new Date()): Promise<CeilingVerdict> {
  const used = await cyclesThisMonth(subject, cfg, now)
  if (used.cycles >= cfg.maxCyclesPerMonth) {
    return {
      ok: false,
      reason: 'domain-ceiling',
      // The count is this workspace's own since B3d item 1, so it could be
      // said; the sentence still carries only the ceiling and the reset date,
      // and the verdict carries the numbers for the caller's own log.
      message: `This workspace has started its ${cfg.maxCyclesPerMonth} hand-started ${cfg.maxCyclesPerMonth === 1 ? 'cycle' : 'cycles'} of ${subject.host} this month. This is a per-domain ceiling on manual cycles, not the shared quota: it exists so one domain's repeated scans cannot use up everyone else's. It resets on ${resetDate(now)}. Nothing was collected and nothing was charged, and any scan already collected for this domain still loads instantly from cache.`,
      cycles: used.cycles,
      limit: cfg.maxCyclesPerMonth,
      resetsOn: resetDate(now),
    }
  }
  return { ok: true, cycles: used.cycles, calls: used.calls, limit: cfg.maxCyclesPerMonth }
}

/**
 * Record one hand-started cycle that reached the provider, with the calls it
 * REALISED, retries included. A cycle served entirely from cache made no call
 * and consumed no allowance, so the caller records only when `providerCalls`
 * is positive. Only the current month is kept.
 */
export async function recordDomainCycle(subject: CeilingSubject, calls: number, cfg: DomainCeilingConfig, now: Date = new Date()): Promise<void> {
  if (!subject.host || !subject.workspaceId || !Number.isFinite(calls) || calls <= 0) return
  const key = ceilingKey(subject)
  await docOf(cfg).update((raw) => {
    const l: Ledger = raw === CORRUPT ? {} : shapeLedger(raw)
    const month = utcMonth(now)
    const current = l[month] ?? {}
    const was = shape(current[key], cfg.legacyCellsPerCycle ?? DEFAULT_CELLS_PER_CYCLE)
    const next: Ledger = { [month]: { ...current, [key]: { cycles: was.cycles + 1, calls: was.calls + calls } } }
    return next
  })
}

/**
 * The ceiling in force. `GRADER_MAX_CYCLES_PER_DOMAIN_PER_MONTH` overrides the
 * constant; it is a count of cycles, not calls. The pre-split key,
 * `GRADER_MAX_CALLS_PER_DOMAIN_PER_MONTH`, is an ERROR when set: a person who
 * set it meant a number of calls, and silently reading it as nothing would
 * give them two cycles with no word said.
 */
export const defaultDomainCeilingConfig = (dataDir: string, env: NodeJS.ProcessEnv = process.env, ledgers?: LedgerStores): DomainCeilingConfig => {
  const old = env['GRADER_MAX_CALLS_PER_DOMAIN_PER_MONTH']
  if (old !== undefined && old !== '') {
    throw new Error(`GRADER_MAX_CALLS_PER_DOMAIN_PER_MONTH=${old} is no longer read: the per-domain ceiling counts hand-started cycles since 2026-09-07 (ADR-0017). Unset it, and set GRADER_MAX_CYCLES_PER_DOMAIN_PER_MONTH to a number of cycles if two is not right.`)
  }
  const explicit = Number(env['GRADER_MAX_CYCLES_PER_DOMAIN_PER_MONTH'])
  const prompts = Number(env['GRADER_PROMPTS_PER_SCAN'] ?? DEFAULT_PROMPTS_PER_SCAN)
  return {
    maxCyclesPerMonth: Number.isInteger(explicit) && explicit > 0 ? explicit : CYCLES_PER_MONTH,
    ledgerFile: join(dataDir, 'domain-ceiling.json'),
    ...(ledgers ? { ledger: ledgers.doc('domain-ceiling.json') } : {}),
    legacyCellsPerCycle: Number.isFinite(prompts) && prompts > 0 ? prompts * ENGINES.length : DEFAULT_CELLS_PER_CYCLE,
  }
}
