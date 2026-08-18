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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cacheCell, ENGINES, type CacheCell, type EngineAdapter, type EngineId, type RawAnswer, AdapterError } from '@bliprank/contracts'
import { openWebNinjaAdapter, PRICE_USD_PER_CALL, RPS_CEILING, type OwnPlan } from '../adapters/openwebninja.js'
import { Budget, BudgetExceeded } from '../budget.js'
import { fixtureAdapter } from './fixture-adapter.js'
import { loadDotEnvLocal, parseArgs, percentile, sleep } from './util.js'

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

function loadDone(file: string): Set<string> {
  const done = new Set<string>()
  if (!existsSync(file)) return done
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as RawAnswer
      done.add(`${r.cell.key}#${r.run}`)
    } catch {
      /* a torn last line from a crash is simply re-collected */
    }
  }
  return done
}

export async function runPilot(o: RunOptions): Promise<{ exitCode: number; stats: Record<string, EngineStats>; ledgerFile: string }> {
  const dayDir = join(o.dataDir, o.day)
  mkdirSync(dayDir, { recursive: true })
  const ledgerFile = join(dayDir, 'ledger.json')
  const failuresFile = join(dayDir, 'failures.jsonl')
  const budget = new Budget(ledgerFile, o.capUsd, (engine) => (o.fixture ? 0 : PRICE_USD_PER_CALL[o.plan][engine as EngineId]))

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
    const done = loadDone(outFile)
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
    const rps = Math.max(0.2, RPS_CEILING[o.plan][engine] * o.rpsScale)
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
            const backoff = err.retryAfterMs ?? 1000 * 4 ** (attempt - 1)
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
  o.log(`finished in ${elapsed}s: $${budget.state.spentUsd.toFixed(4)} charged of $${o.capUsd} cap (${budget.state.calls} attempts); ledger ${ledgerFile}`)
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
  const plan = String(args.get('plan') ?? env['OPENWEBNINJA_PLAN'] ?? 'payg') as OwnPlan
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

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  loadDotEnvLocal(REPO_ROOT)
  const opts = optionsFromEnv(process.argv.slice(2), process.env)
  if ('refuse' in opts) {
    console.error(`REFUSED: ${opts.refuse}`)
    process.exit(2)
  }
  const { plan, engines, runs, day, capUsd, fixture } = opts
  const calls = opts.bank.prompts.length * engines.length * runs
  const est = fixture ? 0 : engines.reduce((s, e) => s + PRICE_USD_PER_CALL[plan][e] * (opts.limitPrompts ?? opts.bank.prompts.length) * runs, 0)
  console.error(`pilot ${day}: ${calls} calls planned, plan=${plan}, projected $${est.toFixed(2)} (before retries), cap $${capUsd}${fixture ? ' [FIXTURE MODE, no network]' : ''}`)
  if (!fixture && est > capUsd) {
    console.error(`REFUSED: projected spend $${est.toFixed(2)} exceeds cap $${capUsd}; shrink --runs/--limit-prompts or raise the cap deliberately`)
    process.exit(2)
  }
  runPilot(opts).then((r) => process.exit(r.exitCode))
}
