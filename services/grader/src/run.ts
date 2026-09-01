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
import { DEFAULT_CAP_USD } from './live-gate.js'
import { runScan, type ScanProgress, type ScanResult } from './scan.js'
import { allBanks, allCategories, resolveCategory } from './resolve-category.js'
import { bankAuthorConfig, type BankAuthorConfig } from './bank-author.js'

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
  /**
   * Which model authors a bank when no category in the taxonomy fits (rung 4 of
   * `resolve-category.ts`), resolved from the environment by `bankAuthorConfig`.
   * Absent disables authoring only — the homepage signal still runs, and an
   * unauthorable domain falls back exactly as before.
   */
  readonly author?: BankAuthorConfig | undefined
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
  const author = bankAuthorConfig(env, (n) => loadApiKey(repoRoot, env, n)?.key) ?? undefined
  if (!offline && env['COLLECTION_ENABLED'] !== 'true') {
    return { refuse: 'COLLECTION_ENABLED is not "true" (rule R3). Enable it deliberately for this run, or pass --fixture.' }
  }

  const capArg = args.get('cap')
  if (!offline && !capArg) return { refuse: 'no --cap given: this run may spend, and a run that may spend states its ceiling.' }
  const capUsd = Number(capArg ?? DEFAULT_CAP_USD)
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
      /*
       * The bank author, from the environment and the same repo-root dotenv the
       * provider key comes from. Absent when no key is configured, which
       * disables rung 4 and nothing else.
       *
       * SECRETS FROM THE FILE, DECISIONS FROM THE COMMAND LINE still holds.
       * Every DECISION this runner makes -- plan, cap, mode -- is still a flag it
       * refuses to default. Which model authors a bank is not that kind of
       * decision: it spends no provider quota, it cannot change what a scan
       * costs, and the whole point of the seam is that swapping a rate-limited
       * free tier is an env edit rather than a new flag on every command anyone
       * has already written down.
       */
      ...(author ? { author } : {}),
      log: (s) => process.stdout.write(`${s}\n`),
    },
  }
}

/** Worst-case spend: every cell a miss, every call charged at the plan's rate. */
export function estimateUsd(o: Pick<RunnerOptions, 'plan' | 'engines' | 'mode'>, promptCount: number, runsPerCell = 1): number {
  if (o.mode !== 'live') return 0
  return o.engines.reduce((sum, e) => sum + PRICE_USD_PER_CALL[o.plan][e] * promptCount * runsPerCell, 0)
}

/**
 * What the runner knows about the run behind a result — the shape the Grader UI
 * reads as `ScanRun`.
 *
 * RETURNED, not only written to `outFile`. It used to exist solely inside the
 * envelope this function writes to disk, so `/api/scan` — which caches what this
 * function RETURNS — cached a file with no run block, and the dashboard that
 * read `scan.run.engines.length` threw on it. `spentUsd` is the ledger's own
 * figure and is knowable nowhere else, which is why the block is built here
 * rather than reconstructed by the caller from what it happens to remember.
 */
export interface GraderRun {
  readonly mode: RunnerOptions['mode']
  readonly plan: OwnPlan
  readonly day: string
  readonly engines: readonly EngineId[]
  /** THIS run's marginal provider spend: the ledger delta, never its total. */
  readonly spentUsd: number
  readonly capUsd: number
  readonly at: string
}

export async function runGrader(o: RunnerOptions): Promise<ScanResult & { readonly run: GraderRun }> {
  mkdirSync(o.dataDir, { recursive: true })
  const lock = join(o.dataDir, 'run.lock')
  const touchLock = () => {
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }))
    } catch {
      /* losing a heartbeat must not kill a scan that is otherwise fine */
    }
  }

  if (existsSync(lock)) {
    // A lock is stale in TWO ways and the pid alone only catches one.
    //
    // Dead owner: a crashed run or a killed server. `process.kill(pid, 0)`
    // sees that.
    //
    // Live owner, dead scan: this is the one that bit. A browser that
    // disconnects mid-scan makes the server abort the request handler, so the
    // `finally` below never runs — but the owning process is the long-lived dev
    // server, which is still very much alive. The pid check therefore obeys a
    // lock nobody is holding, forever, and every later scan is refused. Found by
    // disconnecting a client and watching the next scan fail.
    //
    // So the lock carries a heartbeat, refreshed as cells complete. A lock not
    // touched for longer than the slowest imaginable cell is not being held.
    const STALE_MS = 3 * 60_000
    const raw = readFileSync(lock, 'utf8').trim()
    let owner = Number(raw)
    let at = 0
    try {
      const parsed = JSON.parse(raw) as { pid: number; at: number }
      owner = parsed.pid
      at = parsed.at
    } catch {
      /* an older lock held a bare pid and no heartbeat */
    }

    let alive = false
    try {
      process.kill(owner, 0)
      alive = true
    } catch {
      alive = false
    }
    // No self-exemption. It used to say `owner !== process.pid` so a process
    // could re-enter its own lock — but the route runs every scan inside ONE
    // long-lived server, so that exemption let two concurrent scans in the same
    // process each reclaim the other's lock and each see prior spend of 0. The
    // heartbeat makes the exemption unnecessary: it already distinguishes my own
    // ACTIVE scan from my own ABANDONED one, which is the real question.
    const fresh = at > 0 && Date.now() - at < STALE_MS

    if (alive && fresh) {
      const age = Math.round((Date.now() - at) / 1000)
      throw new Error(`another scan holds ${lock} (pid ${owner}, last active ${age}s ago). The cap is per data dir, so two concurrent runs would each see prior spend of 0.`)
    }
    o.log(alive ? `reclaiming run.lock: pid ${owner} is alive but its scan stopped ${at ? Math.round((Date.now() - at) / 1000) + 's ago' : 'without a heartbeat'}` : `reclaiming a stale run.lock left by pid ${owner}, which is no longer running`)
    unlinkSync(lock)
  }
  touchLock()

  try {
    const offline = o.mode !== 'live'
    // An offline run gets its OWN ledger, and that is not tidiness.
    //
    // A fixture run charges $0, so its only effect on the shared ledger was to
    // rewrite `capUsd` to whatever default it happened to carry — and `Budget`
    // then refuses every later run that asks for more, correctly, because it
    // will not widen a cap silently. One `--fixture` scan with the default cap
    // of $1 therefore blocked every live scan afterwards, which is a fixture
    // run breaking live collection while spending nothing. Found by doing
    // exactly that during a lock test.
    const ledgerFile = join(o.dataDir, offline ? `ledger.${o.mode}.json` : 'ledger.json')
    const budget = new Budget(ledgerFile, o.capUsd, (engine) => (offline ? 0 : PRICE_USD_PER_CALL[o.plan][engine as EngineId]))
    // THE LEDGER IS CUMULATIVE FOR THE DATA DIR, THIS RUN IS NOT.
    //
    // `Budget` loads the existing ledger off disk and only ever adds to it, so
    // `state.spentUsd` after a scan is everything that dir has ever paid for.
    // Stamping that into the result made a 22-call scan report $0.7640 - 4.3x
    // its own cost, and growing with every later run - and /api/scan then
    // cached that figure as the domain's own. The delta is the only per-scan
    // number the ledger can honestly yield.
    const spentBefore = budget.state.spentUsd

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

    /*
     * THE RICHER CLASSIFIER, ON LIVE RUNS ONLY.
     *
     * Not a capability gate — it is that the other two modes must stay offline.
     * `--fixture` is what CI and every test use, and its whole promise is that
     * nothing leaves the machine; a homepage GET would break that quietly and
     * make the suite depend on someone else's uptime. `--stub` is the same
     * bargain. A live run is already reaching the network by definition.
     *
     * The fixture adapter also only holds answers for the hand-authored banks,
     * so a generated bank on a fixture run would collect nothing and report
     * `no-answers` — a confusing way to say "this mode cannot do that".
     */
    const resolver =
      o.mode === 'live'
        ? async (domain: string) => {
            const r = await resolveCategory(domain, {
              dataDir: o.dataDir,
              author: o.author,
              log: o.log,
            })
            return {
              slug: r.record.slug,
              bank: r.bank,
              signal: r.record.source,
              evidence: r.record.evidence,
              ...(r.fallback ? { fallback: r.fallback } : {}),
            }
          }
        : undefined

    const result = await runScan(
      { domain: o.domain, engines: o.engines, day: o.day, runsPerCell: 1, ...(o.maxPrompts ? { maxPrompts: o.maxPrompts } : {}) },
      {
        orchestrator,
        blob,
        adapterFor,
        // Banks grown by earlier scans are in scope for this one, so the second
        // domain in an authored category joins it rather than authoring a
        // duplicate — and `compare()` can then put the two side by side.
        banks: allBanks(o.dataDir),
        taxonomy: allCategories(o.dataDir),
        ...(resolver ? { resolveCategory: resolver } : {}),
        onProgress: (p) => {
          // The heartbeat. A lock that stops being touched is a scan that
          // stopped, whether or not the process holding it is still alive.
          touchLock()
          o.onProgress?.(p)
          if (p.done % 10 === 0 || p.done === p.total) o.log(`  ${p.done}/${p.total} cells · ${p.outcome}`)
        },
      },
    )

    const spentThisRun = budget.state.spentUsd - spentBefore
    const run: GraderRun = { mode: o.mode, plan: o.plan, day: o.day, engines: o.engines, spentUsd: spentThisRun, capUsd: o.capUsd, at: new Date().toISOString() }
    const envelope = { ...result, run }
    writeFileSync(o.outFile, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
    // Cumulative here, deliberately: "of the cap" is a statement about the cap,
    // which is per data dir and not per scan.
    o.log(`\nspent $${budget.state.spentUsd.toFixed(4)} of the $${o.capUsd.toFixed(2)} cap · ${blob.size} stored cells · wrote ${o.outFile}`)
    return envelope
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
