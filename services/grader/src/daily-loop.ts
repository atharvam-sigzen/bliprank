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
 * ⚠️ FAIL CLOSED, LIKE THE GATES IT REUSES. A ledger that cannot be read is a
 * refusal for the whole tick; an environment that cannot size a scan is a
 * refusal; a second tick while one holds `tick.lock` is a refusal; a live
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

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OwnPlan } from '@bliprank/collector'
import { ENGINES } from '@bliprank/contracts'
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

export const dailyLedgerFile = (dataDir: string): string => join(dataDir, 'daily-spend.json')
const DAILY_LEDGER = 'daily-spend.json'

/** Read the ledger. Missing is empty; corrupt is an ERROR, because a loop that reads a corrupt ledger as zero spends the day twice. */
export async function readDailyLedger(dataDir: string, ledgers?: LedgerStores): Promise<DailyLedger> {
  const f = ledgers?.backend === 'kv' ? `the ${DAILY_LEDGER} ledger in Upstash` : dailyLedgerFile(dataDir)
  let parsed: unknown
  try {
    parsed = await (ledgers ?? ledgerStores(dataDir, process.env)).doc(DAILY_LEDGER).read()
  } catch (e) {
    throw new Error(`${f} is not readable JSON (${(e as Error).message}); the loop refuses to run until a person repairs it`)
  }
  if (parsed === null) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${f} is not a ledger; the loop refuses to run until a person repairs it`)
  const out: DailyLedger = {}
  for (const [day, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) throw new Error(`${f}: day ${day} is not a ledger entry`)
    const d = v as Partial<DailyLedgerDay>
    if (typeof d.capUsd !== 'number' || typeof d.spentUsd !== 'number' || typeof d.calls !== 'number') throw new Error(`${f}: day ${day} is missing its figures`)
    out[day] = { capUsd: d.capUsd, spentUsd: d.spentUsd, calls: d.calls, domains: typeof d.domains === 'object' && d.domains !== null ? d.domains : {} }
  }
  return out
}

const writeDailyLedger = (ledgers: LedgerStores, ledger: DailyLedger): Promise<DailyLedger> => ledgers.doc(DAILY_LEDGER).update(() => ledger)

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

/** One tick at a time per store. A lock older than six hours belongs to a tick that died and is reclaimed. */
function takeTickLock(dataDir: string): (() => void) | { readonly refuse: string } {
  mkdirSync(dataDir, { recursive: true })
  const lock = join(dataDir, 'tick.lock')
  try {
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > TICK_LOCK_STALE_MS) rmSync(lock, { force: true })
  } catch {
    /* vanished between the check and the stat */
  }
  let fd: number
  try {
    fd = openSync(lock, 'wx')
  } catch {
    return { refuse: `another tick holds ${lock}; two ticks over one store would each gate on a partial view of the day. If no tick is running, delete the lock.` }
  }
  writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
  return () => {
    try {
      closeSync(fd)
    } catch {
      /* already closed */
    }
    rmSync(lock, { force: true })
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
  const ledger = await readDailyLedger(opts.dataDir, ledgers)
  const today: DailyLedgerDay = ledger[day] ?? { capUsd, spentUsd: 0, calls: 0, domains: {} }
  const spentBefore = today.spentUsd

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

  const release = takeTickLock(opts.dataDir)
  if (typeof release !== 'function') return { refuse: release.refuse, list }
  try {
    return await runDue()
  } finally {
    release()
  }

  async function runDue(): Promise<TickOutcome> {
  const gateCfg = defaultGateConfig(opts.dataDir, opts.env, ledgers)
  const collect = deps.collect ?? defaultCollect({ dataDir: opts.dataDir, env: opts.env, ledgers, store })
  const gate = deps.gate ?? ((domain, needed, key, at) => checkGate(domain, { ...gateCfg, callsPerEngine: needed / ENGINES.length }, key, at))
  const ran: { host: string; status: string; spentUsd: number; calls: number }[] = []
  const refused: { host: string; reason: string }[] = []
  let current = { ...today, capUsd }

  for (const d of list.due) {
    const expected = d.usd * RETRY_HEADROOM
    const remaining = current.capUsd - current.spentUsd
    if (expected > remaining + 1e-9) {
      refused.push({ host: d.host, reason: `daily cap: $${expected.toFixed(3)} expected with headroom, $${remaining.toFixed(3)} of $${current.capUsd.toFixed(3)} left today` })
      continue
    }
    if (opts.mode === 'live') {
      const verdict = await gate(d.host, d.cells, apiKey, now())
      if (!verdict.ok) {
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
    // Booked and written before the next domain starts: a crash between two domains loses no spend.
    current = {
      capUsd,
      spentUsd: current.spentUsd + spent,
      calls: current.calls + calls,
      domains: { ...current.domains, [d.host]: { spentUsd: spent, calls, status, at: now().toISOString() } },
    }
    await writeDailyLedger(ledgers, { ...ledger, [day]: current })
    ran.push({ host: d.host, status, spentUsd: spent, calls })
  }
  if (ran.length === 0 && !ledger[day]) await writeDailyLedger(ledgers, { ...ledger, [day]: current })
  return { day, mode: opts.mode, capUsd, spentBefore, spentAfter: current.spentUsd, ran, refused, list }
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
