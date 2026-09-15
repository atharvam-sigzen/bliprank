/**
 * THE DAILY LOOP — one tick: the due list, a spend cap derived from the
 * tracked set, and the cycles actually run, each through the gates a person's
 * click meets. ADR-0017, decisions 1 and 2 (confirmed 2026-09-07).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ THE CAP IS A FORMULA, AND IT GATES. The day's cap is the expected cost of
 * every TRACKED domain's cycle — its real prompt count, curated plus its own,
 * on the engines a cycle asks, at the plan's marginal price — times
 * `RETRY_HEADROOM`, recomputed on every tick from the tracked file, so
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
 * ⚠️ FAIL CLOSED, LIKE THE GATES IT REUSES. A ledger that cannot be read is a
 * refusal for the whole tick; an environment that cannot size a scan is a
 * refusal; a second tick while one holds the tick lease is a refusal; a live
 * tick needs the loop ARMED (`GRADER_DAILY_LOOP=armed`), both collection
 * flags, a provider key, a plan, the hard daily ceiling, a runner ledger with
 * room, and today's date, and refuses without any one of them. Nothing here
 * defaults to running.
 *
 * ⚠️ WHAT THIS DOES NOT DO. It does not register itself with any scheduler.
 * The OS task that would call it daily is a person's act, taken once, after
 * the owner's explicit go-ahead (ADR-0017). The loop is a process that runs to
 * completion and exits; it holds no timer.
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
import { RETRY_HEADROOM, runAllowanceFor } from './domain-ceiling.js'
import { dueToday, type DueDomain, type DueList } from './due.js'
import { checkGate, defaultGateConfig, ledgerCapUsd, recordScan, type GateVerdict } from './live-gate.js'
import { loadApiKey } from './load-key.js'
import { runGrader, type RunnerOptions } from './run.js'
import type { ScanResult } from './scan.js'

export const ARMED = 'armed'

// ---------------------------------------------------------------- the daily ledger

export interface DailyLedgerDay {
  readonly capUsd: number
  readonly spentUsd: number
  readonly calls: number
  readonly domains: Readonly<Record<string, { readonly spentUsd: number; readonly calls: number; readonly status: string; readonly at: string }>>
}
type DailyLedger = Record<string, DailyLedgerDay>

type DomainEntry = DailyLedgerDay['domains'][string]

export const dailyLedgerFile = (dataDir: string): string => join(dataDir, 'daily-spend.json')
const DAILY_LEDGER = 'daily-spend.json'
const TICK_LOCK = 'tick-lock.json'

/** Where a ledger document is, for a message: the file on this machine, or the named document in Upstash. */
const whereIs = (dataDir: string, ledgers: LedgerStores | undefined, name: string): string => (ledgers?.backend === 'kv' ? `the ${name} ledger in Upstash` : join(dataDir, name))

/** The ledger's shape, or a thrown reason: a loop that reads a malformed ledger as zero spends the day twice. */
function parseDailyLedger(parsed: unknown, where: string): DailyLedger {
  if (parsed === null) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${where} is not a ledger; the loop refuses to run until a person repairs it`)
  const out: DailyLedger = {}
  for (const [day, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) throw new Error(`${where}: day ${day} is not a ledger entry`)
    const d = v as Partial<DailyLedgerDay>
    if (typeof d.capUsd !== 'number' || typeof d.spentUsd !== 'number' || typeof d.calls !== 'number') throw new Error(`${where}: day ${day} is missing its figures`)
    out[day] = { capUsd: d.capUsd, spentUsd: d.spentUsd, calls: d.calls, domains: typeof d.domains === 'object' && d.domains !== null ? d.domains : {} }
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
 * tick's formula, as it always was.
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
async function reserve(ledgers: LedgerStores, where: string, day: string, capUsd: number, host: string, expectedUsd: number, at: Date): Promise<{ readonly ok: true; readonly remaining: number } | { readonly ok: false; readonly reason: string }> {
  let verdict: { readonly ok: true; readonly remaining: number } | { readonly ok: false; readonly reason: string } = { ok: false, reason: 'not decided' }
  await foldDay(ledgers, where, day, capUsd, (today) => {
    const booked = today.domains[host]
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
    return { ...today, spentUsd: today.spentUsd + expectedUsd, domains: { ...today.domains, [host]: { spentUsd: expectedUsd, calls: 0, status: 'running', at: at.toISOString() } } }
  })
  return verdict
}

/** Give a reservation back: nothing was spent, so the host's line and its expected cost leave the day. */
const unreserve = (ledgers: LedgerStores, where: string, day: string, capUsd: number, host: string): Promise<DailyLedgerDay> =>
  foldDay(ledgers, where, day, capUsd, (today) => {
    const held = today.domains[host]
    if (held?.status !== 'running') return today
    const { [host]: _released, ...rest } = today.domains
    return { ...today, spentUsd: today.spentUsd - held.spentUsd, domains: rest }
  })

/** Replace a host's reservation with what the run realised, moving the day's totals by the difference. */
const settle = (ledgers: LedgerStores, where: string, day: string, capUsd: number, host: string, entry: DomainEntry): Promise<DailyLedgerDay> =>
  foldDay(ledgers, where, day, capUsd, (today) => {
    const held = today.domains[host]
    return {
      ...today,
      spentUsd: today.spentUsd - (held?.spentUsd ?? 0) + entry.spentUsd,
      calls: today.calls - (held?.calls ?? 0) + entry.calls,
      domains: { ...today.domains, [host]: entry },
    }
  })

// ---------------------------------------------------------------- the tick

export type TickMode = 'live' | 'fixture'

export interface TickDeps {
  /** Collect one due domain. The default runs `runGrader`; a test injects a fake. */
  readonly collect?: (domain: DueDomain, opts: { readonly day: string; readonly plan: OwnPlan; readonly mode: TickMode; readonly apiKey: string; readonly allowanceCalls: number }) => Promise<ScanResult & { readonly run?: { readonly spentUsd?: number } }>
  /** The provider-quota and burst-cap gate. The default is `checkGate`; skipped offline. */
  readonly gate?: (domain: string, needed: number, apiKey: string, now: Date) => Promise<GateVerdict>
  readonly now?: () => Date
  readonly log?: (s: string) => void
}

export interface TickOutcome {
  readonly day: string
  readonly mode: TickMode
  readonly capUsd: number
  readonly spentBefore: number
  readonly spentAfter: number
  readonly ran: readonly { readonly host: string; readonly status: string; readonly spentUsd: number; readonly calls: number }[]
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
 * is refused, not reclaimed, and the refusal says what to delete.
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
  const today0 = now().toISOString().slice(0, 10)
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
    const env = opts.env
    if (env['GRADER_DAILY_LOOP'] !== ARMED) return { refuse: `the daily loop is not armed: GRADER_DAILY_LOOP is ${JSON.stringify(env['GRADER_DAILY_LOOP'])}, not "${ARMED}". Arming it is the owner's explicit go-ahead (ADR-0017).`, list }
    if (env['COLLECTION_ENABLED'] !== 'true' || env['GRADER_LIVE_SCAN'] !== 'true') return { refuse: `live collection is off: COLLECTION_ENABLED=${JSON.stringify(env['COLLECTION_ENABLED'])}, GRADER_LIVE_SCAN=${JSON.stringify(env['GRADER_LIVE_SCAN'])}; both must be "true"`, list }
    const found = loadApiKey(opts.root ?? join(opts.dataDir, '..', '..', '..'), env)
    if (!found) return { refuse: 'no provider key is configured, so a live tick cannot run', list }
    apiKey = found.key
    const planRaw = env['OPENWEBNINJA_PLAN']
    if (planRaw !== 'payg' && planRaw !== 'pro' && planRaw !== 'ultra' && planRaw !== 'mega') return { refuse: `OPENWEBNINJA_PLAN is ${JSON.stringify(planRaw)}; a live tick names its plan, it is not defaulted`, list }
    plan = planRaw
    // The hard ceiling is the owner's figure; a formula alone grows with whatever is tracked.
    if (hardCeilingUsd(env) === null) return { refuse: `COLLECTION_BUDGET_USD_DAILY is ${JSON.stringify(env['COLLECTION_BUDGET_USD_DAILY'])}; a live tick needs the hard daily ceiling set to a positive number of dollars. The formula's figure today would be $${formulaCapUsd(list).toFixed(3)}.`, list }
    // A live tick runs for today. A named day would buy cells under another date bucket and a fresh cap; that is a re-collection, not a tick.
    if (day !== today0) return { refuse: `a live tick runs for today (${today0}); --day ${day} is for the dry list`, list }
    // The runner's lifetime ledger must have room for the day, or every run stops at its first cell and the loop ticks daily to no effect.
    // On the file backend the file is read without opening it (opening can lower its cap); in KV the ledger's own figure is asked for.
    const rl = ledgers.backend === 'file' ? runnerLedger(opts.dataDir) : await kvRunnerLedger(ledgers, ledgerCapUsd(opts.dataDir, env))
    const where = ledgers.backend === 'file' ? join(opts.dataDir, 'ledger.json') : 'the runner ledger in Upstash'
    if (rl?.exhaustedAt) return { refuse: `the runner's ledger ${where} is exhausted (since ${rl.exhaustedAt}); raise its cap deliberately by editing the file before a tick can run`, list }
    if (rl && rl.capUsd - rl.spentUsd < capUsd) return { refuse: `the runner's ledger ${where} has $${(rl.capUsd - rl.spentUsd).toFixed(3)} left of its $${rl.capUsd.toFixed(2)} lifetime cap, less than today's $${capUsd.toFixed(3)}; raise it deliberately`, list }
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
    const collect = deps.collect ?? defaultCollect({ dataDir: opts.dataDir, env: opts.env, ledgers, store })
    const gate = deps.gate ?? ((domain, needed, key, at) => checkGate(domain, { ...gateCfg, callsPerEngine: needed / ENGINES.length }, key, at))
    const ran: { host: string; status: string; spentUsd: number; calls: number }[] = []
    const refused: { host: string; reason: string }[] = []
    let spentAfter = spentBefore

    for (const d of list.due) {
      const expected = d.usd * RETRY_HEADROOM
      // The cap, decided and booked in one exclusive write against the ledger
      // as it is stored now, never against a copy taken when the tick began.
      const admitted = await reserve(ledgers, ledgerAt, day, capUsd, d.host, expected, now())
      if (!admitted.ok) {
        refused.push({ host: d.host, reason: admitted.reason })
        continue
      }
      const remaining = admitted.remaining
      if (opts.mode === 'live') {
        const verdict = await gate(d.host, d.cells, apiKey, now())
        if (!verdict.ok) {
          // Nothing was spent, so the reservation goes back.
          await unreserve(ledgers, ledgerAt, day, capUsd, d.host)
          refused.push({ host: d.host, reason: `${verdict.reason}: ${verdict.message}` })
          continue
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
      const affordable = opts.mode === 'live' && meanPrice > 0 ? Math.floor(remaining / meanPrice) : Number.POSITIVE_INFINITY
      const allowanceCalls = Math.min(runAllowanceFor(d.cells), affordable)
      log(`  ${d.host}: collecting ${d.cells} cells, expected $${d.usd.toFixed(3)}, $${remaining.toFixed(3)} of the day's cap left, at most ${allowanceCalls} attempts`)
      let status = 'failed'
      let spent = expected
      let calls = 0
      try {
        const result = await collect(d, { day, plan, mode: opts.mode, apiKey, allowanceCalls })
        status = result.status
        // The runner's own ledger figure when it has one; the expected cost with headroom when it does not.
        spent = typeof result.run?.spentUsd === 'number' && Number.isFinite(result.run.spentUsd) ? result.run.spentUsd : expected
        calls = 'counts' in result ? result.counts.providerCalls : 0
        if (result.status === 'scanned') {
          try {
            await store.cycles.put(cycleInputOf(result))
          } catch (e) {
            log(`  ${d.host}: not filed: ${(e as Error).message}`)
          }
        }
        if (result.status === 'scanned' || result.status === 'no-answers') await recordScan(d.host, gateCfg, now())
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
      const today = await settle(ledgers, ledgerAt, day, capUsd, d.host, { spentUsd: spent, calls, status, at: now().toISOString() })
      spentAfter = today.spentUsd
      ran.push({ host: d.host, status, spentUsd: spent, calls })
    }
    // A day nobody ran still records its cap, so the dry list and the ledger agree on what the day was.
    if (ran.length === 0 && !ledger[day]) spentAfter = (await foldDay(ledgers, ledgerAt, day, capUsd, (t) => t)).spentUsd
    return { day, mode: opts.mode, capUsd, spentBefore, spentAfter, ran, refused, list }
  }
}

/** The real collector: `runGrader` through its own lock, ledger and rate budget. The per-run cap is the store's own, never lowered here. */
function defaultCollect(opts: { readonly dataDir: string; readonly env: NodeJS.ProcessEnv; readonly ledgers: LedgerStores; readonly store: WorkspaceStore }): NonNullable<TickDeps['collect']> {
  return async (d, o) => {
    const gate = defaultGateConfig(opts.dataDir, opts.env, opts.ledgers)
    const options: RunnerOptions = {
      domain: d.host,
      plan: o.plan,
      day: o.day,
      engines: [...ENGINES],
      capUsd: ledgerCapUsd(opts.dataDir, opts.env),
      maxPrompts: gate.callsPerEngine,
      runAllowanceCalls: o.allowanceCalls,
      mode: o.mode,
      apiKey: o.apiKey,
      dataDir: opts.dataDir,
      outFile: join(opts.dataDir, 'latest.json'),
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
