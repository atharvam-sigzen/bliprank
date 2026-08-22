/**
 * Deterministic scorer — PHASES.md 2.1, rule R1.
 *
 * Mention, citation, position and competitor detection from alias tables and
 * string/URL matching. **No model call on this path, ever.** Two reasons, and
 * they point the same way: an LLM on every answer costs 10.5x more, and it makes
 * the number non-reproducible, which is the product. Only sentiment/framing may
 * call a model, on a 25% sample, and that lives elsewhere (2.3).
 *
 * Everything here is pure. Same answer plus same brand set always produces the
 * same row, which is what rule R5 (immutable, version-stamped score rows)
 * assumes: if scoring were not a function of its inputs, re-deriving a
 * historical row would not reproduce it and the audit claim would be empty.
 */

import type { AnswerBody, CollectionPath } from '@bliprank/contracts'
import { classifyCitations, type ClassifiedCitation, type ClassifierRegistry } from './classify-source.js'
import { isOnDomain } from './domain.js'

/**
 * Bumped whenever a rule changes what an existing answer would score (R5).
 * Never mutate historical rows: bump, re-score forward, changelog the diff.
 */
export const SCORING_ALGO_VERSION = 'det-1'

export interface BrandSpec {
  readonly id: string
  readonly name: string
  /**
   * Surface forms to match, including the name. Matching is case-insensitive
   * and whole-token, so an alias must be a form a human would actually write:
   * 'HubSpot', 'Hub Spot', 'hubspot crm'. Not a substring fragment.
   */
  readonly aliases: readonly string[]
  /** Domains the brand owns, for citation detection. Subdomains count. */
  readonly domains: readonly string[]
}

export interface ScoreInput {
  readonly answer: AnswerBody
  /** The brand being reported on. */
  readonly brand: BrandSpec
  /** The category's competitor set. The subject brand may appear here too; it is skipped. */
  readonly competitors?: readonly BrandSpec[]
  /** Publisher authority registry for source classification (ADR-0005). */
  readonly publishers?: Readonly<Record<string, string>>
}

export interface BrandMention {
  readonly brandId: string
  readonly name: string
  /** 0-based character offset of the first match in the normalised text. */
  readonly firstOffset: number
  readonly count: number
  /** Which alias matched first — recorded so a surprising match is explainable. */
  readonly matchedAlias: string
}

export interface ScoreRow {
  readonly algoVersion: string
  readonly brandId: string
  /** Did the brand appear in the answer text at all? */
  readonly mentioned: boolean
  /** Occurrences of any alias in the answer text. 0 when not mentioned. */
  readonly mentionCount: number
  /**
   * 1-based rank of this brand's first mention among ALL detected brands
   * (subject + competitors), ordered by first appearance. `null` when the brand
   * is not mentioned. Rank, not character offset, is the comparable unit: text
   * length varies wildly between engines.
   */
  readonly position: number | null
  /** How many brands were detected in total — the denominator `position` sits in. */
  readonly brandsDetected: number
  /** Was any of the brand's own domains cited? */
  readonly cited: boolean
  /** Positions in the engine's citation list where the brand's domain appears. */
  readonly citedAtPositions: readonly number[]
  /** Competitors detected in the text, in order of first appearance. */
  readonly competitorsMentioned: readonly string[]
  readonly citations: readonly ClassifiedCitation[]
  /** Provenance travels with the row (R8). */
  readonly collectionPath?: CollectionPath
}

/**
 * Fold the surface variants humans and engines write for the same token, then
 * mask URLs.
 *
 * Masking matters: an answer containing `https://hubspot.com/crm` would
 * otherwise score a text mention of "HubSpot" purely from the link, which
 * double-counts against the citation signal and inflates mention rate on
 * engines that inline their sources. The URL is replaced by spaces rather than
 * deleted so every surviving character keeps its original offset, and
 * `position` stays comparable.
 */
export function normaliseForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, (m) => ' '.repeat(m.length))
    .replace(/\bwww\.\S+/g, (m) => ' '.repeat(m.length))
}

/** Escape a literal for use inside a RegExp. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whole-token matcher. `\b` alone is wrong here: it does not fire around `+`
 * or `.`, so an alias like `C++` or `Node.js` would never match, and it treats
 * a digit as a word character so `Zoho1` would match `Zoho`. Explicit
 * boundaries are used instead: the match must not be flanked by a letter or
 * digit.
 */
function aliasRegex(alias: string): RegExp {
  const a = escapeRe(alias.normalize('NFKC').toLowerCase().trim()).replace(/\\?\s+/g, '\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${a}(?![\\p{L}\\p{N}])`, 'giu')
}

/** All matches of any alias, cheapest-explanation first: earliest offset wins. */
export function findMentions(normalisedText: string, brand: BrandSpec): BrandMention | null {
  let firstOffset = Infinity
  let matchedAlias = ''
  let count = 0
  for (const alias of brand.aliases) {
    if (!alias.trim()) continue
    const re = aliasRegex(alias)
    for (const m of normalisedText.matchAll(re)) {
      count++
      if (m.index !== undefined && m.index < firstOffset) {
        firstOffset = m.index
        matchedAlias = alias
      }
    }
  }
  if (count === 0) return null
  return { brandId: brand.id, name: brand.name, firstOffset, count, matchedAlias }
}

/**
 * Score one answer for one brand. Deterministic and side-effect free.
 *
 * NOTE what this does NOT produce: an interval. A single answer is one Bernoulli
 * trial; `{value, ci_low, ci_high, n}` (rule R8) is computed by the aggregation
 * step over n runs of a cell, in packages/stats. Emitting a "confidence" per
 * answer would be a category error.
 */
export function scoreAnswer(input: ScoreInput): ScoreRow {
  const { answer, brand } = input
  const text = normaliseForMatch(answer.text)

  const subject = findMentions(text, brand)
  const competitorHits = (input.competitors ?? [])
    .filter((c) => c.id !== brand.id)
    .map((c) => findMentions(text, c))
    .filter((m): m is BrandMention => m !== null)

  // Rank by first appearance across everything detected. Ties break on brand id
  // so the ordering is total and reproducible rather than insertion-dependent.
  const all = [...(subject ? [subject] : []), ...competitorHits].sort((a, b) => a.firstOffset - b.firstOffset || (a.brandId < b.brandId ? -1 : 1))
  const position = subject ? all.findIndex((m) => m.brandId === brand.id) + 1 : null

  const registry: ClassifierRegistry = {
    ownedDomains: brand.domains,
    competitorDomains: Object.fromEntries((input.competitors ?? []).filter((c) => c.id !== brand.id).map((c) => [c.name, c.domains])),
    ...(input.publishers ? { publishers: input.publishers } : {}),
  }
  const citations = classifyCitations(answer.citations, registry)
  const citedAtPositions = answer.citations.filter((c) => brand.domains.some((d) => isOnDomain(c.url, d))).map((c) => c.position)

  return {
    algoVersion: SCORING_ALGO_VERSION,
    brandId: brand.id,
    mentioned: subject !== null,
    mentionCount: subject?.count ?? 0,
    position,
    brandsDetected: all.length,
    cited: citedAtPositions.length > 0,
    citedAtPositions,
    competitorsMentioned: competitorHits.sort((a, b) => a.firstOffset - b.firstOffset).map((m) => m.name),
    citations,
  }
}
