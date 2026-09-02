/**
 * `pnpm grader:promote` — propose competitors for a category from answers we
 * already bought, and write them only when a human says so.
 *
 *   pnpm grader:promote -- --category erp-software              # report only
 *   pnpm grader:promote -- --category erp-software --apply      # write it
 *   pnpm grader:promote -- --category erp-software --apply --exclude "Shopify,ERPNext"
 *
 * ⚠️ SPENDS NOTHING, EVER. It reads the answer store off disk and calls no
 * provider and no model (R1, R3). There is no `--live`, no key is loaded, and
 * nothing here can reach the network — so the dry run is genuinely free to run
 * as often as anyone likes, which is the point of making it the default.
 *
 * ⚠️ `--apply` IS A HUMAN ACT AND THE CODE TREATS IT AS ONE.
 *
 * CLAUDE.md §4 puts "the scoring algorithm and its rule set" on the human side
 * of the line, and a competitor set is part of that rule set: it decides
 * `position`, which decides the preview score, and it feeds `trackedBrands`,
 * which decides whether a future authored bank is refused. ADR-0009 Amendment 2
 * also records five leaders whose bare aliases are ordinary English words —
 * `Close` collides with the accounting sense of "monthly close" — so a `tracked`
 * candidate can be a real string match and a nonsense competitor at the same
 * time. No threshold can tell those apart. A person reading the excerpt can.
 *
 * So the report prints, for every candidate: how it was found, the alias that
 * matched, how many answers and prompts and engines, and a quoted excerpt.
 * Nothing is written without `--apply`, and `--apply` prints the same table
 * first.
 */

import { join } from 'node:path'
import { domainBrandForms } from '@bliprank/scorer'
import { squash } from '@bliprank/scorer'
import {
  DEFAULT_THRESHOLDS,
  buildPromotion,
  excludedKeys,
  promotable,
  readCorpus,
  readPromoted,
  tallyCompetitors,
  writePromotion,
  type CompetitorCandidate,
  type PromotionThresholds,
} from './promote-competitors.js'
import { allBanks, recordedIn, trackedBrands } from './resolve-category.js'

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

interface Options {
  readonly category: string
  readonly dataDir: string
  readonly apply: boolean
  /** Names the operator refuses this run. Persisted, so the refusal is not retyped. */
  readonly exclude: readonly string[]
  readonly thresholds: PromotionThresholds
}

export function parsePromoteArgs(argv: readonly string[]): Options | { readonly refuse: string } {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const v = argv[i + 1]?.startsWith('--') === false ? argv[++i]! : 'true'
    args.set(k, v)
  }
  const category = args.get('category')
  if (!category) return { refuse: 'no --category given. Pass the slug, e.g. --category erp-software.' }

  const num = (name: string, fallback: number): number => {
    const raw = args.get(name)
    return raw === undefined ? fallback : Number(raw)
  }
  const thresholds: PromotionThresholds = {
    minAnswers: num('min-answers', DEFAULT_THRESHOLDS.minAnswers),
    minPrompts: num('min-prompts', DEFAULT_THRESHOLDS.minPrompts),
    minEngines: num('min-engines', DEFAULT_THRESHOLDS.minEngines),
  }
  for (const [k, v] of Object.entries(thresholds)) {
    if (!Number.isFinite(v) || v < 1) return { refuse: `--${k} must be a positive integer, got ${String(v)}` }
  }

  return {
    category,
    dataDir: args.get('data') ?? join(here, '..', 'data-live'),
    apply: args.has('apply'),
    /*
     * ⚠️ WHY NOT ALL-OR-NOTHING.
     *
     * The bar is arithmetic and there is a judgement it cannot make: a brand
     * named as a RIVAL and a brand named as an INTEGRATION clear it
     * identically. On the real corpus `Shopify` cleared on "Connect online
     * platforms like Shopify or WooCommerce", and `ERPNext` cleared for a
     * domain that IMPLEMENTS ERPNext. Six good names and two wrong ones is the
     * normal shape of this report, so refusing the batch over the two would
     * mean either taking the wrong ones or taking none.
     *
     * The refusal is written into the store, not just applied to this run, so
     * the next operator does not have to rediscover it. See
     * `PromotedCompetitors.excluded`.
     */
    exclude: (args.get('exclude') ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean),
    thresholds,
  }
}

/**
 * The subject's own brand forms, so a domain is never proposed as its own rival.
 *
 * Read from the category RECORD store rather than re-derived: those are the
 * domains actually placed in this category, and their recorded trading names.
 * Deriving them from anything else would miss a brand whose name is not its
 * domain label — which is the case the whole `domainBrandForms` signal exists
 * for.
 */
function subjectFormsFor(dataDir: string, slug: string): readonly string[] {
  const forms: string[] = []
  for (const record of recordedIn(dataDir, slug)) {
    // The same derivation `subjectFor` uses to build the subject's match
    // aliases, so what promotion excludes is exactly what a scan counts as the
    // subject — not a near-miss of it.
    const derived = domainBrandForms(record.host, record.brandName)
    forms.push(record.host, derived.name, ...derived.aliases, ...(derived.squashedAliases ?? []))
    if (record.brandName) forms.push(record.brandName)
  }
  return forms
}

const line = (c: CompetitorCandidate): string =>
  [
    `  ${c.name.padEnd(28)}`,
    `${String(c.evidence.answers).padStart(3)} answers`,
    `${String(c.evidence.prompts).padStart(2)} prompts`,
    `${String(c.evidence.engines)} engines`,
    `${c.evidence.source.padEnd(9)}`,
    `as "${c.evidence.matchedAs}"`,
  ].join('  ')

async function main(): Promise<void> {
  const parsed = parsePromoteArgs(process.argv.slice(2))
  if ('refuse' in parsed) {
    process.stderr.write(`refusing: ${parsed.refuse}\n`)
    process.exit(2)
  }
  const o = parsed
  const banks = allBanks(o.dataDir)
  const bank = banks.find((b) => b.category === o.category)
  if (!bank) {
    process.stderr.write(`refusing: no bank for category "${o.category}". Known: ${banks.map((b) => b.category).join(', ')}\n`)
    process.exit(2)
  }

  const corpus = readCorpus(join(o.dataDir, 'answers'), bank.prompts.map((p) => p.text))
  process.stdout.write(
    `promote · ${o.category} · ${bank.prompts.length} prompts · ${corpus.length} stored answers\n` +
      `  bar: >=${o.thresholds.minAnswers} answers, >=${o.thresholds.minPrompts} prompts, >=${o.thresholds.minEngines} engines\n` +
      `  reads disk only — no provider call, no model call, nothing charged\n\n`,
  )
  if (corpus.length === 0) {
    process.stdout.write('No stored answers for this bank\'s prompts. Nothing can be promoted from a corpus that does not exist.\n')
    return
  }

  // Every brand the taxonomy already tracks, minus this bank's own — a category
  // cannot promote its own leader into itself.
  const tracked = trackedBrands(banks.filter((b) => b.category !== o.category))
  const candidates = tallyCompetitors(corpus, { tracked, exclude: subjectFormsFor(o.dataDir, o.category) })
  const cleared = promotable(candidates, o.thresholds)
  const below = candidates.filter((c) => !cleared.includes(c))

  // Refusals already on file plus the ones typed this run. Applied to the
  // REPORT as well as to the write, so a dry run shows what --apply would do.
  const held = readPromoted(o.dataDir, o.category)
  const refused = excludedKeys(held, o.exclude)
  const clears = cleared.filter((c) => !refused.has(squash(c.name)))
  const vetoed = cleared.filter((c) => refused.has(squash(c.name)))

  process.stdout.write(`CLEARS THE BAR (${clears.length})\n`)
  for (const c of clears) process.stdout.write(`${line(c)}\n      ${c.evidence.excerpt}\n`)

  if (vetoed.length > 0) {
    // Shown, never silently dropped. A name that clears the arithmetic and is
    // refused anyway is the most interesting line in this report: it is where
    // the counting rule and the market disagree.
    process.stdout.write(`\nCLEARS THE BAR, REFUSED BY A HUMAN (${vetoed.length})\n`)
    for (const c of vetoed) {
      const when = held?.excluded?.find((e) => squash(e.name) === squash(c.name))?.at
      process.stdout.write(`${line(c)}   ${when ? `refused ${when.slice(0, 10)}` : 'refused this run'}\n      ${c.evidence.excerpt}\n`)
    }
  }
  // Printed, not hidden. A silent cut reads as "there was nothing else", and the
  // names just under the bar are exactly the ones a human should see before
  // deciding whether the bar is in the right place.
  process.stdout.write(`\nBELOW THE BAR, NOT PROMOTED (${below.length})\n`)
  for (const c of below.slice(0, 30)) process.stdout.write(`${line(c)}\n`)
  if (below.length > 30) process.stdout.write(`  ... and ${below.length - 30} more\n`)

  if (!o.apply) {
    process.stdout.write(
      `\nDRY RUN. Nothing was written.\n` +
        `Re-run with --apply to promote the ${clears.length} above into ${o.category}.\n` +
        `Refuse one with --exclude "Name,Other Name"; the refusal is stored, not retyped.\n` +
        `⚠️ Read the excerpts first: a match can be a real string and a nonsense competitor at once.\n`,
    )
    return
  }

  if (clears.length === 0 && o.exclude.length === 0) {
    process.stdout.write('\nNothing clears the bar, so --apply writes nothing.\n')
    return
  }

  const promotion = buildPromotion(o.category, clears, {
    bankVersion: bank.version,
    now: new Date().toISOString(),
    ...(held ? { existing: held } : {}),
    ...(o.exclude.length ? { exclude: o.exclude } : {}),
  })
  const path = writePromotion(o.dataDir, promotion)
  process.stdout.write(
    `\nwrote ${path}\n` +
      `  ${promotion.leaders.length} competitors · bank version ${bank.version} -> ${promotion.bankVersion}\n` +
      (promotion.excluded?.length ? `  ${promotion.excluded.length} refused and recorded: ${promotion.excluded.map((e) => e.name).join(', ')}\n` : '') +
      `⚠️ THE VERSION MOVED, SO EVERY EXISTING SCAN OF THIS CATEGORY IS NOW ON A DIFFERENT BASIS.\n` +
      `   compare() will refuse to put an @${bank.version} number beside an @${promotion.bankVersion} one, which is correct:\n` +
      `   the competitor set decides position, so they are not measurements of the same thing.\n` +
      `   Existing results keep their own basis until the domain is re-scanned.\n`,
  )
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('promote.ts')) {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`)
    process.exit(1)
  })
}
