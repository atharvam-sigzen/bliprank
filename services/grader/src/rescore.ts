/**
 * `pnpm grader:rescore` — re-derive a stored result from answers already bought.
 *
 *   pnpm grader:rescore -- --domain pipedrive.com
 *   pnpm grader:rescore -- --all --apply
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY IT IS NOT A SCRIPT SOMEBODY RUNS ONCE.
 *
 * R5 forbids mutating a historical score and prescribes the alternative: bump
 * the version, re-score forward, keep the superseded row. Until now there was no
 * tool for the second half — the one previous re-score was done by hand, and the
 * only trace of it is a `thecosmicbyte.com.det-1.audit.json` beside a result
 * whose provenance nothing can reproduce.
 *
 * A re-score is needed whenever the DERIVATION changes over answers that have
 * not: a new scoring version, a promoted competitor set, or a result field that
 * did not exist when the file was written (`promptRows`, 2026-09-02). Each of
 * those makes every stored result an answer to a question we no longer ask.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ IT PROVES IT IS FREE BEFORE IT RUNS, RATHER THAN CHECKING AFTERWARDS.
 *
 * Every cell this scan would need is looked up in the answer index FIRST. One
 * miss and nothing runs at all. That ordering is the whole safety property: a
 * check after the fact discovers a charge, it does not prevent one.
 *
 * The cells come from `cellsFor` in `scan.ts` — the same function `runScan`
 * builds its own list from, not a copy of the loop. A second definition of
 * "which cells does this bank need" would drift in exactly one direction: the
 * check passes, the scan then misses, and the misses cost money.
 *
 * Three things follow from the check passing, and they are worth stating because
 * each is a thing that could otherwise go wrong:
 *
 *   - THE CAP IS THE LEDGER'S OWN. `Budget` permanently lowers a ledger's cap
 *     when opened with a smaller one, so passing a "safe" small cap here would
 *     quietly cripple the next real collection run against this data dir. The
 *     existing cap is read and passed back unchanged.
 *   - THE CATEGORY IS THE RECORDED ONE. A domain with no record is refused
 *     rather than re-classified: re-deriving a historical number under a
 *     category we would have to decide today is precisely the rebase R5 and
 *     `recordCategory` exist to prevent.
 *   - THE DAY IS THE FILE'S OWN. The cache key contains the date bucket, so
 *     running with today's date would miss every cell and buy the lot.
 *
 * ⚠️ THE SUPERSEDED ROW IS KEPT, ALWAYS. `<domain>.<algo>.audit.json`, never
 * overwritten. Competitors silently rebase history; we do not.
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnswerIndex, type OwnPlan } from '@bliprank/collector'
import { ENGINES, type EngineId } from '@bliprank/contracts'
import { DEFAULT_CAP_USD, defaultGateConfig } from './live-gate.js'
import { loadApiKey } from './load-key.js'
import { FileKV } from './local-store.js'
import { allBanks, readCategoryRecord } from './resolve-category.js'
import { runGrader } from './run.js'
import { basisOf, cellsFor } from './scan.js'

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

export interface RescoreOptions {
  readonly domains: readonly string[]
  readonly all: boolean
  readonly dataDir: string
  readonly apply: boolean
}

export function parseRescoreArgs(argv: readonly string[]): RescoreOptions | { readonly refuse: string } {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const v = argv[i + 1]?.startsWith('--') === false ? argv[++i]! : 'true'
    args.set(k, v)
  }
  const all = args.has('all')
  const domains = (args.get('domain') ?? '').split(',').map((d) => d.trim()).filter(Boolean)
  if (!all && domains.length === 0) return { refuse: 'pass --domain <host> or --all' }
  return { domains, all, dataDir: args.get('data') ?? join(here, '..', 'data-live'), apply: args.has('apply') }
}

const resultsDir = (dataDir: string) => join(dataDir, 'results')

/** Result files, excluding the `.audit.json` rows nothing serves. */
export function storedResults(dataDir: string): readonly string[] {
  const dir = resultsDir(dataDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.includes('.audit.'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort()
}

/**
 * Where the superseded row goes. Never overwritten: a second re-score under one
 * algorithm gets its own slot rather than erasing the first supersession.
 */
export function auditPathFor(dataDir: string, domain: string, algo: string): string {
  const base = join(resultsDir(dataDir), `${domain}.${algo || 'unversioned'}`)
  if (!existsSync(`${base}.audit.json`)) return `${base}.audit.json`
  for (let n = 2; ; n++) if (!existsSync(`${base}.${n}.audit.json`)) return `${base}.${n}.audit.json`
}

/** The ledger's own cap. See the header: opening with a smaller one lowers it for good. */
function ledgerCap(dataDir: string): number {
  const f = join(dataDir, 'ledger.json')
  if (!existsSync(f)) return DEFAULT_CAP_USD
  try {
    const cap = (JSON.parse(readFileSync(f, 'utf8')) as { capUsd?: unknown }).capUsd
    return typeof cap === 'number' && cap > 0 ? cap : DEFAULT_CAP_USD
  } catch {
    return DEFAULT_CAP_USD
  }
}

interface Plan {
  readonly domain: string
  readonly day: string
  readonly algoVersion: string
  readonly category: string
  /**
   * The COLLECTION run, carried over verbatim. See the write below: a
   * re-derivation is not a run and must not describe itself as one.
   */
  readonly run: Record<string, unknown> | undefined
  /** The prompt count and engine set THIS result was measured over. See `basisOf`. */
  readonly maxPrompts: number
  readonly engines: readonly EngineId[]
  readonly cells: number
  readonly missing: readonly string[]
}


/**
 * What a re-score of this domain would need, and whether the store already has
 * it. Read-only: nothing here can collect, spend or write.
 */
export async function planRescore(dataDir: string, domain: string, fallbackPrompts: number): Promise<Plan | { readonly refuse: string }> {
  const file = join(resultsDir(dataDir), `${domain}.json`)
  if (!existsSync(file)) return { refuse: `no stored result for ${domain}` }

  let stored: { run?: Record<string, unknown>; collectedAt?: string; algoVersion?: string; category?: string; comparisonBasis?: string }
  try {
    stored = JSON.parse(readFileSync(file, 'utf8')) as typeof stored
  } catch {
    return { refuse: `${domain}: stored result is not readable JSON` }
  }

  // The day the ANSWERS were bought. It is part of the cache key, so getting it
  // from wall clock would miss every cell and buy the whole scan again.
  const day = (typeof stored.run?.['day'] === 'string' ? (stored.run['day'] as string) : '') || (stored.collectedAt ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { refuse: `${domain}: no collection day on the stored result` }

  const record = readCategoryRecord(dataDir, domain)
  if (!record) return { refuse: `${domain}: no category record. Re-deriving under a category decided today would rebase what the number measures.` }

  const bank = allBanks(dataDir).find((b) => b.category === record.slug)
  if (!bank) return { refuse: `${domain}: no bank for recorded category ${record.slug}` }

  // The scope this result was MEASURED over, not the scope a scan would use
  // today. See `basisOf`.
  const basis = basisOf(stored.comparisonBasis ?? '')
  const maxPrompts = basis.maxPrompts ?? fallbackPrompts
  const engines = basis.engines ?? ([...ENGINES] as EngineId[])

  const cells = cellsFor(bank, engines, day, maxPrompts)
  const index = new AnswerIndex(new FileKV(join(dataDir, 'index.json')))
  const { hits } = await index.lookup(cells.map((c) => c.cell))
  const missing = cells.filter((c) => !hits.has(c.cell.key)).map((c) => `${c.engine} ${c.prompt.slice(0, 40)}`)

  return {
    domain,
    day,
    algoVersion: stored.algoVersion ?? '',
    category: record.slug,
    ...(stored.run ? { run: stored.run } : { run: undefined }),
    maxPrompts,
    engines,
    cells: cells.length,
    missing,
  }
}

async function main(): Promise<void> {
  const parsed = parseRescoreArgs(process.argv.slice(2))
  if ('refuse' in parsed) {
    process.stderr.write(`refusing: ${parsed.refuse}\n`)
    process.exit(2)
  }
  const o = parsed
  const env = process.env
  const gate = defaultGateConfig(o.dataDir, env)
  const targets = o.all ? storedResults(o.dataDir) : o.domains

  process.stdout.write(
    `rescore · ${targets.length} stored result(s)\n` +
      `  each is re-derived over the prompt count and engine set ITS OWN basis records,\n` +
      `  not today's gate setting (${gate.callsPerEngine} prompts) — a re-score changes the derivation, never the sample.\n` +
      `  every cell is checked against the answer index BEFORE anything runs;\n` +
      `  a single miss refuses the domain rather than buying it.\n\n`,
  )

  const plans: Plan[] = []
  for (const domain of targets) {
    const plan = await planRescore(o.dataDir, domain, gate.callsPerEngine)
    if ('refuse' in plan) {
      process.stdout.write(`  SKIP  ${domain.padEnd(22)} ${plan.refuse}\n`)
      continue
    }
    const state = plan.missing.length === 0 ? 'free' : `${plan.missing.length} MISSING`
    process.stdout.write(
      `  ${state.padEnd(12)} ${plan.domain.padEnd(22)} ${plan.category} · day ${plan.day} · ` +
        `${plan.maxPrompts} prompts x ${plan.engines.length} engines = ${plan.cells} cells · ${plan.algoVersion}\n`,
    )
    for (const m of plan.missing.slice(0, 5)) process.stdout.write(`                 would have to buy: ${m}\n`)
    if (plan.missing.length === 0) plans.push(plan)
  }

  if (!o.apply) {
    process.stdout.write(`\nDRY RUN. Nothing was written. Re-run with --apply to re-derive the ${plans.length} free one(s).\n`)
    return
  }
  if (plans.length === 0) {
    process.stdout.write('\nNothing can be re-derived without buying answers, so nothing ran.\n')
    return
  }

  // Live mode, because a re-derivation must go through the same pipeline that
  // produced the original — the lock, the ledger, the rate budget and the
  // recorded category all included. What makes it free is the check above, not
  // a different code path with weaker guarantees.
  const found = loadApiKey(join(here, '..', '..', '..'), env)
  if (!found) {
    process.stderr.write('refusing: no provider key. A verified-free re-score never calls the provider, but it runs the live path and that path requires one.\n')
    process.exit(2)
  }
  const capUsd = ledgerCap(o.dataDir)

  for (const plan of plans) {
    /*
     * The scratch file goes BESIDE the results directory, not inside it.
     * `results/` is a served store: `/api/scan` reads it by name, `storedResults`
     * lists it, and `scan-result.test.ts` globs every `.json` in it. A crash
     * between `runGrader` writing this file and the `unlinkSync` below would
     * otherwise leave a scratch envelope that all three treat as a result.
     */
    const out = join(o.dataDir, `.rescore.${plan.domain}.tmp.json`)
    const result = await runGrader({
      domain: plan.domain,
      // The recorded scope, both of them. Anything else re-publishes a
      // different measurement under the same file name.
      engines: plan.engines,
      day: plan.day,
      plan: (env['OPENWEBNINJA_PLAN'] as OwnPlan) ?? 'payg',
      mode: 'live',
      apiKey: found.key,
      capUsd,
      maxPrompts: plan.maxPrompts,
      dataDir: o.dataDir,
      outFile: out,
      log: () => {},
    })

    /*
     * ⚠️ THE BELT TO THE PRE-FLIGHT CHECK'S BRACES.
     *
     * The check said every cell was in the store. If a provider call happened
     * anyway, something about that check is wrong and the safe response is to
     * say so loudly and keep the original file — a re-score is never worth
     * discovering a cache-invalidation bug by paying for it.
     */
    if (result.status !== 'scanned' || result.counts.providerCalls > 0) {
      process.stdout.write(
        `\n⚠️ ${plan.domain}: expected a free re-derivation and got status=${result.status}, ` +
          `providerCalls=${'counts' in result ? result.counts.providerCalls : 'n/a'}. The stored result is UNCHANGED.\n`,
      )
      if (existsSync(out)) unlinkSync(out)
      continue
    }

    const live = join(resultsDir(o.dataDir), `${plan.domain}.json`)
    const audit = auditPathFor(o.dataDir, plan.domain, plan.algoVersion)
    copyFileSync(live, audit)

    /*
     * ⚠️ THE ORIGINAL RUN BLOCK IS CARRIED OVER, NOT REPLACED — and this was a
     * real defect, caught by `scan-result.test.ts`.
     *
     * `runGrader` returns a run block describing THIS invocation, and for a
     * verified-free re-derivation that block says `spentUsd: 0`. Which is true
     * about the re-derivation and a lie about the scan: those 85 answers cost
     * real money on 2026-08-25, and a `$0.0000` in the cost slot states that a
     * scan which bought them cost nothing. The repo already had a test for
     * exactly this class of error, written when the runner stamped the ledger's
     * LIFETIME total here — the same field, wrong in the other direction.
     *
     * A re-score changes the NUMBER, not the collection. So `run` keeps
     * describing the collection — day, engines, plan, mode — and the two fields
     * below are the entire record of the re-derivation. A file whose original
     * run block was absent stays absent rather than acquiring a fabricated one.
     *
     * ⚠️ EXCEPT `spentUsd`, WHICH IS DROPPED. Carrying it over failed
     * `scan-result.test.ts` and deserved to. That test's invariant is that a
     * recorded cost must be explicable by the provider calls THIS FILE records,
     * and a re-derivation records zero of them — so a carried-over $0.3470 is a
     * cost the file cannot account for, which is the same defect as the ledger
     * total it was written to catch, only sourced differently.
     *
     * The figure is not lost and it is not guessed: it stays in the superseded
     * row beside this one, next to the counts that explain it. Here it is
     * absent, `runInfoOf` maps absent to null, and every surface already omits
     * a cost line rather than printing `$0.0000` — the behaviour that file's
     * docblock spells out for exactly this case.
     */
    const carried = { ...(plan.run ?? {}) }
    delete carried['spentUsd']
    const envelope = {
      ...result,
      ...(plan.run ? { run: carried } : {}),
      rescoredAt: new Date().toISOString(),
      rescoredFrom: plan.algoVersion,
    }
    if (!plan.run) delete (envelope as { run?: unknown }).run
    writeFileSync(live, JSON.stringify(envelope, null, 2) + '\n')
    unlinkSync(out)

    const subject = result.brands.find((b) => b.isSubject)
    process.stdout.write(
      `\n  ${plan.domain}\n` +
        `    ${result.counts.answersScored} answers re-scored, ${result.counts.providerCalls} provider calls, $0.00\n` +
        `    ${result.promptRows.length} prompt rows · ${result.brands.length} brands · ${result.algoVersion}\n` +
        `    ${subject ? `${subject.name}: ${(subject.metric.value * 100).toFixed(1)}% (was ${plan.algoVersion})` : ''}\n` +
        `    superseded row kept at ${audit}\n` +
        (typeof plan.run?.['spentUsd'] === 'number'
          ? `    the collection's cost ($${(plan.run['spentUsd'] as number).toFixed(4)}) stays in that row; this one records 0 provider calls and so records no cost\n`
          : ''),
    )
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('rescore.ts')) {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`)
    process.exit(1)
  })
}
