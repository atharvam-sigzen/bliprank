/**
 * PHASES 3.3 — the Grader scan runner. Local, single-process, budgeted.
 *
 *   pnpm grader:scan -- --domain pipedrive.com --preview
 *   COLLECTION_ENABLED=true pnpm grader:scan -- --domain pipedrive.com --plan mega --cap 1.00
 *
 * WHY A RUNNER AND NOT AN ENDPOINT ON THE GRADER PAGE.
 *
 * Rule R3: nothing spends outside the scheduler, with an explicit budget. A form
 * on a public page wired straight to collection is the opposite of that — it is
 * an unauthenticated, unmetered spend trigger, and P3.6 (Turnstile, per-IP cap)
 * does not exist yet. `COLLECTION_BUDGET_USD_DAILY` is also a single global
 * ceiling shared with paid collection, so a burst of free traffic would stop
 * customers' cycles, not just cost money.
 *
 * So the scan runs here, where the cap, the lock, the plan and the day are all
 * explicit, and the page consumes the result. When P3.6 lands, the same
 * `runScan` moves behind an endpoint unchanged; the gates below are what has to
 * be reproduced there, not the pipeline.
 *
 * EVERY GATE IS A REFUSAL, NOT A DEFAULT. No plan is assumed (payg is 3.8x mega
 * and guessing wrong is the whole invoice), no cap is assumed, collection is off
 * unless deliberately enabled, and the default mode is `--fixture`, which
 * cannot reach a provider at all.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AnswerIndex,
  Budget,
  CollectionOrchestrator,
  LocalRateBudget,
  LocalSpendLedger,
  PRICE_USD_PER_CALL,
  RPS_CEILING,
  openWebNinjaAdapter,
  stubAdapter,
  type BucketConfig,
  type DeadLetter,
  type DeadLetterEntry,
  type OwnPlan,
} from '@bliprank/collector'
import { ENGINES, type EngineId } from '@bliprank/contracts'
import { fixtureAdapter } from '@bliprank/collector/fixture'
import { loadApiKey } from './load-key.js'
import { FileBlobStore, FileKV } from './local-store.js'
import { runScan, type ScanProgress, type ScanResult } from './scan.js'

/** Provider ceiling for one API key, shared across engines. */
const KEY_RPS_CEILING = 15

export interface RunnerOptions {
  readonly domain: string
  readonly plan: OwnPlan
  readonly day: string
  readonly engines: readonly EngineId[]
  readonly capUsd: number
  readonly maxPrompts?: number
  /** Absolute per-engine ceiling, below whatever the plan table allows. */
  readonly maxRps?: number
  /** Observe each cell as it completes — the SSE route streams these. */
  readonly onProgress?: (p: ScanProgress) => void
  readonly mode: 'live' | 'fixture' | 'stub'
  readonly apiKey: string
  readonly dataDir: string
  readonly outFile: string
  readonly log: (s: string) => void
}

export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  /**
   * Where to look for `.env.local`/`.env`. Injected so a test can point at a
   * directory that has neither — without it the loader falls back to the real
   * repo root, finds the developer's own key, and the "refuses without a key"
   * test passes on this machine and fails on a build agent.
   */
  root?: string,
): { opts: RunnerOptions; preview: boolean; keySource?: string } | { refuse: string } {
  let keySource = 'n/a'
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const v = argv[i + 1]?.startsWith('--') === false ? argv[++i]! : 'true'
    args.set(k, v)
  }

  const domain = args.get('domain')
  if (!domain) return { refuse: 'no --domain given' }

  const mode = args.get('fixture') ? 'fixture' : args.get('stub') ? 'stub' : 'live'
  const offline = mode !== 'live'

  // The plan decides what every call is charged at. payg is 3.8x mega across a
  // whole scan, so a wrong guess is the entire invoice, not a rounding error.
  const planArg = args.get('plan') ?? env['OPENWEBNINJA_PLAN']
  const plan = String(planArg ?? 'payg') as OwnPlan
  if (!(plan in PRICE_USD_PER_CALL)) return { refuse: `unknown plan "${plan}"` }
  if (!offline && !planArg) return { refuse: 'plan not set: pass --plan payg|pro|ultra|mega or set OPENWEBNINJA_PLAN. Not defaulted.' }

  // Secret from the file, decisions from the command line. COLLECTION_ENABLED
  // and the plan are deliberately NOT read from .env — see load-key.ts.
  const repoRoot = root ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const found = loadApiKey(repoRoot, env)
  const apiKey = found?.key ?? ''
  if (!offline && !apiKey) return { refuse: `OPENWEBNINJA_API_KEY not found in the environment, .env.local or .env` }
  if (!offline) keySource = found?.from ?? 'unknown'
  if (!offline && env['COLLECTION_ENABLED'] !== 'true') {
    return { refuse: 'COLLECTION_ENABLED is not "true" (rule R3). Enable it deliberately for this run, or pass --fixture.' }
  }

  const capArg = args.get('cap')
  if (!offline && !capArg) return { refuse: 'no --cap given: this run may spend, and a run that may spend states its ceiling.' }
  const capUsd = Number(capArg ?? 1)
  if (!Number.isFinite(capUsd) || capUsd <= 0) return { refuse: `--cap must be > 0, got ${capArg}` }

  const engines = (args.get('engines')?.split(',').filter(Boolean) ?? [...ENGINES]) as EngineId[]
  for (const e of engines) if (!(ENGINES as readonly string[]).includes(e)) return { refuse: `unknown engine "${e}"` }

  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const dataDir = args.get('data') ?? join(here, '..', 'data')
  const maxPromptsArg = args.get('max-prompts')
  const maxRpsArg = args.get('max-rps')
  if (maxRpsArg !== undefined && !(Number(maxRpsArg) > 0)) return { refuse: `--max-rps must be > 0, got ${maxRpsArg}` }

  return {
    keySource,
    preview: args.has('preview'),
    opts: {
      domain,
      plan,
      day: args.get('day') ?? new Date().toISOString().slice(0, 10),
      engines,
      capUsd,
      ...(maxPromptsArg ? { maxPrompts: Number(maxPromptsArg) } : {}),
      ...(maxRpsArg ? { maxRps: Number(maxRpsArg) } : {}),
      mode,
      apiKey,
      dataDir,
      outFile: args.get('out') ?? join(dataDir, 'latest.json'),
      log: (s) => process.stdout.write(`${s}\n`),
    },
  }
}

/** Worst-case spend: every cell a miss, every call charged at the plan's rate. */
export function estimateUsd(o: Pick<RunnerOptions, 'plan' | 'engines' | 'mode'>, promptCount: number, runsPerCell = 1): number {
  if (o.mode !== 'live') return 0
  return o.engines.reduce((sum, e) => sum + PRICE_USD_PER_CALL[o.plan][e] * promptCount * runsPerCell, 0)
}

export async function runGrader(o: RunnerOptions): Promise<ScanResult> {
  mkdirSync(o.dataDir, { recursive: true })
  const lock = join(o.dataDir, 'run.lock')
  if (existsSync(lock)) {
    throw new Error(`another scan holds ${lock} (pid ${readFileSync(lock, 'utf8').trim()}). The cap is per data dir, so two concurrent runs would each see prior spend of 0.`)
  }
  writeFileSync(lock, String(process.pid))

  try {
    const offline = o.mode !== 'live'
    const budget = new Budget(join(o.dataDir, 'ledger.json'), o.capUsd, (engine) => (offline ? 0 : PRICE_USD_PER_CALL[o.plan][engine as EngineId]))

    // Share one key's ceiling across the engines in play, then take a fraction
    // of it — the published per-engine ceilings sum to more than one key allows.
    const planTotalRps = o.engines.reduce((s, e) => s + RPS_CEILING[o.plan][e], 0)
    const scale = Math.min(1, KEY_RPS_CEILING / planTotalRps) * 0.6
    // Keyed by ENGINE ID, which is what the orchestrator looks up. Getting this
    // wrong does not fall back to unlimited — `RangeError: unknown rate bucket`
    // failed every cell closed, which is the right direction and how it surfaced.
    //
    // `--max-rps` is an ABSOLUTE floor on top of that, and it exists because our
    // plan table cannot express the tier a trial key is actually on. `OwnPlan`
    // has payg/pro/ultra/mega; the provider also has a Free tier whose terms are
    // different in kind — 50 requests a MONTH, hard limit, no overage — and
    // adding it to `RPS_CEILING`/`PRICE_USD_PER_CALL` is a change to
    // rate-limit and spend-control logic, which is HUMAN-OWNED. So a trial run
    // declares its real ceiling here instead of misdeclaring its plan.
    const buckets = Object.fromEntries(
      o.engines.map((e) => {
        const planRps = RPS_CEILING[o.plan][e] * scale
        return [e, { rps: Math.max(0.05, o.maxRps === undefined ? planRps : Math.min(planRps, o.maxRps)), burst: 1 } satisfies BucketConfig]
      }),
    )

    const declared = { ...process.env, COLLECTOR_TOPOLOGY: 'single-process' }
    const reason = 'local Grader runner: one process, holding an exclusive run.lock over its data dir'
    const blob = new FileBlobStore(join(o.dataDir, 'answers'))
    // A real DeadLetter, appended to disk. A cell that fails after burning its
    // attempts must leave a durable trace: the scan then reports a smaller `n`
    // and a wider interval, and without this the reason for the shortfall is
    // gone. The first version of this shim had the wrong signature and swallowed
    // every failure reason, which is how "20/20 failed" arrived with no cause.
    const dlFile = join(o.dataDir, 'dead-letter.jsonl')
    const seen: DeadLetterEntry[] = []
    const deadLetter: DeadLetter = {
      record(entry: DeadLetterEntry): void {
        seen.push(entry)
        writeFileSync(dlFile, `${JSON.stringify(entry)}\n`, { flag: 'a' })
      },
      list: (engine?: string) => seen.filter((e) => !engine || e.engine === engine),
      count: (engine?: string, kind?: string) => seen.filter((e) => (!engine || e.engine === engine) && (!kind || e.kind === kind)).length,
    }

    const orchestrator = new CollectionOrchestrator({
      index: new AnswerIndex(new FileKV(join(o.dataDir, 'index.json'))),
      blob,
      rateBudget: LocalRateBudget.forSingleProcess(buckets, { iUnderstandThisBudgetIsPerProcess: true, reason, env: declared }),
      budget: LocalSpendLedger.forSingleProcess(budget, { iUnderstandThisCapIsPerProcess: true, reason, env: declared }),
      deadLetter,
      owner: `grader-local-${process.pid}`,
    })

    const adapterFor = (engine: EngineId) =>
      o.mode === 'fixture' ? fixtureAdapter(engine) : o.mode === 'stub' ? stubAdapter(engine) : openWebNinjaAdapter(engine, { apiKey: o.apiKey, plan: o.plan })

    const result = await runScan(
      { domain: o.domain, engines: o.engines, day: o.day, runsPerCell: 1, ...(o.maxPrompts ? { maxPrompts: o.maxPrompts } : {}) },
      {
        orchestrator,
        blob,
        adapterFor,
        onProgress: (p) => {
          o.onProgress?.(p)
          if (p.done % 10 === 0 || p.done === p.total) o.log(`  ${p.done}/${p.total} cells · ${p.outcome}`)
        },
      },
    )

    const spent = budget.state.spentUsd
    const envelope = { ...result, run: { mode: o.mode, plan: o.plan, day: o.day, engines: o.engines, spentUsd: spent, capUsd: o.capUsd, at: new Date().toISOString() } }
    writeFileSync(o.outFile, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
    o.log(`\nspent $${spent.toFixed(4)} of the $${o.capUsd.toFixed(2)} cap · ${blob.size} stored cells · wrote ${o.outFile}`)
    return result
  } finally {
    if (existsSync(lock)) unlinkSync(lock)
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2), process.env)
  if ('refuse' in parsed) {
    process.stderr.write(`refusing: ${parsed.refuse}\n`)
    process.exit(2)
  }
  const { opts, preview } = parsed
  if (opts.mode === 'live') opts.log(`  key loaded from ${parsed.keySource ?? 'unknown'}`)

  // Print the bill before incurring it, never after. `/backfill` holds the same
  // rule and it is the difference between a decision and a discovery.
  const promptsIfWhole = opts.maxPrompts ?? 17
  const worst = estimateUsd(opts, promptsIfWhole)
  opts.log(
    `grader scan · ${opts.domain} · mode=${opts.mode} · plan=${opts.plan} · day=${opts.day}\n` +
      `  ${opts.engines.length} engines x up to ${promptsIfWhole} unprompted prompts x 1 run\n` +
      `  worst case (every cell a miss): $${worst.toFixed(4)} against a $${opts.capUsd.toFixed(2)} cap`,
  )
  if (preview) {
    opts.log('\n--preview: nothing collected, nothing charged.')
    return
  }

  const result = await runGrader(opts)
  opts.log(`\nstatus: ${result.status}`)
  if (result.status === 'scanned') {
    opts.log(`category: ${result.category} · answers scored: ${result.counts.answersScored} · provider calls: ${result.counts.providerCalls}`)
    for (const b of [...result.brands].sort((x, y) => y.metric.value - x.metric.value)) {
      const pct = (v: number) => `${(v * 100).toFixed(1)}%`
      opts.log(`  ${b.isSubject ? '>' : ' '} ${b.name.padEnd(24)} ${pct(b.metric.value).padStart(6)}  [${pct(b.metric.ci_low)}–${pct(b.metric.ci_high)}]  n=${b.metric.n}`)
    }
  } else if (result.status === 'ambiguous') {
    opts.log(`candidates: ${result.candidates.join(', ')} — nothing collected, nothing charged.`)
  } else if (result.status === 'unclassified') {
    opts.log(`reason: ${result.reason} — nothing collected, nothing charged.`)
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('run.ts')) {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`)
    process.exit(1)
  })
}
