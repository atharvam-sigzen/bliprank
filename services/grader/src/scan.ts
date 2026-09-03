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

import { ENGINES as ENGINE_IDS, cacheCell, type CacheCell, type EngineAdapter, type EngineId, type RawAnswer, formatBasis, parseBasis } from '@bliprank/contracts'
import { SCORING_ALGO_VERSION, domainBrandForms, scoreAnswer, type BrandSpec } from '@bliprank/scorer'
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
  /**
   * The richer classifier, injected.
   *
   * `classifyDomain` reads five tokens of a hostname and nothing else, so it
   * returns `unclassified` for most real businesses — `nike.com` and
   * `sigzen.com` carry nothing in their host. `resolve-category.ts` adds the
   * signals that need IO: the site's own homepage, and, when the taxonomy has no
   * home for the business at all, an authored bank. Both are side effects, so
   * they arrive here as a dependency rather than as an import (CLAUDE.md §8).
   *
   * PROPERTY 1 IS UNCHANGED AND STILL FIRST. This is consulted only AFTER the
   * host-shape guard below has refused a pasted filename, so junk in the box
   * still buys nothing — not a scan, and now also not an outbound fetch.
   *
   * Absent, everything behaves exactly as it did: `classifyDomain`, then the
   * fallback bank. The CLI without a data dir and every existing test take that
   * path.
   */
  readonly resolveCategory?: (domain: string) => Promise<CategoryResolution>
  readonly onProgress?: (e: ScanProgress) => void
  readonly signal?: AbortSignal
}

/**
 * What a resolver hands back: a slug, the bank for it, and how it was decided.
 *
 * Declared here rather than imported from `resolve-category.ts` so the
 * dependency points one way — this module composes, it does not know that a
 * category can be written to a file.
 */
export interface CategoryResolution {
  readonly slug: string
  readonly bank: PromptBank
  /** `leader-domain` | `domain-token` | `site-content` | `generated` | `fallback`. */
  readonly signal: string
  readonly evidence: string
  /** The recorded trading name, when the decision has one. See `subjectFor`. */
  readonly brandName?: string
  readonly fallback?: { readonly reason: 'unclassified' | 'ambiguous'; readonly detail: string; readonly candidates: readonly string[] }
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

/**
 * ONE SCORED ANSWER, AS THE SUBJECT SAW IT — PHASES 3.3, added 2026-09-02.
 *
 * ⚠️ NOTHING HERE IS A NEW MEASUREMENT. Every field below is already computed,
 * for every answer, by the `scoreAnswer` call in the brand loop below — and was
 * then summed into `mentions`/`citations` and thrown away. The result carried
 * one rate over fifty answers and no way to see which prompt or which engine
 * produced it, so the workspace record said in prose that "the per-engine split
 * is not in this cycle's stored payload". It was in the pipeline; it was not in
 * the payload. This is the payload. No extra scoring pass, no extra provider
 * call, no model call — the same `ScoreRow`, kept instead of discarded.
 *
 * THE ATOM IS ONE ANSWER, NOT ONE PROMPT. A cell is `prompt x engine x day` and
 * `runsPerCell` may be greater than one, so two rows can legitimately share a
 * prompt and an engine. Aggregating up to a prompt is the reader's job
 * (`lib/prompt-breakdown.ts`), because a surface that has to divide can also be
 * asked what it divided — which is the failure the by-engine table was refused
 * for in the first place.
 *
 * ⚠️ NO SENTIMENT FIELD, AND THAT IS NOT AN OVERSIGHT. Sentiment is the one
 * signal R1 permits a model to produce, on a 25% sample, and PHASES 2.3 has not
 * been built. No stored answer carries one. An optional field that is always
 * absent would read on the sheet as "we could not tell for this answer", which
 * is a different claim from "this build does not collect it" — and the second is
 * the true one. The surfaces say the second, in words, once.
 */
export interface PromptRow {
  /** The prompt as SENT, not the normalised cache-key form. */
  readonly prompt: string
  readonly engine: EngineId
  readonly mentioned: boolean
  /** Times an alias appeared in this answer. 0 when not mentioned. */
  readonly mentionCount: number
  /** Rank by first appearance among every brand detected, 1-based. null when absent. */
  readonly position: number | null
  /** How many brands the scorer found in this answer at all — the denominator of `position`. */
  readonly brandsDetected: number
  /** One of the subject's own domains was cited in this answer. */
  readonly cited: boolean
  /** TRACKED competitors named in this answer. Empty for a bank with no leaders. */
  readonly competitorsMentioned: readonly string[]
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
      /**
       * Which signal decided the category, and what it matched.
       *
       * On the sheet, not in a log. "CRM software" means one thing when the host
       * IS Pipedrive and another when a model authored the category from the
       * homepage twenty seconds ago, and a reader is entitled to know which —
       * the same provenance discipline R8 applies to every number.
       *
       * Absent on a scan run without a resolver, where the only possible answers
       * are the two `classifyDomain` gives and `classification` already says so.
       */
      readonly categorySource?: { readonly signal: string; readonly evidence: string }
      /** How the subject brand was identified — see `subjectFor`. */
      readonly subjectSource: 'leader' | 'domain-label'
      readonly comparisonBasis: string
      readonly algoVersion: string
      readonly collectedAt: string
      readonly counts: ScanCounts
      readonly brands: readonly BrandResult[]
      /**
       * Per-answer detail for the SUBJECT, one row per scored answer.
       *
       * Present on every scan this version runs. Absent on a result file written
       * before it existed — and a surface must read that absence as "this file
       * does not carry the split", never as "the subject was mentioned nowhere".
       * Those are opposite claims and only one of them is in the file.
       */
      readonly promptRows: readonly PromptRow[]
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

export const leadersOf = (bank: PromptBank): BrandSpec[] =>
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
export function subjectFor(domain: string, bank: PromptBank, siteTitle?: string): { spec: BrandSpec; source: 'leader' | 'domain-label' } {
  const host = domain.toLowerCase().replace(/^www\./, '')
  for (const l of bank.leaders) {
    for (const d of [...l.domains, ...(l.siteDomains ?? [])]) {
      if (host === d || host.endsWith(`.${d}`)) {
        return { spec: { id: l.id, name: l.name, aliases: [...l.aliases], domains: [...l.domains] }, source: 'leader' }
      }
    }
  }
  /*
   * ⚠️ THE FALSE ZERO, FIXED HERE — 2026-09-01, algo det-2.
   *
   * This returned `aliases: [label]` and nothing else, so `thecosmicbyte.com`
   * searched every answer for `thecosmicbyte` while all five engines wrote
   * "Cosmic Byte". The scan published 0 of 50 for a brand named 139 times
   * across 31 of those answers. The docblock above had predicted exactly this
   * and pointed at a signal that did not exist yet; it does now.
   *
   * `siteTitle` is the recorded one, never a fresh fetch. A re-scan reads the
   * decision rather than re-reading the homepage, and a homepage rewritten on a
   * Tuesday must not silently change what a historical number was measuring —
   * the same reasoning that makes the category itself a written-down answer.
   */
  const forms = domainBrandForms(host, siteTitle)
  return {
    spec: { id: `domain:${host}`, name: forms.name, aliases: forms.aliases, squashedAliases: forms.squashedAliases, domains: [host] },
    source: 'domain-label',
  }
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
  // The shape lives in @bliprank/contracts (ADR-0016), shared with the reader
  // that explains a refused comparison, so the two cannot drift.
  return formatBasis({
    format: 'grader',
    engines,
    locale: bank.locale,
    geo: bank.geo,
    bank: { slug: bank.category, version: bank.version },
    unprompted: promptCount,
    runs: runsPerCell,
  })
}

/**
 * The unprompted prompts a scan would send, in the order it would send them.
 *
 * Extracted so a caller can ask what a scan WOULD collect without collecting
 * it. `rescore.ts` uses it to prove, before anything runs, that every cell is
 * already in the answer store — which is what makes a re-derivation provably
 * free rather than hopefully free.
 */
export function promptsFor(bank: PromptBank, maxPrompts?: number): readonly PromptBank['prompts'][number][] {
  const unprompted = bank.prompts.filter((p) => (UNPROMPTED_INTENTS as readonly string[]).includes(p.intent))
  return maxPrompts ? unprompted.slice(0, maxPrompts) : unprompted
}

/**
 * Every cell one scan of this bank covers: prompt x engine, on one day.
 *
 * ⚠️ ONE DEFINITION, TWO CALLERS. `runScan` builds its cells from this, and so
 * does the pre-flight check in `rescore.ts`. A second copy of this loop would
 * be a second answer to "which cells does a scan of this bank need", and the
 * two would drift in the direction where the check passes and the scan then
 * misses — which is the direction that spends money.
 */
export function cellsFor(
  bank: PromptBank,
  engines: readonly EngineId[],
  day: string,
  maxPrompts?: number,
): readonly { readonly cell: CacheCell; readonly prompt: string; readonly engine: EngineId }[] {
  const out: { cell: CacheCell; prompt: string; engine: EngineId }[] = []
  for (const p of promptsFor(bank, maxPrompts)) {
    for (const engine of engines) {
      out.push({ cell: cacheCell({ prompt: p.text, engine, locale: bank.locale, geo: bank.geo, dateBucket: day }), prompt: p.text, engine })
    }
  }
  return out
}

/**
 * The inverse of `comparisonBasisFor`: the scope a stored measurement was taken
 * over, read back off its own basis string.
 *
 * ⚠️ IT LIVES BESIDE THE FUNCTION THAT WRITES THE STRING, deliberately. One
 * function builds `engines=...|unprompted=N` and one takes it apart, and a
 * parser that drifts from its writer silently recovers the wrong scope — which
 * on the re-score path means republishing an 85-answer measurement as a
 * 50-answer one, and on the evidence path means showing a reader answers from a
 * scan other than the one they are looking at.
 *
 * Absent or malformed yields nothing and the caller supplies its own default. A
 * file that never recorded its scope cannot have it recovered, and guessing
 * narrow is as wrong as guessing wide.
 */
export function basisOf(comparisonBasis: string): { readonly maxPrompts?: number; readonly engines?: readonly EngineId[] } {
  const b = parseBasis(comparisonBasis ?? '')
  // A string the shared definition cannot parse is read by key, as this
  // function always did: a file that recorded its scope in a partial or older
  // form still gets the segments it did record, and nothing it did not.
  const parts = (comparisonBasis ?? '').split('|')
  const prompts = b ? b.unprompted : Number(parts.find((p) => p.startsWith('unprompted='))?.slice('unprompted='.length))
  const engineList = (b ? b.engines : parts.find((p) => p.startsWith('engines='))?.slice('engines='.length).split(',') ?? []).filter((e): e is EngineId =>
    (ENGINE_IDS as readonly string[]).includes(e),
  )
  return {
    ...(Number.isInteger(prompts) && prompts > 0 ? { maxPrompts: prompts } : {}),
    ...(engineList.length > 0 ? { engines: engineList } : {}),
  }
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

  /*
   * THE RESOLVER, IF ONE WAS GIVEN, AND ONLY NOW.
   *
   * Every refusal above has already run: a string that is not a domain, and a
   * pasted filename, are both gone before this line. So the resolver's outbound
   * fetch is only ever made for something host-shaped — junk in the box still
   * costs nothing, which was the whole of PROPERTY 1 and remains so.
   *
   * It supersedes `classifyDomain` rather than supplementing it, because it
   * already RAN `classifyDomain` as its first two rungs and then consulted
   * signals this module cannot reach. Two answers about one domain is the state
   * to avoid; `classification` is still returned unchanged, so what the free
   * signal thought is never lost.
   */
  let fallback: { reason: 'unclassified' | 'ambiguous'; detail: string; candidates: readonly string[] } | undefined
  let slug: string
  let bank: PromptBank | undefined
  let categorySource: { signal: string; evidence: string } | undefined
  // The RECORDED trading name, never a fresh read of the site. See `subjectFor`.
  let brandName: string | undefined

  if (deps.resolveCategory) {
    const resolved = await deps.resolveCategory(req.domain)
    slug = resolved.slug
    bank = resolved.bank
    brandName = resolved.brandName
    categorySource = { signal: resolved.signal, evidence: resolved.evidence }
    if (resolved.fallback) fallback = resolved.fallback
  } else if (classification.status === 'classified') {
    slug = classification.slug
  } else {
    slug = FALLBACK_SLUG
    fallback =
      classification.status === 'ambiguous'
        ? { reason: 'ambiguous', detail: classification.evidence, candidates: classification.candidates }
        : { reason: 'unclassified', detail: classification.reason, candidates: [] }
  }

  // The resolver hands its own bank over, because a generated one is not in
  // `banks` — it was authored during this call. Anything else is looked up.
  bank ??= banks.find((b) => b.category === slug)
  if (!bank) {
    // A classified slug with no bank is a wiring fault, not a user outcome. It
    // must not fall through to a scan of some other category.
    return { status: 'unclassified', domain: req.domain, classification, reason: `no bank for category ${slug}` }
  }

  // PROPERTY 2. Unprompted prompts only.
  const prompts = promptsFor(bank, req.maxPrompts)

  const { spec: subject, source: subjectSource } = subjectFor(req.domain, bank, brandName)
  const competitors = leadersOf(bank).filter((c) => c.id !== subject.id)
  const scored: BrandSpec[] = [subject, ...competitors]

  const cells = cellsFor(bank, req.engines, req.day, req.maxPrompts)

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

  /*
   * The subject's per-answer rows, harvested from the pass that was already
   * running. See `PromptRow`: this costs one push per answer and buys the
   * per-prompt and per-engine views the record previously had to refuse.
   */
  const promptRows: PromptRow[] = []

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
      if (spec.id === subject.id) {
        promptRows.push({
          // The prompt as SENT. `cell.normalisedPrompt` is the cache key's
          // lowercased form and putting that on a sheet would show the reader a
          // question we did not ask.
          prompt: a.prompt || a.cell.normalisedPrompt,
          engine: a.cell.engine,
          mentioned: row.mentioned,
          mentionCount: row.mentionCount,
          position: row.position,
          brandsDetected: row.brandsDetected,
          cited: row.cited,
          competitorsMentioned: row.competitorsMentioned,
        })
      }
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
    ...(categorySource ? { categorySource } : {}),
    subjectSource,
    comparisonBasis,
    algoVersion: SCORING_ALGO_VERSION,
    collectedAt: answers[answers.length - 1]?.collectedAt ?? req.day,
    counts,
    brands,
    promptRows,
  }
}
