/**
 * Golden-set worklist: which stored answers become golden cases, and what a
 * case looks like before anybody has labelled it. MVP_PLAN E4, goal point 9.
 *
 * PURE. No file, no clock, no network. The reader that turns a data directory
 * into `CorpusAnswer`s is `golden-worklist-cli.ts`; this module only decides.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ THE INTEGRITY LINE OF THE WHOLE ROW: NOTHING HERE CALLS THE SCORER.
 *
 * A golden label is what a reader says is in the answer. If the worklist ran
 * `scoreAnswer` (or read a stored score row) while building a case, the
 * scorer's opinion would be one import away from the label it is later judged
 * against, and agreement would measure nothing. So this module imports TYPES
 * from the scorer and no function, the case it emits has no `label`, and
 * `golden-worklist.test.ts` asserts both.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STRATIFIED BY ENGINE × CATEGORY, EQUAL ALLOCATION, WATER-FILLED.
 *
 * The set exists to catch the scorer being wrong in some dialect: a surface's
 * citation format, a category's brand names. Proportional allocation would
 * hand most of the set to whichever stratum the corpus happens to be fattest
 * in. Equal allocation gives every engine × category stratum the same quota; a
 * stratum smaller than its quota is taken whole and its unused share is
 * re-divided among the rest (water-filling), so the target is met whenever the
 * corpus can meet it. The consequence, stated rather than hidden: agreement
 * over the set is NOT a corpus-weighted estimate. It is a coverage sample.
 *
 * DETERMINISTIC WITHOUT A GENERATOR. Within a stratum, answers are ordered by
 * `sha256(seed | case key)` and the first k are taken. That is a seeded random
 * order with no generator state, so it does not depend on the order the corpus
 * was read in, and a corpus that grows changes the selection only where a new
 * answer's hash lands inside a quota. The seed is recorded in the manifest.
 */

import { createHash } from 'node:crypto'
import type { AnswerBody } from '@bliprank/contracts'
import type { GoldenCase } from './golden.js'
import type { BrandSpec } from './score.js'

/** The seed of the E4 worklist. Changing it changes which answers are selected; it is recorded in every manifest. */
export const WORKLIST_SEED = 'bliprank-golden-e4-2026-09-19'

/** One stored answer with everything the scan that produced its cycle scored it with. */
export interface CorpusAnswer {
  readonly domain: string
  readonly category: string
  /** The cycle's UTC day: the cache key's date bucket. */
  readonly day: string
  readonly engine: string
  /** The question as the scan sent it. */
  readonly prompt: string
  readonly comparisonBasis: string
  /** The cache cell the answer is stored under, the adapter that fetched it, and the run within the cell. */
  readonly cell: { readonly key: string; readonly adapter: string; readonly run: number }
  readonly collectedAt: string
  /** `{ text, citations[] }` exactly as stored. */
  readonly answer: AnswerBody
  /** The subject's spec as the cycle's scan derived it. */
  readonly brand: BrandSpec
  /** The competitor set the cycle was measured against, subject excluded. */
  readonly competitors: readonly BrandSpec[]
  /** The publisher registry the scan classified citations with. */
  readonly publishers: Readonly<Record<string, string>>
}

/** A golden case before it has a label. Never valid in `golden/answers/`: the validator requires a label. */
export type WorklistCase = Omit<GoldenCase, 'label'>

export interface Exclusion {
  readonly key: string
  readonly engine: string
  readonly domain: string
  readonly prompt: string
  readonly reason: string
}

export interface StratumCount {
  readonly stratum: string
  readonly available: number
  readonly selected: number
}

export interface Selection {
  readonly seed: string
  readonly target: number
  readonly selected: readonly CorpusAnswer[]
  readonly excluded: readonly Exclusion[]
  readonly strata: readonly StratumCount[]
}

/** One answer, scored for one subject: the identity of a golden case. Two domains sharing a cell are two cases. */
export const caseKey = (a: Pick<CorpusAnswer, 'domain' | 'cell'>): string => `${a.domain}|${a.cell.key}|${a.cell.run}`

export const stratumOf = (a: Pick<CorpusAnswer, 'engine' | 'category'>): string => `${a.engine}|${a.category}`

/** The seeded order: smaller sorts first. Pure function of the seed and the key. */
export const rankOf = (seed: string, key: string): string => createHash('sha256').update(`${seed}|${key}`).digest('hex')

/**
 * Anything in an answer that must not go into a public repository: a
 * credential, an email address, a phone number. The repository is public and
 * the cases are engine answers about public brands, so a hit is rare; when
 * there is one the case is LEFT OUT and named, never redacted, because a
 * redacted answer is no longer the answer the scorer scored.
 *
 * Deliberately broad on emails (any address, not only ones that look
 * personal: the tool cannot tell) and deliberately narrow on phone numbers
 * (answers about keyboards and ERP pricing are full of digit runs: prices,
 * years, polling rates, model numbers). A phone number here is an explicit
 * international prefix, a parenthesised area code, or a labelled number.
 */
export function sensitiveFindings(text: string): string[] {
  const out: string[] = []
  const add = (what: string, m: RegExpMatchArray | null) => {
    if (m) out.push(`${what}: ${m[0].slice(0, 40)}`)
  }
  add('email address', text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/))
  add('phone number', text.match(/(?<![\w.])\+\d{1,3}[\s.-]?\(?\d{2,5}\)?(?:[\s.-]?\d{2,5}){1,4}(?!\w)/))
  add('phone number', text.match(/(?<![\w.])\(\d{3,5}\)[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?!\w)/))
  add('phone number', text.match(/\b(?:tel|phone|call|whatsapp|mobile|contact)\b[^\n]{0,20}?(?<![\w.])\d{3,5}[\s.-]\d{3,4}[\s.-]?\d{3,4}(?!\w)/i))
  add('credential', text.match(/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)[-_][A-Za-z0-9_-]{16,}/))
  add('credential', text.match(/\bAKIA[0-9A-Z]{16}\b/))
  add('credential', text.match(/\bgh[pousr]_[A-Za-z0-9]{30,}\b/))
  add('credential', text.match(/\bxox[abprs]-[A-Za-z0-9-]{10,}/))
  add('credential', text.match(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/))
  add('credential', text.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----/))
  add('credential', text.match(/\b(?:api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-/+]{12,}/i))
  return out
}

/** Every string of an answer a reader of the repository would see: the text, and each citation's url, title and metadata. */
function publishedStrings(answer: AnswerBody): string {
  const parts: string[] = [answer.text]
  for (const c of answer.citations) {
    parts.push(c.url)
    const rest = c as unknown as Record<string, unknown>
    if (typeof rest['title'] === 'string') parts.push(rest['title'])
    const meta = rest['meta']
    if (meta && typeof meta === 'object') for (const v of Object.values(meta as Record<string, unknown>)) if (typeof v === 'string') parts.push(v)
  }
  return parts.join('\n')
}

/** Adapters whose text is synthetic. A fixture answer is a test double, not something an engine said. */
export const isFixtureAdapter = (adapter: string): boolean => /^(fixture|stub)\b/i.test(adapter)

/**
 * Choose up to `target` answers, stratified by engine × category.
 *
 * Left out, each with its reason: an answer a fixture adapter produced, and an
 * answer whose published strings trip `sensitiveFindings`. An EMPTY answer is
 * kept: the scan counted it in its denominator, so the set must hold it.
 */
export function selectWorklist(corpus: readonly CorpusAnswer[], opts: { readonly target: number; readonly seed?: string }): Selection {
  const seed = opts.seed ?? WORKLIST_SEED
  if (!Number.isInteger(opts.target) || opts.target < 1) throw new RangeError(`selectWorklist: target must be a positive integer, got ${opts.target}`)

  const excluded: Exclusion[] = []
  const eligible = new Map<string, CorpusAnswer>()
  // Sorted by key first, so a duplicate is resolved the same way whatever order the corpus arrived in.
  for (const a of [...corpus].sort((x, y) => (caseKey(x) < caseKey(y) ? -1 : caseKey(x) > caseKey(y) ? 1 : 0))) {
    const key = caseKey(a)
    const leave = (reason: string) => excluded.push({ key, engine: a.engine, domain: a.domain, prompt: a.prompt, reason })
    if (eligible.has(key)) continue
    if (isFixtureAdapter(a.cell.adapter)) {
      leave(`fixture adapter (${a.cell.adapter}): synthetic text, not an engine's answer`)
      continue
    }
    const sensitive = sensitiveFindings(publishedStrings(a.answer))
    if (sensitive.length > 0) {
      leave(`left out of a public repository: ${sensitive.join('; ')}`)
      continue
    }
    eligible.set(key, a)
  }

  const byStratum = new Map<string, CorpusAnswer[]>()
  for (const a of eligible.values()) {
    const s = stratumOf(a)
    byStratum.set(s, [...(byStratum.get(s) ?? []), a])
  }
  for (const list of byStratum.values()) list.sort((x, y) => (rankOf(seed, caseKey(x)) < rankOf(seed, caseKey(y)) ? -1 : 1))

  // Water-filling: smallest stratum first, each taking min(size, an equal share of what is left).
  const names = [...byStratum.keys()].sort((x, y) => byStratum.get(x)!.length - byStratum.get(y)!.length || (x < y ? -1 : 1))
  const take = new Map<string, number>()
  let remaining = opts.target
  names.forEach((name, i) => {
    const share = Math.floor(remaining / (names.length - i))
    const n = Math.min(byStratum.get(name)!.length, share)
    take.set(name, n)
    remaining -= n
  })
  /*
   * No second pass is needed, and the first build's was dead code (E4 review,
   * N4). Once a stratum takes its share rather than its whole (share < size),
   * every later stratum is at least as big, and each later share is that share
   * or one more, so none of them is capped either; the last one's share is
   * everything left. So after the pass either nothing remains, or every stratum
   * was taken whole and the corpus is simply smaller than the target. A
   * property test holds the consequence: selected = min(target, eligible).
   */

  const selected = [...names].sort().flatMap((name) => byStratum.get(name)!.slice(0, take.get(name)!))
  return {
    seed,
    target: opts.target,
    selected,
    excluded,
    strata: [...names].sort().map((name) => ({ stratum: name, available: byStratum.get(name)!.length, selected: take.get(name)! })),
  }
}

// ── ids ──────────────────────────────────────────────────────────────────────

const ENGINE_CODES: Readonly<Record<string, string>> = {
  chatgpt: 'gpt',
  copilot: 'cop',
  gemini: 'gem',
  'google-ai-mode': 'aim',
  'google-ai-overviews': 'aio',
}

const STOP = new Set(['a', 'an', 'the', 'for', 'of', 'to', 'in', 'on', 'and', 'or', 'with', 'that', 'is', 'are', 'do', 'we', 'our', 'how', 'what', 'which', 'it', 'as', 'at', 'by', 'has', 'have', 'i', 'my', 'be', 'so', 'out', 'up', 'into', 'from'])

/** `chatgpt` + `pipedrive.com` + the question → `gpt-pipedrive-best-crm-solo-founder`. Lowercase ASCII, hyphens. */
export function caseSlug(a: Pick<CorpusAnswer, 'engine' | 'domain' | 'prompt'>): string {
  const engine = ENGINE_CODES[a.engine] ?? a.engine.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()
  const host = (a.domain.toLowerCase().replace(/^www\./, '').split('.')[0] ?? '').replace(/[^a-z0-9]/g, '')
  const words = a.prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .slice(0, 4)
  return [engine, host, ...words].filter(Boolean).join('-').slice(0, 60).replace(/-+$/, '')
}

/**
 * Give every selected answer its id. "Stable forever" (golden/README.md): an
 * answer that already has a case keeps that case's id, and only a new answer
 * takes the next free number, so re-running the tool over a grown corpus never
 * renumbers a case somebody has already discussed by id.
 */
export function assignIds(selected: readonly CorpusAnswer[], existing: readonly { readonly id: string; readonly key?: string }[]): ReadonlyMap<string, string> {
  const byKey = new Map(existing.filter((e) => e.key).map((e) => [e.key!, e.id]))
  let next = existing.reduce((n, e) => Math.max(n, Number(/^g(\d+)-/.exec(e.id)?.[1] ?? 0)), 0) + 1
  const out = new Map<string, string>()
  // Numbered in a reader's order: category, domain, the question, then engine.
  const ordered = [...selected].sort((x, y) => {
    const kx = JSON.stringify([x.category, x.domain, x.prompt, x.engine, x.cell.run])
    const ky = JSON.stringify([y.category, y.domain, y.prompt, y.engine, y.cell.run])
    return kx < ky ? -1 : kx > ky ? 1 : 0
  })
  for (const a of ordered) {
    const key = caseKey(a)
    out.set(key, byKey.get(key) ?? `g${String(next++).padStart(3, '0')}-${caseSlug(a)}`)
  }
  return out
}

// ── the case ─────────────────────────────────────────────────────────────────

/**
 * What the tool can say a case covers WITHOUT reading it: structure only.
 *
 * The README wants `covers` to name the edge a case pins. A stratified sample
 * of real answers is not chosen for an edge, and saying it was would be the
 * set lying about itself. So: the structural edges that are true of the stored
 * object are named, and a case with none says so in as many words. The
 * labeller, who does read the answer, may add the edge they saw
 * (`withLabel` appends it); the tool never guesses at content.
 */
export function structuralCovers(a: CorpusAnswer): string {
  const edges: string[] = []
  if (a.answer.text.trim() === '') edges.push('empty answer: the engine returned no text, which the scan still counts in its denominator')
  if (a.answer.citations.length === 0 && a.answer.text.trim() !== '') edges.push('engine emitted no citations')
  const metaKeys = [...new Set(a.answer.citations.flatMap((c) => Object.keys((c as { meta?: Record<string, unknown> }).meta ?? {})))].sort()
  if (metaKeys.length > 0) edges.push(`citation metadata in ${a.engine}'s own dialect (${metaKeys.join(', ')})`)
  if ((a.brand.squashedAliases ?? []).length > 0) edges.push('domain-label subject matched separator-insensitively')
  if (/^\s*\|.*\|\s*$/m.test(a.answer.text)) edges.push('answer contains a table')
  const base = `real ${a.engine} answer, ${a.category}, from the stratified worklist`
  return edges.length > 0 ? `${base}: ${edges.join('; ')}` : `${base}: pins no particular edge, it is here as a sample of what the scorer actually scores`
}

/** The case file for one selected answer, unlabelled. Key order follows the seed cases. */
export function toWorklistCase(a: CorpusAnswer, id: string): WorklistCase {
  return {
    id,
    covers: structuralCovers(a),
    source: {
      engine: a.engine,
      collectedAt: a.collectedAt,
      domain: a.domain,
      category: a.category,
      day: a.day,
      prompt: a.prompt,
      cell: { key: a.cell.key, adapter: a.cell.adapter, run: a.cell.run },
      comparisonBasis: a.comparisonBasis,
      note: 'real collected answer; brand, competitors and publishers are the specs the cycle was scored with',
    },
    brand: a.brand,
    competitors: a.competitors,
    publishers: a.publishers,
    answer: a.answer,
  }
}
