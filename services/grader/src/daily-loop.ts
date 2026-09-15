/**
 * THE DAILY LOOP — one tick: the due list, a spend cap derived from the
 * tracked set, and the cycles actually run, each through the gates a person's
 * click meets. ADR-0017, decisions 1 and 2 (confirmed 2026-09-07); ADR-0018,
 * the same loop as two signed jobs on a function host.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ THE CAP IS A FORMULA, AND IT GATES. The day's cap is the expected cost of
 * every TRACKED domain's cycle — its real prompt count, curated plus its own,
 * on the engines a cycle asks, at the plan's marginal price — times
 * `RETRY_HEADROOM`, recomputed on every tick from the tracked list, so
 * switching a domain on raises the cap by exactly its cost and switching one
 * off lowers it. And it is bounded above by `COLLECTION_BUDGET_USD_DAILY`,
 * the hard ceiling CLAUDE.md §7 has documented since the start and nothing
 * read until now: a live tick REFUSES when it is unset, because a formula
 * that grows with whatever is tracked is a bill, not a budget, and the owner
 * names the budget. Enforced before each domain: a cycle whose expected cost,
 * with headroom, does not fit in what is left is refused; the ledger is
 * written after each domain so a crash cannot lose a spend. Realised spend is
 * what the runner's own ledger says the cycle cost; when that figure is
 * unknown the expected cost with headroom is booked, because under-booking
 * is the direction that overspends.
 *
 * ⚠️ THE CAP BOUNDS EACH RUN TOO, since 2026-09-07. Before a domain starts,
 * the loop hands the runner a per-run allowance of attempts: the cycle's cells
 * with retry headroom, or fewer when what is left of the day's cap would not
 * pay for that many at the cycle's mean price per attempt. The collector's
 * `Budget` refuses the attempt that would exceed it, so a retry storm inside
 * one run is stopped at the allowance, and the day's realised spend cannot
 * exceed the cap by more than the retries' price spread (about $0.02 a run
 * at pay-as-you-go). The tick still refuses to start at
 * all when the runner's lifetime ledger is exhausted or holds less than the
 * day's cap, so a loop cannot run daily to zero effect.
 *
 * The loop never books the MANUAL per-domain ceiling (`domain-ceiling.ts`):
 * that ceiling counts hand-started cycles and is sized for occasional manual
 * use. The loop's bounds are one cycle per UTC day, this cap, and the
 * allowance. Two usage patterns, two sets of bounds (ADR-0017).
 *
 * ⚠️ THE LEDGER IS WRITTEN WHERE THE DEPLOYMENT CAN REACH IT, AND EVERY WRITE
 * FOLDS (B3c item 3). The tick lock is a lease in the store's own ledger
 * document, taken under that document's lock (a setnx with a TTL on KV), so
 * two instances of a deployment cannot both tick; and a domain is admitted
 * by ONE exclusive write that reads the day's total as it is stored, books
 * the expected cost, and is settled to the realised figure afterwards, so
 * two ticks over one ledger can never each authorise the full cap. The
 * first version held a file on local disk and replaced the whole ledger
 * with its own snapshot, which on the KV backend was a lock per instance and
 * a cap per tick.
 *
 * ⚠️ ONE LOOP, TWO TRANSPORTS (ADR-0018). `runTick` is the loop as one
 * process: a person's `pnpm grader:tick` over one store. `runFanOut` and
 * `runDomainJob` are the same loop as the two signed jobs a function host
 * runs: the fan-out decides the day (the tracked list, the due list per
 * workspace, the cap, the day's entry in the ledger) under the tick lease and
 * publishes one domain job per due domain; each domain job re-decides its
 * one host, reserves under the cap the fan-out stored, and runs the same
 * per-domain path (`runAdmitted`) the tick runs — the gate, the allowance,
 * the runner, the cycle filed, the reservation settled. What differs is only
 * what a transport's retry means: a second in-process tick is a person's
 * second command, so a host whose earlier attempt today finished is admitted
 * again; a domain job's second delivery is QStash retrying, so ANY line for
 * the host today refuses it (`reserveJob`), because the first attempt may
 * have spent and a non-2xx would have bought a retry (R3).
 *
 * ⚠️ FAIL CLOSED, LIKE THE GATES IT REUSES. A ledger that cannot be read is a
 * refusal for the whole tick; an environment that cannot size a scan is a
 * refusal; a second tick while one holds the tick lease is a refusal; a live
 * tick needs the loop ARMED (`GRADER_DAILY_LOOP=armed`), both collection
 * flags, a provider key, a plan, the hard daily ceiling, a runner ledger with
 * room, and today's date, and refuses without any one of them. Nothing here
 * defaults to running.
 *
 * ⚠️ WHAT THIS DOES NOT DO. It does not register itself with any scheduler.
 * The schedule that would call the route daily is registered by a person,
 * once, with `pnpm grader:schedule -- --register`, and the deployment is
 * armed by the owner setting `GRADER_DAILY_LOOP=armed` there (ADR-0018 D8).
 * The loop is a process that runs to completion and exits; it holds no timer.
 *
 * Offline verification runs the same loop with `mode: 'fixture'`: no flags, no
 * key, the fixture adapter, a scratch store. The gates that talk to the
 * provider are skipped offline because there is no provider; every other gate
 * runs.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OwnPlan } from '@bliprank/collector'
import { ENGINES } from '@bliprank/contracts'
import { CORRUPT } from './ledger-doc.js'
import { ledgerStores, type LedgerStores } from './ledger-stores.js'
import { cycleInputOf } from './store/documents.js'
import { defaultWorkspaceStore } from './store/file-store.js'
import type { WorkspaceStore } from './store/pg-store.js'
import { ceilingKey, RETRY_HEADROOM, runAllowanceFor } from './domain-ceiling.js'
import { decideDueIn, dueToday, dueTodayIn, readTrackedIn, TRACKED, type DueDomain, type DueList, type TrackedEntry } from './due.js'
import { checkGate, defaultGateConfig, ledgerCapUsd, recordScan, utcDay, type GateConfig, type GateVerdict } from './live-gate.js'
import { loadApiKey } from './load-key.js'
import { runGrader, type RunnerOptions } from './run.js'
import type { ScanResult } from './scan.js'

export const ARMED = 'armed'
/** The route's offline mode (ADR-0018 D7): the same two jobs through the fixture adapter, honoured only with identity off. */
export const FIXTURE = 'fixture'

export type TickMode = 'live' | 'fixture'

/** How a route reads the loop's mode from its environment: `armed` is live, `fixture` is offline, anything else is off (ADR-0018 D7). */
export function loopModeOf(env: NodeJS.ProcessEnv): TickMode | null {
  const v = env['GRADER_DAILY_LOOP']
  return v === ARMED ? 'live' : v === FIXTURE ? 'fixture' : null
}

// ---------------------------------------------------------------- the jobs (ADR-0018 D1)

/** The scheduled job: QStash delivers this body once a day; the fan-out decides the day and publishes the domain jobs. */
export interface FanOutJob {
  readonly v: 1
  readonly kind: 'fan-out'
}

/** One due domain, in one workspace, for one UTC day: the loop's per-domain path in its own invocation. */
export interface DomainJob {
  readonly v: 1
  readonly kind: 'domain'
  readonly day: string
  readonly workspaceId: string
  readonly host: string
}

export type TickJob = FanOutJob | DomainJob

export const FAN_OUT_JOB: FanOutJob = { v: 1, kind: 'fan-out' }

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/

/** The two shapes and nothing else: a body that is neither is `400`, and a field beyond these is a field nothing reads. */
export function isTickJob(x: unknown): x is TickJob {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false
  const j = x as { readonly v?: unknown; readonly kind?: unknown; readonly day?: unknown; readonly workspaceId?: unknown; readonly host?: unknown }
  if (j.v !== 1) return false
  if (j.kind === 'fan-out') return true
  return j.kind === 'domain' && typeof j.day === 'string' && DAY_SHAPE.test(j.day) && typeof j.workspaceId === 'string' && j.workspaceId.length > 0 && typeof j.host === 'string' && j.host.length > 0
}

/**
 * The order the fan-out publishes in rotates with the day (C2 tenancy review,
 * MAJOR-1 interim): under a cap that binds, first-come admission in a fixed
 * order would starve whichever workspace's entries sit last in the tracked
 * document every day. Rotation is fairness in expectation, not a share of the
 * cap per workspace — that share is entitlement (D2) and an owner's decision.
 */
export function rotateByDay<T>(items: readonly T[], day: string): T[] {
  if (items.length < 2) return [...items]
  const k = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000) % items.length
  return [...items.slice(k), ...items.slice(0, k)]
}

/** QStash's own guard against the same job twice within its ten-minute window (ADR-0018 D10, guard 1). */
export const tickDeduplicationId = (job: DomainJob): string => `tick:${job.day}:${job.workspaceId}:${job.host}`

// ---------------------------------------------------------------- the daily ledger

/** The fan-out's mark on a day (ADR-0018 D3): opened before the domain jobs are published, closed after, so a fan-out that died mid-way is re-run and one that finished is not. */
export interface FanOutMark {
  readonly startedAt: string
  readonly publishedAt: string | null
  readonly published: number
  /** domain jobs the fan-out could not publish (QStash refused: its plan's message cap, an outage). Never reserved, never spent, and without this line invisible (C2 cost review). */
  readonly failed: number
}

export interface DailyLedgerDay {
  readonly capUsd: number
  readonly spentUsd: number
  readonly calls: number
  readonly domains: Readonly<Record<string, { readonly spentUsd: number; readonly calls: number; readonly status: string; readonly at: string }>>
  readonly fanOut?: FanOutMark
}
type DailyLedger = Record<string, DailyLedgerDay>

type DomainEntry = DailyLedgerDay['domains'][string]

/**
 * THE DAY'S LINE FOR ONE CYCLE is keyed by the workspace and the host, the
 * shape the per-domain ceiling uses (`ceilingKey`, B3d item 1): the bare host
 * on a machine (`local`), so a machine's ledger keeps the shape it always had,
 * and `${workspaceId}:${host}` on the deployment, so two workspaces tracking
 * the same host each get their own line, their own reservation and their own
 * daily cycle rather than the second meeting the first's `already-booked`
 * (C2 tenancy review). The cap is still one figure for the whole day.
 */
const lineOf = (d: Pick<DueDomain, 'host' | 'workspaceId'>): string => ceilingKey({ workspaceId: d.workspaceId, host: d.host })

export const dailyLedgerFile = (dataDir: string): string => join(dataDir, 'daily-spend.json')
const DAILY_LEDGER = 'daily-spend.json'
const TICK_LOCK = 'tick-lock.json'

/** Where a ledger document is, for a message: the file on this machine, or the named document in Upstash. */
const whereIs = (dataDir: string, ledgers: LedgerStores | undefined, name: string): string => (ledgers?.backend === 'kv' ? `the ${name} ledger in Upstash` : join(dataDir, name))

const markOf = (raw: unknown): FanOutMark | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const m = raw as Partial<FanOutMark>
  if (typeof m.startedAt !== 'string') return undefined
  return { startedAt: m.startedAt, publishedAt: typeof m.publishedAt === 'string' ? m.publishedAt : null, published: typeof m.published === 'number' ? m.published : 0, failed: typeof m.failed === 'number' ? m.failed : 0 }
}

/** The ledger's shape, or a thrown reason: a loop that reads a malformed ledger as zero spends the day twice. */
function parseDailyLedger(parsed: unknown, where: string): DailyLedger {
  if (parsed === null) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${where} is not a ledger; the loop refuses to run until a person repairs it`)
  const out: DailyLedger = {}
  for (const [day, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) throw new Error(`${where}: day ${day} is not a ledger entry`)
    const d = v as Partial<DailyLedgerDay>
    if (typeof d.capUsd !== 'number' || typeof d.spentUsd !== 'number' || typeof d.calls !== 'number') throw new Error(`${where}: day ${day} is missing its figures`)
    const fanOut = markOf(d.fanOut)
    out[day] = { capUsd: d.capUsd, spentUsd: d.spentUsd, calls: d.calls, domains: typeof d.domains === 'object' && d.domains !== null ? d.domains : {}, ...(fanOut ? { fanOut } : {}) }
  }
  return out
}

/** Read the ledger. Missing is empty; corrupt is an ERROR, because a loop that reads a corrupt ledger as zero spends the day twice. */
export async function readDailyLedger(dataDir: string, ledgers?: LedgerStores): Promise<DailyLedger> {
  const where = whereIs(dataDir, ledgers, DAILY_LEDGER)
  let parsed: unknown
  try {
    parsed = await (ledgers ?? ledgerStores(dataDir, process.env)).doc(DAILY_LEDGER).read()
  } catch (e) {
    throw new Error(`${where} is not readable JSON (${(e as Error).message}); the loop refuses to run until a person repairs it`)
  }
  return parseDailyLedger(parsed, where)
}

/**
 * EVERY WRITE FOLDS INTO WHAT IS STORED NOW (B3c item 3). The first version
 * replaced the whole ledger with the tick's own snapshot, so a second tick
 * that had slipped past the lock overwrote what the first had booked, and
 * each could authorise the full cap. `update` hands the writer the current
 * value under the document's lock; the day's entry is rebuilt from that and
 * never from a copy taken earlier in the tick. The day's cap is the current
 * tick's formula, as it always was — or, for a domain job, the cap the
 * fan-out stored for the day, passed back in unchanged.
 */
async function foldDay(ledgers: LedgerStores, where: string, day: string, capUsd: number, fn: (today: DailyLedgerDay) => DailyLedgerDay): Promise<DailyLedgerDay> {
  const written = await ledgers.doc(DAILY_LEDGER).update((current) => {
    // Fail closed: a ledger that became unreadable during the tick is not overwritten with a guess.
    if (current === CORRUPT) throw new Error(`${where} is not readable JSON; nothing more is booked and the loop refuses until a person repairs it`)
    const ledger = parseDailyLedger(current, where)
    const today = ledger[day] ?? { capUsd, spentUsd: 0, calls: 0, domains: {} }
    return { ...ledger, [day]: fn({ ...today, capUsd }) }
  })
  return written[day]!
}

type Admission = { readonly ok: true; readonly remaining: number } | { readonly ok: false; readonly reason: string }

/**
 * Admit a domain and RESERVE its expected cost in one exclusive write: the
 * cap check reads the day's total as it is stored, and the reservation lands
 * under the same lock, so two ticks over one ledger cannot both find room for
 * the same last dollar. A host another tick has in flight (`running`) is
 * refused rather than run twice; a tick that reserved and died leaves that
 * reservation standing at the expected cost with headroom, the over-booking
 * direction, for a person to repair. A host whose earlier attempt today has
 * finished is admitted again: its spend stays in the day's total and the
 * day's line for the host becomes the latest attempt, as it always did.
 */
async function reserve(ledgers: LedgerStores, where: string, day: string, capUsd: number, line: string, expectedUsd: number, at: Date): Promise<Admission> {
  let verdict: Admission = { ok: false, reason: 'not decided' }
  await foldDay(ledgers, where, day, capUsd, (today) => {
    const booked = today.domains[line]
    if (booked?.status === 'running') {
      verdict = { ok: false, reason: `already booked today by a tick that has it in flight since ${booked.at}; if that tick died, repair ${where}` }
      return today
    }
    const remaining = capUsd - today.spentUsd
    if (expectedUsd > remaining + 1e-9) {
      verdict = { ok: false, reason: `daily cap: $${expectedUsd.toFixed(3)} expected with headroom, $${remaining.toFixed(3)} of $${capUsd.toFixed(3)} left today` }
      return today
    }
    verdict = { ok: true, remaining }
    return { ...today, spentUsd: today.spentUsd + expectedUsd, domains: { ...today.domains, [line]: { spentUsd: expectedUsd, calls: 0, status: 'running', at: at.toISOString() } } }
  })
  return verdict
}

export type JobAdmission =
  | { readonly ok: true; readonly remaining: number; readonly capUsd: number }
  | { readonly ok: false; readonly outcome: 'no-fan-out' | 'already-booked' | 'daily-cap'; readonly reason: string }

/**
 * The job-shaped admission (ADR-0018 D4): the day must already carry the
 * fan-out's entry, whose stored cap is the day's; and ANY line for the host
 * today, running or settled in any status, refuses — a domain job is run once
 * a day, and its second delivery is a transport's retry after a first
 * attempt that may have spent. Nothing is read from a header to decide this;
 * the ledger's line is the fact.
 */
async function reserveJob(ledgers: LedgerStores, where: string, day: string, line: string, expectedUsd: number, at: Date): Promise<JobAdmission> {
  let verdict: JobAdmission = { ok: false, outcome: 'no-fan-out', reason: 'not decided' }
  await ledgers.doc(DAILY_LEDGER).update((current) => {
    if (current === CORRUPT) throw new Error(`${where} is not readable JSON; nothing is booked and the job refuses until a person repairs it`)
    const ledger = parseDailyLedger(current, where)
    const today = ledger[day]
    if (!today?.fanOut) {
      verdict = { ok: false, outcome: 'no-fan-out', reason: `no fan-out has booked ${day} in ${where}; a domain job runs only after the day's fan-out has stored the day's cap` }
      return ledger
    }
    const booked = today.domains[line]
    if (booked) {
      verdict = { ok: false, outcome: 'already-booked', reason: `${line} is already booked for ${day} (${booked.status}, since ${booked.at}); a domain job runs once a day and a retry books nothing` }
      return ledger
    }
    const remaining = today.capUsd - today.spentUsd
    if (expectedUsd > remaining + 1e-9) {
      verdict = { ok: false, outcome: 'daily-cap', reason: `daily cap: $${expectedUsd.toFixed(3)} expected with headroom, $${remaining.toFixed(3)} of $${today.capUsd.toFixed(3)} left today` }
      return ledger
    }
    verdict = { ok: true, remaining, capUsd: today.capUsd }
    return { ...ledger, [day]: { ...today, spentUsd: today.spentUsd + expectedUsd, domains: { ...today.domains, [line]: { spentUsd: expectedUsd, calls: 0, status: 'running', at: at.toISOString() } } } }
  })
  return verdict
}

/** Give a reservation back: nothing was spent, so the host's line and its expected cost leave the day. */
const unreserve = (ledgers: LedgerStores, where: string, day: string, capUsd: number, line: string): Promise<DailyLedgerDay> =>
  foldDay(ledgers, where, day, capUsd, (today) => {
    const held = today.domains[line]
    if (held?.status !== 'running') return today
    const { [line]: _released, ...rest } = today.domains
    return { ...today, spentUsd: today.spentUsd - held.spentUsd, domains: rest }
  })

/** Replace a host's reservation with what the run realised, moving the day's totals by the difference. */
const settle = (ledgers: LedgerStores, where: string, day: string, capUsd: number, line: string, entry: DomainEntry): Promise<DailyLedgerDay> =>
  foldDay(ledgers, where, day, capUsd, (today) => {
    const held = today.domains[line]
    return {
      ...today,
      spentUsd: today.spentUsd - (held?.spentUsd ?? 0) + entry.spentUsd,
      calls: today.calls - (held?.calls ?? 0) + entry.calls,
      domains: { ...today.domains, [line]: entry },
    }
  })

/**
 * OPEN THE DAY (ADR-0018 D3): the day's cap and the fan-out's mark, written
 * BEFORE any domain job is published, because a job may be delivered within
 * milliseconds and must find the cap it reserves under. A day whose mark is
 * already closed (`publishedAt` set) is not opened again; a day whose mark is
 * open belongs to a fan-out that died between opening and closing, and is
 * re-run — republishing is safe because every domain job refuses a host
 * already booked today.
 */
async function openDay(ledgers: LedgerStores, where: string, day: string, capUsd: number, at: Date): Promise<{ readonly already: FanOutMark } | { readonly opened: FanOutMark }> {
  let result: { readonly already: FanOutMark } | { readonly opened: FanOutMark } | null = null
  await foldDay(ledgers, where, day, capUsd, (today) => {
    if (today.fanOut?.publishedAt) {
      result = { already: today.fanOut }
      return today
    }
    const opened: FanOutMark = { startedAt: today.fanOut?.startedAt ?? at.toISOString(), publishedAt: null, published: 0, failed: 0 }
    result = { opened }
    return { ...today, capUsd, fanOut: opened }
  })
  return result!
}

/** Close the day's mark with what was published and what could not be: a domain job QStash refused is a host that will not run today, and the ledger says so. */
const closeDay = (ledgers: LedgerStores, where: string, day: string, capUsd: number, published: number, failed: number, at: Date): Promise<DailyLedgerDay> =>
  foldDay(ledgers, where, day, capUsd, (today) => ({ ...today, fanOut: { startedAt: today.fanOut?.startedAt ?? at.toISOString(), publishedAt: at.toISOString(), published, failed } }))

// ---------------------------------------------------------------- the tick

export interface TickDeps {
  /** Collect one due domain. The default runs `runGrader`; a test injects a fake. */
  readonly collect?: (domain: DueDomain, opts: { readonly day: string; readonly plan: OwnPlan; readonly mode: TickMode; readonly apiKey: string; readonly allowanceCalls: number }) => Promise<ScanResult & { readonly run?: { readonly spentUsd?: number } }>
  /** The provider-quota and burst-cap gate. The default is `checkGate`; skipped offline. */
  readonly gate?: (domain: string, needed: number, apiKey: string, now: Date) => Promise<GateVerdict>
  readonly now?: () => Date
  readonly log?: (s: string) => void
}

export interface DomainRun {
  readonly host: string
  readonly status: string
  readonly spentUsd: number
  readonly calls: number
}

export interface TickOutcome {
  readonly day: string
  readonly mode: TickMode
  readonly capUsd: number
  readonly spentBefore: number
  readonly spentAfter: number
  readonly ran: readonly DomainRun[]
  readonly refused: readonly { readonly host: string; readonly reason: string }[]
  readonly list: DueList
}

/** The formula: every tracked domain's expected cycle cost, with retry headroom. Zero when nobody is tracked, and then nothing can run. */
export const formulaCapUsd = (list: DueList): number => list.tracked.reduce((n, t) => n + t.usd, 0) * RETRY_HEADROOM

/** The hard ceiling the owner names, or null when unset or not a positive number. A live tick refuses on null. */
export function hardCeilingUsd(env: NodeJS.ProcessEnv): number | null {
  const raw = env['COLLECTION_BUDGET_USD_DAILY']
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** The day's cap: the formula, bounded above by the hard ceiling when one is set. */
export const dailyCapUsd = (list: DueList, env: NodeJS.ProcessEnv = process.env): number => {
  const hard = hardCeilingUsd(env)
  const formula = formulaCapUsd(list)
  return hard === null ? formula : Math.min(formula, hard)
}

const TICK_LOCK_STALE_MS = 6 * 60 * 60 * 1000

interface TickLease {
  readonly holder: string
  readonly pid: number
  readonly at: string
}

/** The stored lease, null when none, or a thrown reason when what is stored is not a lease. */
function leaseOf(raw: unknown): TickLease | null {
  if (raw === null || raw === undefined) return null
  const l = raw as Partial<TickLease>
  if (typeof raw !== 'object' || typeof l.holder !== 'string' || typeof l.at !== 'string' || !Number.isFinite(Date.parse(l.at))) throw new Error('is not a tick lease')
  return { holder: l.holder, pid: typeof l.pid === 'number' ? l.pid : 0, at: l.at }
}

/**
 * One tick at a time per store: a lease in the store's own ledger document,
 * taken and released under that document's lock (a setnx with a TTL on KV,
 * ledger-doc.ts), so two instances of the deployment cannot both tick. The
 * first version was a file opened `wx` on local disk, which on the KV
 * backend was a lock per instance (B3c item 3). A lease older than six hours
 * belongs to a tick that died and is reclaimed; a lease that does not parse
 * is refused, not reclaimed, and the refusal says what to delete. Under
 * ADR-0018 the lease covers the fan-out phase; the domain jobs serialise per
 * host through their reservations and bound jointly through the fold.
 */
async function takeTickLock(ledgers: LedgerStores, where: string, now: () => Date): Promise<(() => Promise<void>) | { readonly refuse: string }> {
  const doc = ledgers.doc(TICK_LOCK)
  const me = randomUUID()
  let lease: TickLease | null
  try {
    lease = leaseOf(
      await doc.update((current) => {
        if (current === CORRUPT) throw new Error('is not readable JSON')
        const held = leaseOf(current)
        // Fresh and somebody else's: written back as it was, and refused below.
        if (held && now().getTime() - Date.parse(held.at) <= TICK_LOCK_STALE_MS) return held
        return { holder: me, pid: process.pid, at: now().toISOString() } satisfies TickLease
      }),
    )
  } catch (e) {
    return { refuse: `the tick lock ${where} ${(e as Error).message}; delete it if no tick is running` }
  }
  if (!lease || lease.holder !== me) {
    return { refuse: `another tick holds ${where} (pid ${lease?.pid ?? '?'}, since ${lease?.at ?? '?'}); two ticks over one store would each gate on a partial view of the day. A lease older than six hours is reclaimed; delete the lock if no tick is running.` }
  }
  return async () => {
    await doc.update((current) => {
      try {
        return current !== CORRUPT && leaseOf(current)?.holder === me ? null : current === CORRUPT ? null : current
      } catch {
        // Not a lease any more: nobody's to keep.
        return null
      }
    })
  }
}

/** The runner's lifetime ledger for this store, read without opening it (opening can lower its cap). */
function runnerLedger(dataDir: string): { readonly capUsd: number; readonly spentUsd: number; readonly exhaustedAt?: string } | null {
  const f = join(dataDir, 'ledger.json')
  if (!existsSync(f)) return null
  try {
    const l = JSON.parse(readFileSync(f, 'utf8')) as { capUsd?: unknown; spentUsd?: unknown; exhaustedAt?: unknown }
    if (typeof l.capUsd !== 'number' || typeof l.spentUsd !== 'number') return null
    return { capUsd: l.capUsd, spentUsd: l.spentUsd, ...(typeof l.exhaustedAt === 'string' ? { exhaustedAt: l.exhaustedAt } : {}) }
  } catch {
    return null
  }
}

/** The runner ledger's figures when it lives in KV: the lifetime total against the configured cap; KV holds no exhausted mark. */
async function kvRunnerLedger(ledgers: LedgerStores, capUsd: number): Promise<{ readonly capUsd: number; readonly spentUsd: number; readonly exhaustedAt?: string }> {
  return { capUsd, spentUsd: await ledgers.spend('ledger.json', capUsd, () => 0).spentUsd() }
}

export type LiveGates = { readonly ok: true; readonly apiKey: string; readonly plan: OwnPlan } | { readonly ok: false; readonly refuse: string; readonly armed: boolean }

/**
 * EVERY REFUSAL OF A LIVE RUN, IN ORDER, fail-closed, shared by the tick and
 * by both jobs (ADR-0018 D3, D4): the loop not armed, either collection flag
 * off, no provider key, no plan, no hard ceiling, a day that is not today (a
 * named day would buy cells under another date bucket and a fresh cap), and
 * the runner's lifetime ledger exhausted or holding less than the day's cap.
 * `capUsd` is the day's cap as the caller knows it: the formula on a tick, the
 * fan-out's stored figure on a domain job.
 */
export async function liveGates(o: {
  readonly dataDir: string
  readonly env: NodeJS.ProcessEnv
  readonly ledgers: LedgerStores
  readonly capUsd: number
  readonly formulaUsd: number
  readonly day: string
  readonly today: string
  readonly root?: string
}): Promise<LiveGates> {
  const env = o.env
  const armed = env['GRADER_DAILY_LOOP'] === ARMED
  if (!armed) return { ok: false, armed, refuse: `the daily loop is not armed: GRADER_DAILY_LOOP is ${JSON.stringify(env['GRADER_DAILY_LOOP'])}, not "${ARMED}". Arming it is the owner's explicit go-ahead (ADR-0017).` }
  if (env['COLLECTION_ENABLED'] !== 'true' || env['GRADER_LIVE_SCAN'] !== 'true') return { ok: false, armed, refuse: `live collection is off: COLLECTION_ENABLED=${JSON.stringify(env['COLLECTION_ENABLED'])}, GRADER_LIVE_SCAN=${JSON.stringify(env['GRADER_LIVE_SCAN'])}; both must be "true"` }
  const found = loadApiKey(o.root ?? join(o.dataDir, '..', '..', '..'), env)
  if (!found) return { ok: false, armed, refuse: 'no provider key is configured, so a live tick cannot run' }
  const planRaw = env['OPENWEBNINJA_PLAN']
  if (planRaw !== 'payg' && planRaw !== 'pro' && planRaw !== 'ultra' && planRaw !== 'mega') return { ok: false, armed, refuse: `OPENWEBNINJA_PLAN is ${JSON.stringify(planRaw)}; a live tick names its plan, it is not defaulted` }
  // The hard ceiling is the owner's figure; a formula alone grows with whatever is tracked.
  if (hardCeilingUsd(env) === null) return { ok: false, armed, refuse: `COLLECTION_BUDGET_USD_DAILY is ${JSON.stringify(env['COLLECTION_BUDGET_USD_DAILY'])}; a live tick needs the hard daily ceiling set to a positive number of dollars. The formula's figure today would be $${o.formulaUsd.toFixed(3)}.` }
  // A live tick runs for today. A named day would buy cells under another date bucket and a fresh cap; that is a re-collection, not a tick.
  if (o.day !== o.today) return { ok: false, armed, refuse: `a live tick runs for today (${o.today}); --day ${o.day} is for the dry list` }
  // The runner's lifetime ledger must have room for the day, or every run stops at its first cell and the loop ticks daily to no effect.
  // On the file backend the file is read without opening it (opening can lower its cap); in KV the ledger's own figure is asked for.
  const rl = o.ledgers.backend === 'file' ? runnerLedger(o.dataDir) : await kvRunnerLedger(o.ledgers, ledgerCapUsd(o.dataDir, env, o.ledgers))
  const where = o.ledgers.backend === 'file' ? join(o.dataDir, 'ledger.json') : 'the runner ledger in Upstash'
  if (rl?.exhaustedAt) return { ok: false, armed, refuse: `the runner's ledger ${where} is exhausted (since ${rl.exhaustedAt}); raise its cap deliberately by editing the file before a tick can run` }
  if (rl && rl.capUsd - rl.spentUsd < o.capUsd) return { ok: false, armed, refuse: `the runner's ledger ${where} has $${(rl.capUsd - rl.spentUsd).toFixed(3)} left of its $${rl.capUsd.toFixed(2)} lifetime cap, less than today's $${o.capUsd.toFixed(3)}; raise it deliberately` }
  return { ok: true, apiKey: found.key, plan: planRaw }
}

/** Everything the per-domain path needs once a domain is admitted. */
interface RunContext {
  readonly day: string
  readonly capUsd: number
  readonly mode: TickMode
  readonly plan: OwnPlan
  readonly apiKey: string
  readonly ledgers: LedgerStores
  readonly store: WorkspaceStore
  readonly ledgerAt: string
  readonly gateCfg: GateConfig
  readonly collect: NonNullable<TickDeps['collect']>
  readonly gate: NonNullable<TickDeps['gate']>
  readonly now: () => Date
  readonly log: (s: string) => void
}

/**
 * THE PER-DOMAIN PATH, after admission: the burst-cap-and-quota gate (a
 * refusal gives the reservation back), the allowance, the runner, the cycle
 * filed, the burst-cap ledger written, and the reservation settled to the
 * realised figure. The tick runs it for each due domain in turn; a domain
 * job runs it once (ADR-0018 D4). One function, so a branch one transport
 * took and the other did not cannot exist.
 */
async function runAdmitted(d: DueDomain, remaining: number, ctx: RunContext): Promise<{ readonly ran: DomainRun; readonly spentAfter: number } | { readonly refused: string }> {
  const expected = d.usd * RETRY_HEADROOM
  if (ctx.mode === 'live') {
    const verdict = await ctx.gate(d.host, d.cells, ctx.apiKey, ctx.now())
    if (!verdict.ok) {
      // Nothing was spent, so the reservation goes back. The outcome is the
      // operator's log, so an unreadable quota's cause travels with it here.
      await unreserve(ctx.ledgers, ctx.ledgerAt, ctx.day, ctx.capUsd, lineOf(d))
      return { refused: `${verdict.reason}: ${verdict.message}${verdict.reason === 'unreadable' ? ` (${verdict.cause})` : ''}` }
    }
  }
  // The allowance: the cycle's cells with headroom, or as many attempts as
  // what is left of the day's cap pays for at the cycle's MEAN price per
  // attempt, whichever is fewer. Offline the price is zero and the cells
  // bound alone. Mean, not dearest: at the dearest engine's price the last
  // domain of a day (whose remaining is about its own expected cost) would
  // get ~1% headroom instead of 20% and be truncated on its first retry.
  // What the mean leaves unbounded is the difference between the dearest and
  // the mean price over the retries, at most (0.008 − 0.0068) × 17 = $0.02 a
  // run at pay-as-you-go; the day's ledger books the realised figure.
  const meanPrice = d.cells > 0 ? d.usd / d.cells : 0
  const affordable = ctx.mode === 'live' && meanPrice > 0 ? Math.floor(remaining / meanPrice) : Number.POSITIVE_INFINITY
  const allowanceCalls = Math.min(runAllowanceFor(d.cells), affordable)
  ctx.log(`  ${d.host}: collecting ${d.cells} cells, expected $${d.usd.toFixed(3)}, $${remaining.toFixed(3)} of the day's cap left, at most ${allowanceCalls} attempts`)
  let status = 'failed'
  let spent = expected
  let calls = 0
  try {
    const result = await ctx.collect(d, { day: ctx.day, plan: ctx.plan, mode: ctx.mode, apiKey: ctx.apiKey, allowanceCalls })
    status = result.status
    // The runner's own ledger figure when it has one; the expected cost with headroom when it does not.
    spent = typeof result.run?.spentUsd === 'number' && Number.isFinite(result.run.spentUsd) ? result.run.spentUsd : expected
    calls = 'counts' in result ? result.counts.providerCalls : 0
    if (result.status === 'scanned') {
      try {
        await ctx.store.cycles.put(cycleInputOf(result))
      } catch (e) {
        ctx.log(`  ${d.host}: not filed: ${(e as Error).message}`)
      }
    }
    if (result.status === 'scanned' || result.status === 'no-answers') await recordScan(d.host, ctx.gateCfg, ctx.now())
  } catch (e) {
    const msg = (e as Error).message
    // Refused before any call, provably: the runner's own lock said another scan holds the store. Nothing was spent, so nothing is booked.
    if (/run\.lock/.test(msg)) {
      status = 'refused-before-call: another scan holds run.lock'
      spent = 0
    } else status = `failed: ${msg.slice(0, 160)}`
  }
  // Settled before the next domain starts, into the ledger as it is
  // stored: a crash between two domains loses no spend, and a crash
  // inside one leaves its reservation standing at the expected cost.
  const today = await settle(ctx.ledgers, ctx.ledgerAt, ctx.day, ctx.capUsd, lineOf(d), { spentUsd: spent, calls, status, at: ctx.now().toISOString() })
  return { ran: { host: d.host, status, spentUsd: spent, calls }, spentAfter: today.spentUsd }
}

/**
 * Run one tick. Dry by default: the due list, the cap, and what would run.
 * With `apply`, the gates below, then each due domain in order, each booked
 * before the next starts.
 */
export async function runTick(
  opts: {
    readonly dataDir: string
    readonly env: NodeJS.ProcessEnv
    readonly day?: string
    readonly apply: boolean
    readonly mode: TickMode
    readonly root?: string
    /** The deployment's ledgers and workspace store; this machine's files when absent (MVP_PLAN B3b). */
    readonly ledgers?: LedgerStores
    readonly store?: WorkspaceStore
  },
  deps: TickDeps = {},
): Promise<TickOutcome | { readonly refuse: string; readonly list?: DueList }> {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const today0 = utcDay(now())
  const day = opts.day ?? today0
  const list = dueToday(opts.dataDir, opts.env, day)
  if (list.config) return { refuse: list.config, list }
  const capUsd = dailyCapUsd(list, opts.env)
  const ledgers = opts.ledgers ?? ledgerStores(opts.dataDir, opts.env)
  const store = opts.store ?? defaultWorkspaceStore(opts.dataDir, opts.env)

  // The ledger is read before anything else, so a corrupt one refuses the tick before a cell is asked.
  // What it says is the figure REPORTED as the day's start; every decision below reads the ledger again under its lock.
  const ledger = await readDailyLedger(opts.dataDir, ledgers)
  const spentBefore = ledger[day]?.spentUsd ?? 0

  if (!opts.apply) return { day, mode: opts.mode, capUsd, spentBefore, spentAfter: spentBefore, ran: [], refused: [], list }

  // ---- live gates, every one fail-closed; offline has no provider to gate.
  let apiKey = ''
  let plan: OwnPlan = 'payg'
  if (opts.mode === 'live') {
    const gates = await liveGates({ dataDir: opts.dataDir, env: opts.env, ledgers, capUsd, formulaUsd: formulaCapUsd(list), day, today: today0, ...(opts.root ? { root: opts.root } : {}) })
    if (!gates.ok) return { refuse: gates.refuse, list }
    apiKey = gates.apiKey
    plan = gates.plan
  }
  if (capUsd <= 0) return { day, mode: opts.mode, capUsd, spentBefore, spentAfter: spentBefore, ran: [], refused: list.due.map((d) => ({ host: d.host, reason: 'the day\'s cap is zero: nobody is tracked' })), list }

  const ledgerAt = whereIs(opts.dataDir, ledgers, DAILY_LEDGER)
  const release = await takeTickLock(ledgers, whereIs(opts.dataDir, ledgers, TICK_LOCK), now)
  if (typeof release !== 'function') return { refuse: release.refuse, list }
  try {
    return await runDue()
  } finally {
    await release()
  }

  async function runDue(): Promise<TickOutcome> {
    const gateCfg = defaultGateConfig(opts.dataDir, opts.env, ledgers)
    const ctx: RunContext = {
      day,
      capUsd,
      mode: opts.mode,
      plan,
      apiKey,
      ledgers,
      store,
      ledgerAt,
      gateCfg,
      // The tick's store is this machine's files unless a caller passed one; the result file follows the ledgers' shape as it always did here.
      collect: deps.collect ?? defaultCollect({ dataDir: opts.dataDir, env: opts.env, ledgers, store, resultFile: ledgers.backend === 'file' }),
      gate: deps.gate ?? ((domain, needed, key, at) => checkGate(domain, { ...gateCfg, callsPerEngine: needed / ENGINES.length }, key, at)),
      now,
      log,
    }
    const ran: DomainRun[] = []
    const refused: { host: string; reason: string }[] = []
    let spentAfter = spentBefore

    for (const d of list.due) {
      // The cap, decided and booked in one exclusive write against the ledger
      // as it is stored now, never against a copy taken when the tick began.
      const admitted = await reserve(ledgers, ledgerAt, day, capUsd, lineOf(d), d.usd * RETRY_HEADROOM, now())
      if (!admitted.ok) {
        refused.push({ host: d.host, reason: admitted.reason })
        continue
      }
      const r = await runAdmitted(d, admitted.remaining, ctx)
      if ('refused' in r) {
        refused.push({ host: d.host, reason: r.refused })
        continue
      }
      ran.push(r.ran)
      spentAfter = r.spentAfter
    }
    // A day nobody ran still records its cap, so the dry list and the ledger agree on what the day was.
    if (ran.length === 0 && !ledger[day]) spentAfter = (await foldDay(ledgers, ledgerAt, day, capUsd, (t) => t)).spentUsd
    return { day, mode: opts.mode, capUsd, spentBefore, spentAfter, ran, refused, list }
  }
}

// ---------------------------------------------------------------- the two jobs (ADR-0018 D3, D4)

export interface FanOutOptions {
  readonly dataDir: string
  readonly env: NodeJS.ProcessEnv
  readonly ledgers: LedgerStores
  readonly mode: TickMode
  readonly day?: string
  readonly root?: string
  /**
   * The store for one tracked entry: this machine's file store, or the
   * workspace the entry names through a token minted for the account that
   * switched the domain on (ADR-0018 D6). A refusal names why, and the entry
   * is reported rather than run.
   */
  readonly storeFor: (entry: TrackedEntry) => Promise<WorkspaceStore | { readonly refuse: string }>
  /** Publish one domain job. The route hands the QStash client's `publishJson`; a test records. */
  readonly publish: (job: DomainJob, opts: { readonly deduplicationId: string }) => Promise<void>
}

export type FanOutOutcome =
  | { readonly outcome: 'not-armed' | 'refused'; readonly refuse: string; readonly list?: DueList }
  | { readonly outcome: 'lease-held'; readonly refuse: string }
  | { readonly outcome: 'already-fanned-out'; readonly day: string; readonly fanOut: FanOutMark }
  | {
      readonly outcome: 'fanned-out'
      readonly day: string
      readonly capUsd: number
      readonly published: number
      readonly failed: number
      readonly refusedEntries: readonly { readonly host: string; readonly workspaceId: string; readonly reason: string }[]
      readonly list: DueList
    }

/**
 * THE FAN-OUT (ADR-0018 D3): the day's decision, once, under the tick lease.
 * The tracked list from the deployment's ledger document; a store per entry;
 * the due list per workspace; the day's cap by the formula; for a live run
 * every live gate; then the day opened in the ledger (its cap and the
 * fan-out's mark) BEFORE a job is published, one domain job per due domain,
 * and the mark closed with the count. Spends nothing itself.
 */
export async function runFanOut(opts: FanOutOptions, deps: Pick<TickDeps, 'now' | 'log'> = {}): Promise<FanOutOutcome> {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const today0 = utcDay(now())
  const day = opts.day ?? today0
  const ledgers = opts.ledgers
  const ledgerAt = whereIs(opts.dataDir, ledgers, DAILY_LEDGER)

  // The ledger first, so a corrupt one refuses before anything is decided.
  await readDailyLedger(opts.dataDir, ledgers)

  let tracked: readonly TrackedEntry[]
  try {
    tracked = await readTrackedIn(ledgers, whereIs(opts.dataDir, ledgers, TRACKED))
  } catch (e) {
    return { outcome: 'refused', refuse: (e as Error).message }
  }
  const entries: { entry: TrackedEntry; store: WorkspaceStore }[] = []
  const refusedEntries: { host: string; workspaceId: string; reason: string }[] = []
  for (const entry of tracked) {
    const store = await opts.storeFor(entry)
    if ('refuse' in store) refusedEntries.push({ host: entry.host, workspaceId: entry.workspaceId ?? 'local', reason: store.refuse })
    else entries.push({ entry, store })
  }
  const list = await dueTodayIn(opts.dataDir, opts.env, day, entries)
  if (list.config) return { outcome: 'refused', refuse: list.config, list }
  const capUsd = dailyCapUsd(list, opts.env)

  if (opts.mode === 'live') {
    const gates = await liveGates({ dataDir: opts.dataDir, env: opts.env, ledgers, capUsd, formulaUsd: formulaCapUsd(list), day, today: today0, ...(opts.root ? { root: opts.root } : {}) })
    if (!gates.ok) return { outcome: gates.armed ? 'refused' : 'not-armed', refuse: gates.refuse, list }
  }

  const release = await takeTickLock(ledgers, whereIs(opts.dataDir, ledgers, TICK_LOCK), now)
  if (typeof release !== 'function') return { outcome: 'lease-held', refuse: release.refuse }
  try {
    const opened = await openDay(ledgers, ledgerAt, day, capUsd, now())
    if ('already' in opened) return { outcome: 'already-fanned-out', day, fanOut: opened.already }
    let published = 0
    let failed = 0
    for (const d of rotateByDay(list.due, day)) {
      const job: DomainJob = { v: 1, kind: 'domain', day, workspaceId: d.workspaceId, host: d.host }
      try {
        await opts.publish(job, { deduplicationId: tickDeduplicationId(job) })
        published += 1
      } catch (e) {
        failed += 1
        log(`  ${d.host}: not published: ${(e as Error).message}`)
      }
    }
    await closeDay(ledgers, ledgerAt, day, capUsd, published, failed, now())
    return { outcome: 'fanned-out', day, capUsd, published, failed, refusedEntries, list }
  } finally {
    await release()
  }
}

export interface DomainJobOptions {
  readonly dataDir: string
  readonly env: NodeJS.ProcessEnv
  readonly ledgers: LedgerStores
  /** the workspace the job names, opened by the caller (ADR-0018 D6) */
  readonly store: WorkspaceStore
  readonly job: DomainJob
  readonly mode: TickMode
  readonly root?: string
  /**
   * Write the runner's `latest.json` beside the data directory. Only for a
   * FILE store on a machine: on a deployment the store holds the cycle and the
   * instance's disk is shared by every workspace it serves, so the predicate
   * is the store's shape, as `/api/scan` decides it, never the ledgers' (C2
   * tenancy review, MINOR-7). Default false.
   */
  readonly resultFile?: boolean
}

export type DomainJobOutcome =
  | { readonly outcome: 'day-passed' | 'no-fan-out' | 'already-booked' | 'daily-cap' | 'not-due' | 'not-armed' | 'refused' | 'gate-refused'; readonly refuse: string }
  | { readonly outcome: 'ran'; readonly run: DomainRun; readonly spentAfter: number }

/**
 * ONE DOMAIN JOB (ADR-0018 D4): today only; the day the fan-out booked, whose
 * stored cap is the day's; this host re-decided against its workspace's
 * store now (a hand-started cycle may have filed today's since); for a live
 * run every live gate; the job-shaped reservation, which refuses a host
 * already booked today in any status; then the per-domain path the tick
 * runs. Every outcome is a fact for the caller to answer `200` with, except
 * a thrown ledger error, which the caller answers as "nothing spent, retry".
 */
export async function runDomainJob(opts: DomainJobOptions, deps: TickDeps = {}): Promise<DomainJobOutcome> {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const today0 = utcDay(now())
  const { job } = opts
  if (job.day !== today0) return { outcome: 'day-passed', refuse: `the job is for ${job.day} and today is ${today0}; a cycle bought now would sit under another date bucket, so nothing is collected` }
  const ledgers = opts.ledgers
  const ledgerAt = whereIs(opts.dataDir, ledgers, DAILY_LEDGER)

  const stored = (await readDailyLedger(opts.dataDir, ledgers))[job.day]
  if (!stored?.fanOut) return { outcome: 'no-fan-out', refuse: `no fan-out has booked ${job.day} in ${ledgerAt}; a domain job runs only after the day's fan-out has stored the day's cap` }
  const capUsd = stored.capUsd

  const decided = await decideDueIn(opts.dataDir, opts.env, job.day, { host: job.host, workspaceId: job.workspaceId }, opts.store)
  if ('config' in decided) return { outcome: 'refused', refuse: decided.config }
  if ('notDue' in decided.verdict) return { outcome: 'not-due', refuse: `${job.host}: ${decided.verdict.notDue.reason}: ${decided.verdict.notDue.detail}` }
  const d = decided.verdict.due

  let apiKey = ''
  let plan: OwnPlan = 'payg'
  if (opts.mode === 'live') {
    const gates = await liveGates({ dataDir: opts.dataDir, env: opts.env, ledgers, capUsd, formulaUsd: capUsd, day: job.day, today: today0, ...(opts.root ? { root: opts.root } : {}) })
    if (!gates.ok) return { outcome: gates.armed ? 'refused' : 'not-armed', refuse: gates.refuse }
    apiKey = gates.apiKey
    plan = gates.plan
  }

  const admitted = await reserveJob(ledgers, ledgerAt, job.day, lineOf(d), d.usd * RETRY_HEADROOM, now())
  if (!admitted.ok) return { outcome: admitted.outcome, refuse: admitted.reason }

  const gateCfg = defaultGateConfig(opts.dataDir, opts.env, ledgers)
  const ctx: RunContext = {
    day: job.day,
    capUsd: admitted.capUsd,
    mode: opts.mode,
    plan,
    apiKey,
    ledgers,
    store: opts.store,
    ledgerAt,
    gateCfg,
    collect: deps.collect ?? defaultCollect({ dataDir: opts.dataDir, env: opts.env, ledgers, store: opts.store, resultFile: opts.resultFile === true }),
    gate: deps.gate ?? ((domain, needed, key, at) => checkGate(domain, { ...gateCfg, callsPerEngine: needed / ENGINES.length }, key, at)),
    now,
    log,
  }
  const r = await runAdmitted(d, admitted.remaining, ctx)
  if ('refused' in r) return { outcome: 'gate-refused', refuse: r.refused }
  return { outcome: 'ran', run: r.ran, spentAfter: r.spentAfter }
}

/** The real collector: `runGrader` through its own lock, ledger and rate budget. The per-run cap is the store's own, never lowered here. */
function defaultCollect(opts: { readonly dataDir: string; readonly env: NodeJS.ProcessEnv; readonly ledgers: LedgerStores; readonly store: WorkspaceStore; readonly resultFile: boolean }): NonNullable<TickDeps['collect']> {
  return async (d, o) => {
    const gate = defaultGateConfig(opts.dataDir, opts.env, opts.ledgers)
    const options: RunnerOptions = {
      domain: d.host,
      plan: o.plan,
      day: o.day,
      engines: [...ENGINES],
      capUsd: ledgerCapUsd(opts.dataDir, opts.env, opts.ledgers),
      maxPrompts: gate.callsPerEngine,
      runAllowanceCalls: o.allowanceCalls,
      mode: o.mode,
      apiKey: o.apiKey,
      dataDir: opts.dataDir,
      // The result file is the CLI's; on the deployment the store holds the cycle and the instance's disk is every workspace's (B3b tenancy audit).
      ...(opts.resultFile ? { outFile: join(opts.dataDir, 'latest.json') } : {}),
      log: () => {},
      ledgers: opts.ledgers,
      store: opts.store,
    }
    return runGrader(options)
  }
}

// The store's own per-run cap now lives in `live-gate.ts` as `ledgerCapUsd`,
// shared with `/api/scan`. It was private here, which is exactly why the route
// grew its own answer and got it wrong: one rule, two implementations, and only
// one of them protected the ledger.
