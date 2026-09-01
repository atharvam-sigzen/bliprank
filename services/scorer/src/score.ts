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
export const SCORING_ALGO_VERSION = 'det-2'

export interface BrandSpec {
  readonly id: string
  readonly name: string
  /**
   * Surface forms to match, including the name. Matching is case-insensitive
   * and whole-token, so an alias must be a form a human would actually write:
   * 'HubSpot', 'Hub Spot', 'hubspot crm'. Not a substring fragment.
   */
  readonly aliases: readonly string[]
  /**
   * Forms to match IGNORING separators, for a brand whose domain runs its words
   * together. Compared against the answer with all non-alphanumerics removed,
   * then boundary-checked against the ORIGINAL text.
   *
   * ⚠️ THIS EXISTS BECAUSE OF A FALSE ZERO, which is the worst thing this
   * scorer can produce. `thecosmicbyte.com` is not a tracked leader, so its only
   * alias was the domain label `thecosmicbyte`. The engines write "Cosmic Byte".
   * Whole-token matching found nothing, and a brand named 139 times across 31 of
   * 50 answers was published as 0.0% — mentioned in none of them. A low number
   * is a finding; a zero that should be 62% is a broken instrument.
   *
   * Kept SEPARATE from `aliases` rather than applied to all of them, because
   * squashing is a weaker rule and the leader tables are hand-reviewed. A brand
   * that needs it says so; nothing else changes behaviour.
   */
  readonly squashedAliases?: readonly string[]
  /** Domains the brand owns, for citation detection. Subdomains count. */
  readonly domains: readonly string[]
}

/**
 * Leading words a domain bolts onto a brand name because the bare name was
 * taken. Stripping one yields the form the world actually writes.
 *
 * `thecosmicbyte` -> `cosmicbyte`, which is what "Cosmic Byte" squashes to.
 * Without this the squashed alias is `thecosmicbyte`, the answers say "Cosmic
 * Byte", and the two never meet — the false zero.
 */
const DOMAIN_PREFIXES = ['the', 'get', 'try', 'use', 'my', 'go', 'join', 'hey', 'we', 'app'] as const

/**
 * The shortest a prefix-stripped remainder may be before it is trusted.
 *
 * `google` minus `go` is `ogle` — a real four-letter string that could stand
 * alone in a sentence and be counted as a mention of Google. Five characters is
 * not a proof, it is a floor: it keeps the accidental strippings of short
 * domains out while leaving real compound names (`cosmicbyte`) well clear.
 */
const MIN_STRIPPED_LENGTH = 5

/** Lowercase, letters and digits only. The form squashed matching compares. */
export const squash = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/**
 * Brand forms for a domain that is NOT a tracked leader, so has no reviewed
 * alias table — the `domain-label` case in `subjectFor`.
 *
 * ⚠️ THE FALSE ZERO THIS EXISTS TO END. The subject's only alias used to be the
 * bare domain label. `thecosmicbyte.com` therefore looked for `thecosmicbyte`
 * while every engine wrote "Cosmic Byte", and a brand named in 31 of 50 answers
 * was published as mentioned in none of them.
 *
 * Two signals, and they check each other:
 *
 *   THE DOMAIN gives squashed candidates — the label, and the label minus a
 *   leading `the`/`get`/`use`. Separator-insensitive, so any spacing of the
 *   same letters matches. Never shorter than MIN_STRIPPED_LENGTH.
 *
 *   THE SITE'S OWN TITLE gives the real trading name, but ONLY when a phrase in
 *   it squashes to one of those candidates. That corroboration is the whole
 *   safety property: the title is not trusted to name the brand, it is trusted
 *   to CONFIRM a name the domain already implies. A title reading "Best Gaming
 *   Gear in India" contributes nothing, because nothing in it matches the host.
 *
 * Pure, so the same host and title always yield the same forms. The caller is
 * responsible for recording the title-derived name, because a re-scan that
 * reads the decision instead of re-fetching must score identically (R5).
 */
export function domainBrandForms(host: string, siteTitle?: string): { name: string; aliases: string[]; squashedAliases: string[] } {
  const label = squash((host.toLowerCase().replace(/^www\./, '').split('.')[0] ?? '').trim())
  if (!label) return { name: host, aliases: [], squashedAliases: [] }

  const candidates = [label]
  for (const p of DOMAIN_PREFIXES) {
    if (label.startsWith(p) && label.length - p.length >= MIN_STRIPPED_LENGTH) candidates.push(label.slice(p.length))
  }

  // The longest phrase of the title that squashes to a candidate. Longest, so
  // "Cosmic Byte" wins over "Cosmic" when both would match a candidate.
  let traded = ''
  const words = (siteTitle ?? '').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    for (let n = Math.min(4, words.length - i); n >= 1; n--) {
      const phrase = words.slice(i, i + n).join(' ')
      if (candidates.includes(squash(phrase)) && phrase.length > traded.length) traded = phrase
    }
  }

  return {
    // The corroborated trading name is what a reader should see. Falling back to
    // the label is honest rather than pretty: it is what we actually know.
    name: traded || label,
    aliases: [...new Set([label, ...(traded ? [traded] : [])])],
    squashedAliases: [...new Set(candidates)],
  }
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
  /** Length of that first match, used to rank nested brands at the same offset. */
  readonly matchLength: number
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
 * digit or underscore - `HubSpot_alt` and `#HubSpot_CRM` are handles, not mentions.
 */
function aliasRegex(alias: string): RegExp {
  const a = escapeRe(alias.normalize('NFKC').toLowerCase().trim()).replace(/\\?\s+/g, '\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}_])${a}(?![\\p{L}\\p{N}_])`, 'giu')
}

/** True for a character that may not flank a match — same rule as `aliasRegex`. */
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c)

/**
 * Occurrences of a separator-insensitive alias, as spans in the ORIGINAL text.
 *
 * The text is squashed — every non-alphanumeric removed — and searched for the
 * squashed alias, so `cosmicbyte` finds "Cosmic Byte", "Cosmic-Byte",
 * "CosmicByte" and "Cosmic  Byte" without anyone enumerating those forms.
 *
 * ⚠️ SQUASHING DESTROYS WORD BOUNDARIES, AND THAT IS THE DANGEROUS PART.
 * "smart station" squashes to `smartstation`, which CONTAINS `artstation`. A
 * naive squash-and-search would report a mention of ArtStation in a sentence
 * about a smart station — inventing a mention, which is worse than missing one
 * and is the failure mode this whole product argues against.
 *
 * So every hit is mapped back to its original offsets through `origin` and
 * boundary-checked THERE, against the untouched text: the character before the
 * match and the character after it must not be a letter, digit or underscore.
 * `artstation` inside "smart station" starts immediately after `m` and is
 * rejected; "Cosmic Byte" is flanked by spaces and is kept.
 *
 * Overlapping occurrences of one alias are skipped, so a repeated squashed form
 * cannot be counted twice from a single stretch of text.
 */
export function findSquashedSpans(
  normalisedText: string,
  squashedAliases: readonly string[],
): { start: number; end: number; alias: string }[] {
  const usable = squashedAliases.filter((a) => a.trim())
  if (usable.length === 0) return []

  // Squashed text plus, per squashed character, its index in the original. Both
  // are built in one pass so the mapping cannot drift from the string.
  let squashed = ''
  const origin: number[] = []
  for (let i = 0; i < normalisedText.length; i++) {
    const c = normalisedText[i]!
    if (/[\p{L}\p{N}]/u.test(c)) {
      squashed += c.toLowerCase()
      origin.push(i)
    }
  }

  const out: { start: number; end: number; alias: string }[] = []
  for (const alias of usable) {
    const needle = alias.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    // A one or two character needle squash-matches far too much to be evidence.
    if (needle.length < 3) continue
    let from = 0
    for (;;) {
      const at = squashed.indexOf(needle, from)
      if (at === -1) break
      const start = origin[at]!
      const end = origin[at + needle.length - 1]! + 1
      // THE GUARD. Checked in the original text, where the boundaries survive.
      if (!isWordChar(normalisedText[start - 1]) && !isWordChar(normalisedText[end])) {
        out.push({ start, end, alias })
      }
      from = at + needle.length
    }
  }
  return out
}

/**
 * All occurrences of any alias, as non-overlapping spans.
 *
 * Overlap resolution is the whole job. Aliases nest — a brand listing both
 * `Zoho` and `Zoho CRM` is the normal case, not a corner case — and matching
 * each alias independently counted "Zoho CRM is affordable" as TWO mentions.
 * `mentionCount` feeds frequency and share-of-voice, so that silently inflated
 * every brand whose alias table contains a name plus a "name + product line"
 * form, which is most of them.
 *
 * Longest match wins at any given position: `Zoho CRM` is a more specific
 * reading of the same text than `Zoho`, and reporting the specific one makes
 * the recorded `matchedAlias` explain what a human actually sees.
 */
export function findMentions(normalisedText: string, brand: BrandSpec): BrandMention | null {
  const spans: { start: number; end: number; alias: string }[] = []
  for (const alias of brand.aliases) {
    if (!alias.trim()) continue
    for (const m of normalisedText.matchAll(aliasRegex(alias))) {
      if (m.index !== undefined) spans.push({ start: m.index, end: m.index + m[0].length, alias })
    }
  }
  spans.push(...findSquashedSpans(normalisedText, brand.squashedAliases ?? []))
  if (spans.length === 0) return null

  // Earliest first; at equal start the longer span wins; then alias name, so
  // the ordering is total and never depends on alias array order.
  spans.sort((a, b) => a.start - b.start || b.end - a.end || (a.alias < b.alias ? -1 : 1))

  const kept: typeof spans = []
  for (const span of spans) {
    const last = kept[kept.length - 1]
    if (last && span.start < last.end) continue // overlaps an accepted span
    kept.push(span)
  }

  const first = kept[0]!
  return { brandId: brand.id, name: brand.name, firstOffset: first.start, count: kept.length, matchedAlias: first.alias, matchLength: first.end - first.start }
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
  // At the same offset the longer match is the more specific brand ("Microsoft
  // Copilot" over "Microsoft"), which is a meaningful rank rather than an
  // alphabetical accident. Brand id only breaks a genuine tie, keeping the
  // ordering total and reproducible (R5).
  const all = [...(subject ? [subject] : []), ...competitorHits].sort(
    (a, b) => a.firstOffset - b.firstOffset || b.matchLength - a.matchLength || (a.brandId < b.brandId ? -1 : 1),
  )
  const position = subject ? all.findIndex((m) => m.brandId === brand.id) + 1 : null

  const registry: ClassifierRegistry = {
    ownedDomains: brand.domains,
    // Sorted by name: two competitors can legitimately share a domain (sister
    // brands, a rebrand, a shared parent site), and without a stable order the
    // recorded `competitor` label would depend on how the caller happened to
    // build the array — a stored field changing with no change to the answer.
    competitorDomains: Object.fromEntries(
      (input.competitors ?? [])
        .filter((c) => c.id !== brand.id)
        .slice()
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((c) => [c.name, c.domains]),
    ),
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
