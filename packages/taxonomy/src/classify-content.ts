/**
 * PHASES 3.1 — the site-content signal, deterministically.
 *
 * `classify-domain.ts` reads five tokens of a hostname. This reads the page the
 * hostname serves. It is the signal PHASES 3.1 named and never built, and it is
 * why `unclassified` was the common answer rather than the rare one: a real
 * business whose name is not its category — `sigzen.com`, `nike.com` — carries
 * nothing in its host and everything on its homepage.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO MODEL CALL, AND THE REASON IS THE SAME ONE `classify-domain.ts` GIVES.
 *
 * The category decides which prompt bank runs, which decides `comparison_basis`.
 * A non-deterministic classifier lets the same page land in different banks on
 * different days, so the thing a number is a measurement OF changes underneath
 * the customer — exactly the change `compare()` exists to refuse. The cost
 * argument would be weak here (a Haiku classification is ~$0.0002 against a
 * $0.18 scan); the reproducibility argument is not, and it is the product.
 *
 * Pure: same text plus same taxonomy always yields the same result. The fetch
 * lives in `services/grader/src/fetch-site.ts`, at the edge, where the SSRF
 * surface can be reasoned about in one place (CLAUDE.md §8).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS NOT JUST "COUNT THE KEYWORDS".
 *
 * Three rules do the work, and each exists because of a specific way the naive
 * version is wrong.
 *
 * 1. DISTINCT PHRASES, NOT TOTAL HITS. A page that says "support" forty times
 *    is not a help desk; a page that says "support tickets", "shared inbox" and
 *    "first response time" once each is. So a category needs at least
 *    `MIN_DISTINCT` different phrases before it may be selected, and each
 *    phrase's contribution is capped so repetition cannot substitute for
 *    breadth. This is the content-side form of the substring refusal
 *    `domainKeywords` already makes.
 *
 * 2. A MARGIN OVER THE RUNNER-UP. Every SaaS homepage mentions its integrations,
 *    so a CRM's page really does contain email-marketing phrases. Winning by a
 *    nose is not evidence; it is noise. Below `MIN_MARGIN` the answer is
 *    `ambiguous`, which is a real answer — the same one `classifyDomain`
 *    returns for `zoho.com`, and it is carried, not flattened.
 *
 * 3. THE PAGE MUST DESCRIBE ITSELF THAT WAY. Body text can strengthen a
 *    category and can never select one — see `MIN_SELF_DESCRIPTION_HITS`, which
 *    documents the real wrong answer it exists to prevent.
 *
 * When neither rule is satisfiable the answer is `weak`, and `weak` is what
 * `resolve-category.ts` reads as "this domain is not in the taxonomy yet".
 * It is deliberately distinguishable from `ambiguous`: one means the taxonomy
 * has no home for this business, the other that it has too many.
 */

import type { CategoryDef } from './types.js'

/** The zones of a page, most load-bearing first. */
export interface SiteText {
  readonly title: string
  readonly description: string
  readonly headings: string
  readonly body: string
}

/**
 * What a hit in each zone is worth.
 *
 * A phrase in the `<title>` is the site describing itself in ten words it chose
 * deliberately; the same phrase in the body may be a footer link. The weights
 * are ordered by how much authorial intent the zone carries, and nothing is
 * worth zero — a category whose only evidence is body text can still win, it
 * just needs more of it.
 */
export const ZONE_WEIGHT = { title: 6, description: 4, headings: 3, body: 1 } as const

/** Hits per phrase per zone that count. Repetition past this buys nothing. */
export const MAX_HITS_PER_PHRASE = 3

/** Distinct phrases a category needs before it may be selected at all. */
export const MIN_DISTINCT = 2

/** Score the winner needs. Roughly: two body phrases twice over, or one in the title. */
export const MIN_SCORE = 8

/** How far ahead of the runner-up the winner must be. */
export const MIN_MARGIN = 1.5

/**
 * Phrases a category needs in the page's SELF-DESCRIPTION — its `<title>` and
 * its meta descriptions — before body text is allowed to count toward selecting
 * it.
 *
 * ⚠️ THIS RULE EXISTS BECAUSE OF A REAL WRONG ANSWER, and it is the difference
 * between a classifier and a word counter.
 *
 * `sigzen.com` is an ERPNext implementation partner — a consultancy. Its title
 * says "Certified ERPNext & Frappe Partner - Implementation & Support" and its
 * meta description says the same thing again. Its BODY, being a list of the ERP
 * modules it implements, says `crm` twenty-one times, `lead management` three
 * times and `sales pipeline` once. On totals alone it scored 18 against a floor
 * of 8 with five distinct phrases and a clear margin: a confident, well-evidenced
 * and completely wrong answer, of exactly the kind that then silently changes
 * what every number downstream is a measurement of.
 *
 * The title and the meta description are the two places a business describes
 * ITSELF, in one sentence, deliberately. Everything else on a homepage is a
 * module list, an integrations grid, a footer or a blog teaser — evidence about
 * what the business TOUCHES, not about what it IS. So the body can strengthen a
 * category and can never select one.
 *
 * The cost is real and accepted: a vendor whose title is only its brand name
 * ("Acme") now falls through to an authored category instead of a hand-authored
 * one. That is the better failure. A business placed in nobody else's category
 * gets a bank written from its own words; a business placed in the WRONG
 * category gets a competitor set it does not compete with.
 */
export const MIN_SELF_DESCRIPTION_HITS = 1

export interface CategoryScore {
  readonly slug: string
  readonly score: number
  /** Distinct phrases matched anywhere. The breadth half of the evidence. */
  readonly distinct: number
  /** Which phrases, sorted, so a surprising classification is explainable. */
  readonly matched: readonly string[]
  /** Distinct phrases in the title or a meta description. See `MIN_SELF_DESCRIPTION_HITS`. */
  readonly inSelfDescription: number
}

export type ContentClassification =
  | { readonly status: 'classified'; readonly slug: string; readonly signal: 'site-content'; readonly evidence: string; readonly scores: readonly CategoryScore[] }
  | { readonly status: 'ambiguous'; readonly candidates: readonly string[]; readonly signal: 'site-content'; readonly evidence: string; readonly scores: readonly CategoryScore[] }
  /** No category clears the floor. The taxonomy has no home for this business. */
  | { readonly status: 'weak'; readonly reason: string; readonly scores: readonly CategoryScore[] }

/**
 * Text → a single space-delimited string of lowercase `[a-z0-9]` tokens.
 *
 * Bracketed with a leading and trailing space so a phrase search for ` crm `
 * matches at the start and end of the string as well as in the middle, and
 * matches nothing inside a longer token. That bracketing IS the whole-token
 * rule: without it, `crm` matches `microm` and the classifier acquires the
 * substring bug the taxonomy spends two docblocks refusing.
 */
export function normaliseText(input: string): string {
  return ' ' + input.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' '
}

/** Occurrences of `phrase` as a whole-token sequence in an already-normalised haystack. */
export function countPhrase(normalisedHaystack: string, phrase: string): number {
  const needle = normaliseText(phrase)
  // A phrase that normalises to nothing (punctuation only) must not match
  // everywhere via an empty-string indexOf loop.
  if (needle.trim() === '') return 0
  // Overlapping matches are impossible for whole-token sequences, but the
  // needle's own trailing space is the next match's leading space, so the
  // search resumes one character before the end of the last hit.
  let count = 0
  let from = 0
  for (;;) {
    const at = normalisedHaystack.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length - 1
  }
}

/** Every category's score against this page, highest first, ties broken by slug. */
export function scoreCategories(text: SiteText, taxonomy: readonly CategoryDef[]): readonly CategoryScore[] {
  const zones = [
    { text: normaliseText(text.title), weight: ZONE_WEIGHT.title },
    { text: normaliseText(text.description), weight: ZONE_WEIGHT.description },
    { text: normaliseText(text.headings), weight: ZONE_WEIGHT.headings },
    { text: normaliseText(text.body), weight: ZONE_WEIGHT.body },
  ]

  // The two zones the business wrote about itself, deliberately, in one
  // sentence each. Tracked separately from the score — see MIN_SELF_DESCRIPTION_HITS.
  const selfDescription = normaliseText(`${text.title} ${text.description}`)

  const out: CategoryScore[] = []
  for (const category of taxonomy) {
    if (category.contentKeywords.length === 0) continue
    let score = 0
    let inSelfDescription = 0
    const matched: string[] = []
    for (const phrase of category.contentKeywords) {
      let hitAnywhere = false
      for (const zone of zones) {
        const hits = Math.min(countPhrase(zone.text, phrase), MAX_HITS_PER_PHRASE)
        if (hits > 0) hitAnywhere = true
        score += hits * zone.weight
      }
      if (hitAnywhere) matched.push(phrase)
      if (countPhrase(selfDescription, phrase) > 0) inSelfDescription += 1
    }
    if (score > 0) out.push({ slug: category.slug, score, distinct: matched.length, matched: matched.sort(), inSelfDescription })
  }
  return out.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
}

/**
 * Classify a page against the taxonomy.
 *
 * Three outcomes, and only the first is a category. `ambiguous` means two
 * categories fit and picking one would be inventing a fact; `weak` means none
 * does, which is the case `resolve-category.ts` grows the taxonomy for.
 */
export function classifyContent(text: SiteText, taxonomy: readonly CategoryDef[]): ContentClassification {
  const scores = scoreCategories(text, taxonomy)
  const best = scores[0]
  if (!best) return { status: 'weak', reason: 'no category vocabulary appears on the page', scores }
  if (best.distinct < MIN_DISTINCT) {
    return {
      status: 'weak',
      reason: `only ${best.distinct} distinct phrase matched (${best.matched.join(', ')}); ${MIN_DISTINCT} are needed, because one phrase repeated is a mention and not a subject`,
      scores,
    }
  }
  if (best.score < MIN_SCORE) {
    return { status: 'weak', reason: `the strongest category scored ${best.score}, under the floor of ${MIN_SCORE}`, scores }
  }
  if (best.inSelfDescription < MIN_SELF_DESCRIPTION_HITS) {
    // The sigzen case. Well-evidenced by volume, and about a market the business
    // serves rather than the one it is in.
    return {
      status: 'weak',
      reason: `the page mentions ${best.slug} vocabulary (${best.matched.join(', ')}) but its title and description do not, so this reads as a market it works with rather than the one it is in`,
      scores,
    }
  }

  const runnerUp = scores[1]
  if (runnerUp && runnerUp.score * MIN_MARGIN > best.score) {
    // Both are named, sorted, exactly as classifyDomain reports its ambiguity.
    return {
      status: 'ambiguous',
      candidates: [best.slug, runnerUp.slug].sort(),
      signal: 'site-content',
      evidence: `${best.slug} scored ${best.score} and ${runnerUp.slug} scored ${runnerUp.score}, too close to separate`,
      scores,
    }
  }

  return { status: 'classified', slug: best.slug, signal: 'site-content', evidence: best.matched.join(', '), scores }
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * HTML → the four zones.
 *
 * Regex, and no HTML parser dependency. The job is not to build a DOM: it is to
 * recover four bags of words from a document that may well be malformed, and a
 * strict parser is worse at that than a lenient scan. Every regex here is
 * anchored on a tag name, so the failure mode is missing text rather than
 * mis-attributing it.
 *
 * `<script>`, `<style>`, `<noscript>` and comments are removed FIRST and by
 * name. A Next.js homepage ships its entire props tree inside a script tag, and
 * without this the "body text" of every React site is a JSON blob — which is
 * both meaningless and, since it can contain any string at all, an injection
 * path into the classifier's evidence.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&mdash;': '-', '&ndash;': '-', '&rsquo;': "'", '&lsquo;': "'",
  '&ldquo;': '"', '&rdquo;': '"', '&hellip;': '...',
}

const decode = (s: string): string =>
  s.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ')

const strip = (s: string): string => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

/**
 * How much body text is read.
 *
 * A cap rather than the whole document, for one reason that is not performance:
 * the scores must be reproducible, and a page whose footer changes daily should
 * not move a category. The first 20k characters of a homepage are the part the
 * site wrote about itself; past that it is navigation, legal text and blog
 * teasers. `fetch-site.ts` caps the download separately and for a different
 * reason — this cap is about what the answer depends on.
 */
export const MAX_BODY_CHARS = 20_000

export function extractSiteText(html: string): SiteText {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ')

  const title = strip(/<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(cleaned)?.[1] ?? '')

  // Both the SEO description and the social one: they are frequently different
  // sentences about the same product, and two descriptions is more evidence
  // than one. og:title too — a site that leaves <title> as its brand name
  // often puts the actual proposition here.
  const metas: string[] = []
  for (const m of cleaned.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0]
    const name = /\b(?:name|property)\s*=\s*["']?([a-z:-]+)/i.exec(tag)?.[1]?.toLowerCase()
    if (name !== 'description' && name !== 'og:description' && name !== 'og:title' && name !== 'twitter:description') continue
    const content = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag)
    const value = content?.[2] ?? content?.[3] ?? ''
    if (value) metas.push(strip(value))
  }

  const headings: string[] = []
  for (const m of cleaned.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]\s*>/gi)) {
    const t = strip(m[1] ?? '')
    if (t) headings.push(t)
  }

  return {
    title,
    description: metas.join(' '),
    headings: headings.join(' '),
    body: strip(cleaned).slice(0, MAX_BODY_CHARS),
  }
}
