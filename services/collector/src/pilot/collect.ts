/**
 * G0 pilot collector — PHASES.md deliverable 0.5.
 *
 * Runs `bank.prompts × engines × runs` for one collection day through the
 * EngineAdapter contract, under a hard USD cap, and appends every RawAnswer to
 * pilot/data/<day>/<engine>.jsonl (verbatim payload included — this directory
 * is gitignored; rule R4). Resumable: existing (cell, run) pairs are skipped.
 *
 * Gate (rule R3): refuses unless COLLECTION_ENABLED=true, an API key is present
 * and COLLECTION_BUDGET_USD is set. Every attempt — retries and failures
 * included — is charged before it is made. `--fixture` swaps the provider for a
 * deterministic offline adapter (zero network, zero spend).
 *
 * Usage (from repo root):
 *   COLLECTION_ENABLED=true COLLECTION_BUDGET_USD=75 pnpm collector:pilot -- --day 2026-08-19 [--plan payg] [--runs 10]
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cacheCell, ENGINES, type CacheCell, type EngineAdapter, type EngineId, type RawAnswer, AdapterError } from '@bliprank/contracts'
import { openWebNinjaAdapter, PRICE_USD_PER_CALL, RPS_CEILING, type OwnPlan } from '../adapters/openwebninja.js'
import { Budget, BudgetExceeded } from '../budget.js'
import { fixtureAdapter } from './fixture-adapter.js'
import { loadDotEnv, parseArgs, percentile, sleep } from './util.js'

export interface Bank {
  category: string
  locale: string
  geo: string
  prompts: string[]
}

export interface RunOptions {
  day: string
  runs: number
  engines: EngineId[]
  plan: OwnPlan
  capUsd: number
  apiKey: string
  dataDir: string
  bank: Bank
  /** Fraction of the plan's published rps ceiling to use. */
  rpsScale: number
  /** Cap on prompts (smoke tests). */
  limitPrompts?: number
  fixture: boolean
  timeoutMs: number
  maxAttempts: number
  log: (line: string) => void
}

interface Job {
  cell: CacheCell
  prompt: string
  run: number
}

interface EngineStats {
  done: number
  failed: number
  attempts: number
  latencies: number[]
  parseFailures: number
}

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
export const PILOT_DIR = join(REPO_ROOT, 'services', 'collector', 'pilot')
/** CLAUDE.md: one key, 15 req/s ceiling — per-engine ceilings are scaled so their sum stays under it. */
export const KEY_RPS_CEILING = 15
/** Retry-After from the provider is honoured but never beyond this. */
const MAX_RETRY_AFTER_MS = 60_000

/** Spend recorded by other days' ledgers under the same data dir: the cap is per pilot, not per day. */
export function priorSpendUsd(dataDir: string, exceptDay: string): number {
  if (!existsSync(dataDir)) return 0
  let total = 0
  for (const d of readdirSync(dataDir)) {
    if (d === exceptDay) continue
    const f = join(dataDir, d, 'ledger.json')
    if (!existsSync(f)) continue
    try {
      total += (JSON.parse(readFileSync(f, 'utf8')) as { spentUsd?: number }).spentUsd ?? 0
    } catch {
      /* unreadable ledger: treated as zero, but a torn ledger is itself worth noticing */
    }
  }
  return total
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Simple per-engine rate limiter: at most one dispatch per interval, no burst. */
class Pacer {
  private next = 0
  constructor(private readonly intervalMs: number) {}
  async acquire(): Promise<void> {
    const now = Date.now()
    const at = Math.max(now, this.next)
    this.next = at + this.intervalMs
    if (at > now) await sleep(at - now)
  }
}

function loadDone(file: string, failuresFile: string, engine: string): Set<string> {
  const done = new Set<string>()
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line) as RawAnswer
        done.add(`${r.cell.key}#${r.run}`)
      } catch {
        /* a torn last line from a crash is simply re-collected */
      }
    }
  }
  // Non-retryable failures stay failed on resume: re-attempting a rejected key or an
  // unparseable shape only spends more. Retryable failures (timeouts, 5xx) are retried.
  if (existsSync(failuresFile)) {
    for (const line of readFileSync(failuresFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const f = JSON.parse(line) as { engine: string; cellKey: string; run: number; kind: string }
        if (f.engine === engine && (f.kind === 'rejected' || f.kind === 'unparseable')) done.add(`${f.cellKey}#${f.run}`)
      } catch {
        /* ignore */
      }
    }
  }
  return done
}

export async function runPilot(o: RunOptions): Promise<{ exitCode: number; stats: Record<string, EngineStats>; ledgerFile: string }> {
  const dayDir = join(o.dataDir, o.day)
  mkdirSync(dayDir, { recursive: true })
  const ledgerFile = join(dayDir, 'ledger.json')
  const failuresFile = join(dayDir, 'failures.jsonl')
  const lockFile = join(dayDir, 'run.lock')
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, 'utf8').trim())
    if (pid && pidAlive(pid)) throw new Error(`another run holds ${lockFile} (pid ${pid}); two runs would each spend up to the cap`)
  }
  writeFileSync(lockFile, String(process.pid))
  const releaseLock = () => {
    try {
      unlinkSync(lockFile)
    } catch {
      /* already gone */
    }
  }
  process.once('exit', releaseLock)
  writeFileSync(join(dayDir, 'meta.json'), JSON.stringify({ day: o.day, plan: o.plan, fixture: o.fixture, runs: o.runs, startedAt: new Date().toISOString() }, null, 2) + '\n')

  // The cap is for the whole pilot: what earlier days already spent comes off the top.
  const prior = priorSpendUsd(o.dataDir, o.day)
  const capToday = o.capUsd - prior
  if (capToday <= 0) {
    releaseLock()
    throw new BudgetExceeded({ capUsd: o.capUsd, spentUsd: prior, calls: 0, byEngine: {}, updatedAt: new Date().toISOString() }, 0)
  }
  if (prior > 0) o.log(`earlier days under ${o.dataDir} already spent $${prior.toFixed(4)}; today's ceiling is $${capToday.toFixed(4)} of the $${o.capUsd} pilot cap`)
  const budget = new Budget(ledgerFile, capToday, (engine) => (o.fixture ? 0 : PRICE_USD_PER_CALL[o.plan][engine as EngineId]))
  const planTotalRps = o.engines.reduce((sum, e) => sum + RPS_CEILING[o.plan][e], 0)
  const keyScale = Math.min(1, KEY_RPS_CEILING / planTotalRps)

  const prompts = o.limitPrompts ? o.bank.prompts.slice(0, o.limitPrompts) : o.bank.prompts
  const adapters = new Map<EngineId, EngineAdapter>()
  for (const engine of o.engines) {
    adapters.set(engine, o.fixture ? fixtureAdapter(engine) : openWebNinjaAdapter(engine, { apiKey: o.apiKey, plan: o.plan }))
  }

  const stats: Record<string, EngineStats> = {}
  let stopping = false
  let stopReason = ''
  const stopAll = (reason: string) => {
    if (!stopping) {
      stopping = true
      stopReason = reason
      o.log(`STOPPING: ${reason}`)
    }
  }
  process.once('SIGINT', () => stopAll('SIGINT'))

  const t0 = Date.now()
  const enginePromises = o.engines.map(async (engine) => {
    const adapter = adapters.get(engine)!
    const st: EngineStats = { done: 0, failed: 0, attempts: 0, latencies: [], parseFailures: 0 }
    stats[engine] = st
    const outFile = join(dayDir, `${engine}.jsonl`)
    const done = loadDone(outFile, failuresFile, engine)
    // runs are the outer loop so every cell gets run 0 before any cell gets run 1:
    // repeats are spread across the whole cycle rather than fired back-to-back.
    const jobs: Job[] = []
    for (let run = 0; run < o.runs; run++) {
      for (const prompt of prompts) {
        const cell = cacheCell({ prompt, engine, locale: o.bank.locale, geo: o.bank.geo, dateBucket: o.day })
        if (!done.has(`${cell.key}#${run}`)) jobs.push({ cell, prompt, run })
      }
    }
    const skipped = o.runs * prompts.length - jobs.length
    const rps = Math.max(0.2, RPS_CEILING[o.plan][engine] * keyScale * o.rpsScale)
    const pacer = new Pacer(1000 / rps)
    const concurrency = Math.min(64, Math.max(2, Math.ceil(rps * (o.timeoutMs / 1000))))
    o.log(`${engine}: ${jobs.length} calls to make (${skipped} already stored), ${rps.toFixed(2)} rps, ${concurrency} in flight max`)

    let next = 0
    const worker = async () => {
      while (!stopping && next < jobs.length) {
        const job = jobs[next++]!
        let attempt = 0
        for (;;) {
          attempt++
          st.attempts++
          try {
            budget.charge(engine)
          } catch (e) {
            if (e instanceof BudgetExceeded) {
              stopAll(e.message)
              return
            }
            throw e
          }
          await pacer.acquire()
          if (stopping) return
          const ac = new AbortController()
          const timer = setTimeout(() => ac.abort(), o.timeoutMs)
          try {
            const answer = await adapter.collect({ cell: job.cell, prompt: job.prompt, run: job.run, signal: ac.signal })
            // An adapter that had to chain calls reports it; charge the extra ones now.
            for (let extra = 1; extra < answer.providerCalls; extra++) {
              try {
                budget.charge(engine)
              } catch (e) {
                if (e instanceof BudgetExceeded) stopAll(e.message)
                else throw e
              }
            }
            appendFileSync(outFile, JSON.stringify(answer) + '\n')
            st.done++
            st.latencies.push(answer.latencyMs)
            if (st.done % 100 === 0) o.log(`${engine}: ${st.done}/${jobs.length} stored, $${budget.state.spentUsd.toFixed(2)} charged so far`)
            break
          } catch (e) {
            const err = e instanceof AdapterError ? e : new AdapterError('provider', String(e), false)
            if (err.kind === 'unparseable') st.parseFailures++
            const retry = err.retryable && attempt < o.maxAttempts && !stopping
            if (!retry) {
              st.failed++
              appendFileSync(
                failuresFile,
                JSON.stringify({ engine, cellKey: job.cell.key, prompt: job.prompt, run: job.run, kind: err.kind, message: err.message, attempts: attempt, at: new Date().toISOString() }) + '\n',
              )
              // A rejected key/quota is not going to fix itself: stop spending on this engine.
              if (err.kind === 'rejected') {
                o.log(`${engine}: non-retryable rejection (${err.message}); giving up on this engine`)
                next = jobs.length
              }
              break
            }
            const backoff = Math.min(MAX_RETRY_AFTER_MS, err.retryAfterMs ?? 1000 * 4 ** (attempt - 1))
            await sleep(backoff + Math.random() * 250)
          } finally {
            clearTimeout(timer)
          }
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))
    const p = (q: number) => percentile(st.latencies, q)
    o.log(`${engine}: done=${st.done} failed=${st.failed} attempts=${st.attempts} parseFailures=${st.parseFailures} latency p50=${p(50)}ms p95=${p(95)}ms`)
  })
  await Promise.all(enginePromises)

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0)
  releaseLock()
  o.log(`finished in ${elapsed}s: $${budget.state.spentUsd.toFixed(4)} charged today, $${(prior + budget.state.spentUsd).toFixed(4)} across the pilot, cap $${o.capUsd} (${budget.state.calls} attempts today); ledger ${ledgerFile}`)
  if (stopping && stopReason !== 'SIGINT') return { exitCode: 3, stats, ledgerFile }
  return { exitCode: stopping ? 130 : 0, stats, ledgerFile }
}

/** Build options from argv + env; refuses (exit 2) when the R3 gate is not satisfied. */
export function optionsFromEnv(argv: string[], env: NodeJS.ProcessEnv, log = (l: string) => console.error(l)): RunOptions | { refuse: string } {
  const args = parseArgs(argv)
  const fixture = args.has('fixture')
  const day = String(args.get('day') ?? new Date().toISOString().slice(0, 10))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { refuse: `--day must be YYYY-MM-DD, got ${day}` }
  const enginesArg = String(args.get('engines') ?? 'all')
  const engines = (enginesArg === 'all' ? [...ENGINES] : enginesArg.split(',')) as EngineId[]
  for (const e of engines) if (!(ENGINES as readonly string[]).includes(e)) return { refuse: `unknown engine ${e}` }
  // The plan decides the marginal price the ledger charges: pay-as-you-go is 3–4× Mega.
  // It is never defaulted for a real run — a wrong guess is either an under-charged
  // ledger or a cap that stops the pilot a third of the way in.
  const planArg = args.get('plan') ?? env['OPENWEBNINJA_PLAN']
  const plan = String(planArg ?? 'payg') as OwnPlan
  if (!(plan in PRICE_USD_PER_CALL)) return { refuse: `unknown plan ${plan}` }
  const bank = JSON.parse(readFileSync(String(args.get('bank') ?? join(PILOT_DIR, 'bank.json')), 'utf8')) as Bank

  if (!fixture) {
    if (env['COLLECTION_ENABLED'] !== 'true') {
      return { refuse: 'COLLECTION_ENABLED is not "true" (rule R3). Enable it deliberately for the duration of the run only.' }
    }
    if (!env['OPENWEBNINJA_API_KEY']) return { refuse: 'OPENWEBNINJA_API_KEY is not set (env or .env.local).' }
  }
  const capUsd = Number(args.get('cap') ?? env['COLLECTION_BUDGET_USD'])
  if (!fixture && !(capUsd > 0)) return { refuse: 'COLLECTION_BUDGET_USD (or --cap) must be a positive number: no run without an explicit ceiling.' }
  if (!fixture && !planArg) return { refuse: 'plan not set: pass --plan payg|pro|ultra|mega or set OPENWEBNINJA_PLAN. Not defaulted — it decides what every call is charged at.' }

  return {
    day,
    runs: Number(args.get('runs') ?? 10),
    engines,
    plan,
    capUsd: fixture ? Number(args.get('cap') ?? 1) : capUsd,
    apiKey: fixture ? 'fixture' : String(env['OPENWEBNINJA_API_KEY']),
    dataDir: String(args.get('data') ?? join(PILOT_DIR, 'data')),
    bank,
    rpsScale: Number(args.get('rps-scale') ?? 0.6),
    ...(args.has('limit-prompts') ? { limitPrompts: Number(args.get('limit-prompts')) } : {}),
    fixture,
    timeoutMs: Number(args.get('timeout-ms') ?? 45_000),
    maxAttempts: Number(args.get('max-attempts') ?? 3),
    log,
  }
}

/** `--preview`: validate the gate and print the projection, then stop before any call. */
const opts_preview = (argv: string[]) => argv.includes('--preview')

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const loadedKeys = loadDotEnv(REPO_ROOT)
  if (loadedKeys.length) console.error(`loaded from dotenv (values never printed): ${loadedKeys.join(', ')}`)
  const opts = optionsFromEnv(process.argv.slice(2), process.env)
  if ('refuse' in opts) {
    console.error(`REFUSED: ${opts.refuse}`)
    process.exit(2)
  }
  const { plan, engines, runs, day, capUsd, fixture } = opts
  const calls = opts.bank.prompts.length * engines.length * runs
  const est = fixture ? 0 : engines.reduce((s, e) => s + PRICE_USD_PER_CALL[plan][e] * (opts.limitPrompts ?? opts.bank.prompts.length) * runs, 0)
  const prior = priorSpendUsd(opts.dataDir, day)
  console.error(`pilot ${day}: ${calls} calls planned, plan=${plan}, projected $${est.toFixed(2)} (before retries); pilot cap $${capUsd}, already spent on other days $${prior.toFixed(2)}${fixture ? ' [FIXTURE MODE, no network]' : ''}`)
  if (!fixture && est > capUsd - prior) {
    console.error(`REFUSED: projected spend $${est.toFixed(2)} exceeds the remaining cap $${(capUsd - prior).toFixed(2)}; shrink --runs/--limit-prompts or raise the cap deliberately`)
    process.exit(2)
  }
  if (opts_preview(process.argv)) {
    console.error('PREVIEW: gate satisfied and cost projected; no call made, nothing charged.')
    process.exit(0)
  }
  runPilot(opts).then((r) => process.exit(r.exitCode))
}
