/**
 * PHASES 3.3 — the Grader scan, end to end.
 *
 * domain → category (3.1) → prompt bank (3.2) → collect → score → aggregate →
 * a `Metric` per brand with its Wilson interval. This is the composition layer:
 * it owns no measurement of its own, and every number it returns comes from
 * `packages/stats`, every mention from `services/scorer`, every provider call
 * from `services/collector`.
 *
 * It lives in its own service because it composes four packages. Putting it in
 * `services/collector` would make the collector depend on the scorer and on
 * stats, which inverts what the collector is for.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE PROPERTIES THAT ARE NOT NEGOTIABLE, each asserted in the tests.
 *
 * 1. A DOMAIN THAT DOES NOT CLASSIFY NEVER SPENDS. `classifyDomain` runs first
 *    and an `ambiguous` or `unclassified` result returns before a single cell is
 *    requested. This is the guard the Grader's input regex was wrongly credited
 *    with: junk in the box costs nothing because there is no category, so there
 *    is no bank, so there is no cell.
 *
 * 2. THE HEADLINE IS MEASURED ON UNPROMPTED PROMPTS ONLY — discovery and
 *    problem-led. `comparison` prompts name brands by construction ("HubSpot vs
 *    Salesforce") and `brand-verification` names one on purpose ("is X any
 *    good"), so including either would guarantee mentions and report our own
 *    phrasing back as the brand's visibility. Share of voice has to be
 *    unprompted or it is not share of voice.
 *
 * 3. EVERY BRAND IN THE RESULT SHARES ONE `comparison_basis`. The subject and
 *    every competitor are scored over the SAME answers from the SAME scan, so
 *    `compare()` will actually compare them. A head-to-head assembled from two
 *    scans would be refused by `compare()`, correctly, and silently render as
 *    "not comparable" for every row.
 */

import { cacheCell, type CacheCell, type EngineAdapter, type EngineId, type RawAnswer } from '@bliprank/contracts'
import { SCORING_ALGO_VERSION, scoreAnswer, type BrandSpec } from '@bliprank/scorer'
import { wilson, type Metric } from '@bliprank/stats'
import { DEMO_BANKS, DEMO_TAXONOMY, FALLBACK_SLUG, classifyDomain, looksLikeFilename, normaliseHost, type CategoryDef, type Classification, type PromptBank } from '@bliprank/taxonomy'
import type { BlobStore, CollectionOrchestrator } from '@bliprank/collector'

/** The two groups that name no brand. See property 2 above. */
export const UNPROMPTED_INTENTS = ['discovery', 'problem-led'] as const

export interface ScanRequest {
  readonly domain: string
  readonly engines: readonly EngineId[]
  /** Collection cycle date (UTC), scheduler-assigned — not wall clock (ADR-0003). */
  readonly day: string
  readonly runsPerCell?: number
  /** Cap the prompt count for a cheaper demo run. Omitted = the whole unprompted set. */
  readonly maxPrompts?: number
}

export interface ScanDeps {
  readonly orchestrator: CollectionOrchestrator
  /**
   * Read side of the answer store.
   *
   * The orchestrator returns a POINTER on a cache hit, not the answers — it
   * exists to ensure a cell is collected, and the QStash worker that calls it
   * never needs to read one back. The Grader is the first consumer that does,
   * so it fetches the stored object itself. Without this, a cached scan scores
   * zero answers and reports `no-answers` on a cell it already paid for.
   */
  readonly blob: BlobStore
  readonly adapterFor: (engine: EngineId) => EngineAdapter
  readonly banks?: readonly PromptBank[]
  readonly taxonomy?: readonly CategoryDef[]
  readonly onProgress?: (e: ScanProgress) => void
  readonly signal?: AbortSignal
}

export interface ScanProgress {
  readonly done: number
  readonly total: number
  readonly cell: string
  readonly outcome: string
  readonly providerCalls: number
}

export interface BrandResult {
  readonly id: string
  readonly name: string
  readonly isSubject: boolean
  /** Answers in which any alias appeared. */
  readonly mentions: number
  /** Answers in which one of the brand's own domains was cited. */
  readonly citations: number
  readonly metric: Metric
}

export interface ScanCounts {
  readonly cellsRequested: number
  readonly cacheHits: number
  readonly collected: number
  readonly failed: number
  readonly answersScored: number
  readonly providerCalls: number
}

export type ScanResult =
  | { readonly status: 'ambiguous'; readonly domain: string; readonly classification: Classification; readonly candidates: readonly string[] }
  | { readonly status: 'unclassified'; readonly domain: string; readonly classification: Classification; readonly reason: string }
  | { readonly status: 'no-answers'; readonly domain: string; readonly category: string; readonly counts: ScanCounts }
  | {
      readonly status: 'scanned'
      readonly domain: string
      readonly category: string
      readonly categoryName: string
      readonly classification: Classification
      /**
       * Set when the domain did NOT resolve to a category and the scan ran
       * against the fallback bank instead. Absent on a normal scan.
       *
       * It carries WHY, because "we could not place you" and "you lead three of
       * these at once" are different facts and the page says which. A consumer
       * that ignores this field renders a number whose competitor set is empty
       * without saying why it is empty, so it is not optional to read.
       */
      readonly fallback?: { readonly reason: 'unclassified' | 'ambiguous'; readonly detail: string; readonly candidates: readonly string[] }
      /** How the subject brand was identified — see `subjectFor`. */
      readonly subjectSource: 'leader' | 'domain-label'
      readonly comparisonBasis: string
      readonly algoVersion: string
      readonly collectedAt: string
      readonly counts: ScanCounts
      readonly brands: readonly BrandResult[]
    }

/**
 * Read one cell's stored runs back out of the answer store.
 *
 * Tolerant on purpose: a corrupt or missing object yields no answers rather than
 * throwing, so one bad blob degrades the sample instead of failing the whole
 * scan. The count that reaches the interval is `answers.length`, so a shortfall
 * shows up honestly as a smaller `n` and a wider interval — which is exactly
 * what a partial sample should look like.
 */
async function readStoredAnswers(blob: BlobStore, r2Key: string): Promise<RawAnswer[]> {
  const body = await blob.get(r2Key)
  if (!body) return []
  try {
    const parsed = JSON.parse(body) as { runs?: unknown }
    return Array.isArray(parsed.runs) ? (parsed.runs as RawAnswer[]).filter((r) => typeof r?.text === 'string') : []
  } catch {
    return []
  }
}

const leadersOf = (bank: PromptBank): BrandSpec[] =>
  bank.leaders.map((l) => ({ id: l.id, name: l.name, aliases: [...l.aliases], domains: [...l.domains] }))

/**
 * Who the scan is about.
 *
 * When the domain matched a leader, the subject IS that leader and it carries a
 * reviewed alias set. When it was classified by a keyword — `my-crm.io` — no
 * alias set exists, so one is derived from the domain label. That derivation is
 * weak and is labelled `domain-label` in the result rather than presented as
 * equivalent: a brand whose only alias is its own domain label will be
 * undercounted wherever answers use its real trading name. Recovering that is
 * what PHASES 3.1's unbuilt site-content signal is for.
 */
export function subjectFor(domain: string, bank: PromptBank): { spec: BrandSpec; source: 'leader' | 'domain-label' } {
  const host = domain.toLowerCase().replace(/^www\./, '')
  for (const l of bank.leaders) {
    for (const d of [...l.domains, ...(l.siteDomains ?? [])]) {
      if (host === d || host.endsWith(`.${d}`)) {
        return { spec: { id: l.id, name: l.name, aliases: [...l.aliases], domains: [...l.domains] }, source: 'leader' }
      }
    }
  }
  const label = host.split('.')[0] ?? host
  return { spec: { id: `domain:${host}`, name: label, aliases: [label], domains: [host] }, source: 'domain-label' }
}

/**
 * Everything that must match before two of these numbers may be compared.
 *
 * The prompt subset is in here deliberately. A scan over the unprompted 17 and a
 * scan over all 30 are not measurements of the same thing — the second one
 * includes prompts that name brands — and `compare()` must refuse to put them
 * side by side rather than reporting the difference as movement.
 */
export function comparisonBasisFor(bank: PromptBank, engines: readonly EngineId[], promptCount: number, runsPerCell: number): string {
  return [
    'grader',
    `engines=${[...engines].sort().join(',')}`,
    bank.locale,
    bank.geo,
    `${bank.category}@${bank.version}`,
    `unprompted=${promptCount}`,
    `runs=${runsPerCell}`,
  ].join('|')
}

export async function runScan(req: ScanRequest, deps: ScanDeps): Promise<ScanResult> {
  const banks = deps.banks ?? DEMO_BANKS
  const taxonomy = deps.taxonomy ?? DEMO_TAXONOMY
  const runsPerCell = req.runsPerCell ?? 1

  // PROPERTY 1. Classification first, and it is the spend gate: no category
  // means no bank means no cell means no provider call.
  const classification = classifyDomain(req.domain, banks, taxonomy)

  /*
   * THE FALLBACK, AND WHY IT LIVES HERE RATHER THAN IN THE CLASSIFIER.
   *
   * `classifyDomain` still answers honestly: unclassified is unclassified and
   * ambiguous is ambiguous. What changed is what the CALLER does about it — it
   * scans anyway, against a bank with no leaders, and says so. Keeping the
   * decision at this layer means the classifier's answer is never overwritten by
   * a helpful guess, which is the property ADR-0005 protects when it refuses to
   * bucket an unknown citation as `owned`.
   *
   * Ambiguity is NOT collapsed into ignorance. `zoho.com` leads three of these
   * categories and that is real information; it is carried into `candidates` and
   * the page reports it, rather than being flattened to "we don't know".
   *
   * The cost is honest and structural: the fallback bank has no leaders, so
   * there is no competitor set, so there is no ranking. `comparisonBasisFor`
   * stamps the fallback slug, so `compare()` refuses to put this number beside a
   * category-bank number without anyone having to remember to.
   */
  /*
   * ...BUT A STRING THAT IS NOT A DOMAIN STILL BUYS NOTHING.
   *
   * The fallback exists so a REAL domain we cannot categorise still gets
   * measured. `hello.txt`, `report.pdf` and a half-typed address are not real
   * domains, and falling back for them would turn a typo into a full scan — on
   * a public box, with no confirmation step, against a quota with one scan left
   * in it. That is the opposite of what the fallback is for.
   *
   * Keyed off the host shape rather than off the reason STRING, so a reworded
   * message cannot silently open the path.
   */
  if (classification.status === 'unclassified' && (normaliseHost(req.domain) === '' || looksLikeFilename(req.domain))) {
    const reason = looksLikeFilename(req.domain) ? `${req.domain} looks like a filename, not a domain` : classification.reason
    return { status: 'unclassified', domain: req.domain, classification, reason }
  }

  let fallback: { reason: 'unclassified' | 'ambiguous'; detail: string; candidates: readonly string[] } | undefined
  let slug: string
  if (classification.status === 'classified') {
    slug = classification.slug
  } else {
    slug = FALLBACK_SLUG
    fallback =
      classification.status === 'ambiguous'
        ? { reason: 'ambiguous', detail: classification.evidence, candidates: classification.candidates }
        : { reason: 'unclassified', detail: classification.reason, candidates: [] }
  }

  const bank = banks.find((b) => b.category === slug)
  if (!bank) {
    // A classified slug with no bank is a wiring fault, not a user outcome. It
    // must not fall through to a scan of some other category.
    return { status: 'unclassified', domain: req.domain, classification, reason: `no bank for category ${slug}` }
  }

  // PROPERTY 2. Unprompted prompts only.
  const unprompted = bank.prompts.filter((p) => (UNPROMPTED_INTENTS as readonly string[]).includes(p.intent))
  const prompts = req.maxPrompts ? unprompted.slice(0, req.maxPrompts) : unprompted

  const { spec: subject, source: subjectSource } = subjectFor(req.domain, bank)
  const competitors = leadersOf(bank).filter((c) => c.id !== subject.id)
  const scored: BrandSpec[] = [subject, ...competitors]

  const cells: { cell: CacheCell; prompt: string; engine: EngineId }[] = []
  for (const p of prompts) {
    for (const engine of req.engines) {
      cells.push({ cell: cacheCell({ prompt: p.text, engine, locale: bank.locale, geo: bank.geo, dateBucket: req.day }), prompt: p.text, engine })
    }
  }

  const answers: RawAnswer[] = []
  let cacheHits = 0
  let collected = 0
  let failed = 0
  let providerCalls = 0

  for (const [i, c] of cells.entries()) {
    if (deps.signal?.aborted) break
    const outcome = await deps.orchestrator.collectCell({
      cell: c.cell,
      prompt: c.prompt,
      runs: runsPerCell,
      adapter: deps.adapterFor(c.engine),
      ...(deps.signal ? { signal: deps.signal } : {}),
    })
    providerCalls += outcome.providerCalls
    if (outcome.status === 'cache-hit') cacheHits += 1
    else if (outcome.status === 'collected') collected += 1
    else failed += 1
    if ('answers' in outcome && outcome.answers) {
      answers.push(...outcome.answers)
    } else if (outcome.status === 'cache-hit') {
      answers.push(...(await readStoredAnswers(deps.blob, outcome.entry.r2Key)))
    }
    deps.onProgress?.({ done: i + 1, total: cells.length, cell: `${c.engine} ${c.prompt.slice(0, 48)}`, outcome: outcome.status, providerCalls: outcome.providerCalls })
    // A budget stop is a stop. Continuing would charge every remaining cell
    // against a ledger that has already refused, one BudgetExceeded at a time.
    if (outcome.status === 'budget-exhausted' || outcome.status === 'aborted') break
  }

  const counts: ScanCounts = {
    cellsRequested: cells.length,
    cacheHits,
    collected,
    failed,
    answersScored: answers.length,
    providerCalls,
  }

  if (answers.length === 0) {
    // No interval is defensible over zero answers, and `wilson(0, 0)` throws
    // rather than returning a shrug. Say so instead of rendering an empty chart.
    return { status: 'no-answers', domain: req.domain, category: bank.category, counts }
  }

  // PROPERTY 3. One basis for every brand, because every brand is scored over
  // the same answers from the same scan.
  const comparisonBasis = comparisonBasisFor(bank, req.engines, prompts.length, runsPerCell)
  const n = answers.length

  const brands: BrandResult[] = scored.map((spec) => {
    let mentions = 0
    let citations = 0
    for (const a of answers) {
      // Scored once per brand rather than reading the competitor sub-shape:
      // `mentioned` is all this needs, the pass is pure string matching, and
      // making each brand its own subject keeps the numerator unambiguous.
      const row = scoreAnswer({ answer: { text: a.text, citations: a.citations }, brand: spec, competitors })
      if (row.mentioned) mentions += 1
      if (row.cited) citations += 1
    }
    const w = wilson(mentions, n)
    return {
      id: spec.id,
      name: spec.name,
      isSubject: spec.id === subject.id,
      mentions,
      citations,
      metric: {
        value: w.value,
        ci_low: w.ci_low,
        ci_high: w.ci_high,
        n: w.n,
        algo_version: SCORING_ALGO_VERSION,
        collection_path: 'third-party-grounded',
        comparison_basis: comparisonBasis,
      },
    }
  })

  return {
    status: 'scanned',
    domain: req.domain,
    category: bank.category,
    categoryName: bank.displayName,
    classification,
    // Spread, not `fallback,`: the field is optional and R8's no-optional-fields
    // discipline is about METRICS, but exactOptionalPropertyTypes still refuses
    // an explicit `undefined` here. A normal scan carries no key at all.
    ...(fallback ? { fallback } : {}),
    subjectSource,
    comparisonBasis,
    algoVersion: SCORING_ALGO_VERSION,
    collectedAt: answers[answers.length - 1]?.collectedAt ?? req.day,
    counts,
    brands,
  }
}
