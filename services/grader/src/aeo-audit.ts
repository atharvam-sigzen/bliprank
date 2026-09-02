/**
 * PHASES 3.x — THE GAP REPORT. What is on the page, against what is being asked
 * about it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SITS BESIDE THE SCAN AND NOT INSIDE IT.
 *
 * A scan answers "are you named in the answers". The next question every reader
 * asks is "so what do I do about it", and the honest answers to that are of two
 * different kinds. There is the causal kind, which needs a holdout and a
 * difference-in-differences and is PHASES 7; and there is the CHECKABLE kind —
 * "your homepage has no structured data on it at all", "eight of the ten
 * questions we asked contain terms your page never uses" — which needs nothing
 * but the page and the prompt bank, both of which are already here.
 *
 * ⚠️ THIS IS THE SECOND KIND AND SAYS SO. Every finding below is a fact about a
 * document, not a claim about a mechanism. Nothing here has been shown to move a
 * mention rate — we have not run the experiment — and the report states that in
 * the same breath as it states the finding, because "AI engines prefer schema
 * markup" is exactly the sort of confident, unmeasured claim the 72 tools in
 * this category compete on and this one does not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ IT DIAGNOSES. IT NEVER PUBLISHES.
 *
 * There is no CMS write, no API token, no "apply this fix" path, and no code
 * here that can change a byte of the customer's site. A draft is returned as a
 * string for a person to read, edit and paste, or throw away. That is a product
 * decision, not a scope limit: the fastest way to destroy a measurement product
 * is for it to also be the thing that edits the page being measured.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FETCH IS `fetch-site.ts`'S, UNCHANGED.
 *
 * That module is the SSRF boundary — five refusals, address pinning, per-hop
 * redirect re-checks — and it already fetches exactly this page for the
 * content classifier. A second fetcher here would be a second boundary to keep
 * correct, and the second one is the one nobody audits. This module takes HTML
 * and returns findings; it does no IO of its own at all.
 */

import { extractSiteText } from '@bliprank/taxonomy'
import { askText, type BankAuthorConfig } from './bank-author.js'

export type FindingStatus = 'present' | 'weak' | 'missing'

export interface Finding {
  readonly id: string
  readonly status: FindingStatus
  /** What was looked for, and what was found. A fact about the document. */
  readonly what: string
  /**
   * Why it plausibly matters for being cited — and how strong that link is.
   *
   * ⚠️ HEDGED ON PURPOSE, EVERY TIME. We have not run a holdout on any of these,
   * so none of them is a measured cause of anything. Writing "this will improve
   * your visibility" would be the exact claim this product exists to refuse
   * from other people.
   */
  readonly why: string
  /** What was actually seen, quoted where quoting is possible. */
  readonly evidence: string
}

export interface PromptCoverage {
  readonly prompt: string
  /** Content terms from the prompt that the page's text uses somewhere. */
  readonly covered: readonly string[]
  /** Content terms it never uses. This is the gap, concretely. */
  readonly missing: readonly string[]
  /** covered / (covered + missing). 0 when the prompt had no content terms. */
  readonly ratio: number
}

export interface AeoReport {
  readonly domain: string
  readonly finalUrl: string
  /**
   * ⚠️ TRUE WHEN THE PAGE WAS BIGGER THAN THE FETCH CEILING.
   *
   * `fetch-site.ts` abandons a body at 512 KB, deliberately — an endless
   * response is a memory-exhaustion primitive on a public path. That is right
   * for the fetch and it changes what a gap MEANS: on a truncated document,
   * "this term is not on the page" is not a claim anyone can make, only "this
   * term is not in the part we read". Every surface that prints coverage must
   * read this flag, and `renderReport` does.
   */
  readonly truncated: boolean
  readonly findings: readonly Finding[]
  readonly coverage: readonly PromptCoverage[]
  /** Mean of `ratio` across prompts. A summary of the coverage rows, nothing more. */
  readonly meanCoverage: number
  /** JSON-LD `@type` values found on the page, deduplicated. */
  readonly schemaTypes: readonly string[]
  /** Approximate word count of the page's own text, after script/style removal. */
  readonly words: number
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * STRUCTURED DATA.
 */

/**
 * Every `@type` in every JSON-LD block on the page.
 *
 * Parsed rather than pattern-matched, because `"@type"` appears in prose on
 * documentation sites and a substring hit would report structured data on a page
 * that has none. A block that does not parse is skipped and COUNTED — invalid
 * JSON-LD is a finding of its own, and "we found a script tag we could not read"
 * is a different fact from "there is no structured data here".
 */
export function jsonLdTypes(html: string): { readonly types: readonly string[]; readonly blocks: number; readonly invalid: number } {
  const types = new Set<string>()
  let blocks = 0
  let invalid = 0

  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) collect(n)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    const t = record['@type']
    if (typeof t === 'string') types.add(t)
    else if (Array.isArray(t)) for (const one of t) if (typeof one === 'string') types.add(one)
    // @graph and nested entities are where a real site keeps most of its types.
    for (const value of Object.values(record)) if (typeof value === 'object' && value !== null) collect(value)
  }

  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    blocks += 1
    try {
      collect(JSON.parse((m[1] ?? '').trim()))
    } catch {
      invalid += 1
    }
  }
  return { types: [...types].sort(), blocks, invalid }
}

/** Openers that make a heading a question a buyer would type. */
const QUESTION_OPENERS = /^(what|how|why|which|when|where|who|can|do|does|is|are|should|will)\b/i

/** Headings on the page that read as questions, `<details><summary>` included. */
export function questionHeadings(html: string): readonly string[] {
  const out: string[] = []
  const clean = (s: string): string =>
    s
      .replace(/<[^>]*>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  for (const m of html.matchAll(/<(h[1-6]|summary|dt)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const text = clean(m[2] ?? '')
    if (!text || text.length > 160) continue
    if (text.endsWith('?') || QUESTION_OPENERS.test(text)) out.push(text)
  }
  return out
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * DOES THE PAGE ADDRESS THE QUESTIONS BEING ASKED ABOUT IT?
 */

/**
 * Words carrying no topic. Kept deliberately short: this list decides what is
 * counted as a gap, and a long one quietly turns "your page does not mention
 * jewellery" into "your page does not mention the".
 */
const STOPWORDS = new Set(
  ('a an and are as at be best but by can do does for from good has have how i in is it me my need of on or our so ' +
    'that the their there they this to too us use want was we what when where which who why will with without you your')
    .split(' '),
)

/** Content terms of a prompt: lowercased words, stopwords and very short tokens dropped. */
export function promptTerms(prompt: string): readonly string[] {
  const seen = new Set<string>()
  for (const raw of prompt.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue
    seen.add(raw)
  }
  return [...seen]
}

/**
 * How much of each question's vocabulary the page's own text actually uses.
 *
 * ⚠️ WHAT THIS IS NOT. It is not a relevance score, not a ranking factor and not
 * a prediction. It is a word check: these are the terms in the questions we
 * asked the engines about your market, and these are the ones your homepage
 * never uses. That is a fact a person can act on directly and can verify with
 * ctrl-F, which is the only kind of advice this report is willing to give.
 *
 * Matched on a whole-word boundary against the page's TEXT, not its markup, so
 * a term appearing only inside a class name or a tracking script does not count
 * as the page addressing it.
 */
export function coverageFor(pageText: string, prompts: readonly string[]): readonly PromptCoverage[] {
  const words = new Set(pageText.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))
  /*
   * ⚠️ PLURALS COUNT, AND FOUND BY RUNNING THIS ON A REAL SITE.
   *
   * The first version matched whole words exactly and reported `booking` as
   * "never on the page" for a homepage that says "Bookings" repeatedly. That is
   * a FALSE GAP — the worst output this report can produce, because a false gap
   * is advice to write copy that already exists.
   *
   * Plurals in both directions and nothing else. No stemmer: a stemmer would
   * make `book` match `booking`, and a term that matches something the page did
   * not say is the same defect in the other direction. Two suffixes is the whole
   * rule, and it is legible enough that a reader can predict it.
   */
  const uses = (t: string): boolean =>
    words.has(t) || words.has(`${t}s`) || words.has(`${t}es`) || (t.endsWith('s') && words.has(t.slice(0, -1)))
  return prompts.map((prompt) => {
    const terms = promptTerms(prompt)
    const covered = terms.filter(uses)
    const missing = terms.filter((t) => !uses(t))
    return { prompt, covered, missing, ratio: terms.length === 0 ? 0 : covered.length / terms.length }
  })
}

/**
 * Every word the document itself displays: tags, scripts, styles and comments
 * removed, and nothing capped.
 *
 * Uncapped on purpose — see the note at its call site. It reads the page's own
 * TEXT rather than its markup, so a term that appears only in a class name, a
 * data attribute or a tracking script does not count as the page addressing it.
 */
export function wholeDocumentText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REPORT.
 */

/** Length bands for a meta description, from what search and answer surfaces truncate at. */
const DESCRIPTION_MIN = 70
const DESCRIPTION_MAX = 160
/** Below this a homepage has too little of its own text to answer anything from. */
const THIN_CONTENT_WORDS = 300

export function auditSite(
  html: string,
  opts: { readonly domain: string; readonly finalUrl?: string; readonly prompts: readonly string[]; readonly truncated?: boolean },
): AeoReport {
  const text = extractSiteText(html)
  const findings: Finding[] = []
  const add = (id: string, status: FindingStatus, what: string, why: string, evidence: string) =>
    findings.push({ id, status, what, why, evidence })

  const { types, blocks, invalid } = jsonLdTypes(html)

  if (blocks === 0) {
    add(
      'json-ld',
      'missing',
      'No JSON-LD structured data on the page.',
      'Structured data is the machine-readable version of what the page claims about itself. Whether it changes how often an answer engine cites you is not something we have measured, and anyone who tells you they have should be asked for the holdout.',
      'no <script type="application/ld+json"> block found',
    )
  } else if (invalid > 0) {
    add(
      'json-ld',
      'weak',
      `${invalid} of ${blocks} JSON-LD blocks do not parse.`,
      'A block that does not parse is not read by anything. This is a defect rather than an opportunity: the markup is there and is doing nothing.',
      `types read from the valid blocks: ${types.join(', ') || 'none'}`,
    )
  } else {
    add('json-ld', 'present', `${blocks} JSON-LD block(s), all parsing.`, 'The page describes itself in a machine-readable form.', types.join(', ') || 'no @type found')
  }

  const hasOrg = types.some((t) => /^(Organization|LocalBusiness|Corporation|OnlineBusiness|Store|SoftwareApplication|Product|Brand)$/i.test(t))
  add(
    'entity-schema',
    hasOrg ? 'present' : 'missing',
    hasOrg ? 'The page names an entity type for itself.' : 'No Organization, Product or SoftwareApplication type.',
    'This is where a page states, unambiguously, which thing it is about. A brand whose name is ambiguous in prose has one place to be unambiguous, and this is it. Untested against citation rates.',
    types.join(', ') || 'no @type found',
  )

  const hasFaqSchema = types.some((t) => /^(FAQPage|QAPage|HowTo)$/i.test(t))
  const questions = questionHeadings(html)
  if (hasFaqSchema) {
    add('faq', 'present', 'FAQ or Q&A structured data is present.', 'Question-and-answer content is the shape an answer engine is quoting from when it quotes a page at all.', types.filter((t) => /^(FAQPage|QAPage|HowTo)$/i.test(t)).join(', '))
  } else if (questions.length > 0) {
    add(
      'faq',
      'weak',
      `${questions.length} question-shaped headings, but no FAQPage or QAPage markup.`,
      'The content is already in the right shape; nothing declares it as such. This is the cheapest of the gaps here — it is a markup change over copy that already exists.',
      questions.slice(0, 3).join(' · '),
    )
  } else {
    add(
      'faq',
      'missing',
      'No question-and-answer content, in markup or in headings.',
      'Every prompt in this scan is a question. A page that never states a question cannot contain the sentence that answers one.',
      'no heading ends in "?" or opens with a question word',
    )
  }

  const description = text.description.trim()
  if (!description) {
    add('meta-description', 'missing', 'No meta description or og:description.', 'The one sentence the page gets to write about itself in a context it does not control.', 'neither meta name="description" nor og:description found')
  } else if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    add(
      'meta-description',
      'weak',
      `Description is ${description.length} characters (useful band is roughly ${DESCRIPTION_MIN}–${DESCRIPTION_MAX}).`,
      'Short says too little to be a self-description; long is truncated where it is displayed. The band is a convention, not a measurement.',
      description.slice(0, 140),
    )
  } else {
    add('meta-description', 'present', `Description is ${description.length} characters.`, 'The page describes itself in the length these surfaces display.', description.slice(0, 140))
  }

  const title = text.title.trim()
  if (!title) {
    add('title', 'missing', 'No <title>.', 'The classifier that placed this domain in its category reads the title first, and so does everything else.', 'empty or absent <title>')
  } else if (title.length < 10) {
    add('title', 'weak', `Title is ${title.length} characters.`, 'A title that is only a brand name says what you are called and not what you do — which is exactly the case ADR-0009 records as falling through to an authored category.', title)
  } else {
    add('title', 'present', `Title is ${title.length} characters.`, 'The page states what it is.', title)
  }

  const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)].map((m) => (m[1] ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean)
  add(
    'h1',
    h1s.length === 1 ? 'present' : h1s.length === 0 ? 'missing' : 'weak',
    h1s.length === 1 ? 'One <h1>.' : h1s.length === 0 ? 'No <h1>.' : `${h1s.length} <h1> elements.`,
    'The document\'s own statement of its subject. One is the convention; none leaves it unstated and several leave it contested.',
    h1s.slice(0, 3).join(' · ') || 'none',
  )

  const words = wholeDocumentText(html).split(/\s+/).filter(Boolean).length
  add(
    'content-depth',
    words >= THIN_CONTENT_WORDS ? 'present' : 'weak',
    `About ${words} words of page text.`,
    words >= THIN_CONTENT_WORDS
      ? 'There is enough of the page\'s own prose for a sentence to be quoted out of it.'
      : `Under ${THIN_CONTENT_WORDS} words. A page an engine has nothing to quote from is a page it can only cite as a link, if at all.`,
    text.body.slice(0, 140),
  )

  const robots = /<meta\b[^>]*name\s*=\s*["']robots["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(html)?.[1] ?? ''
  if (/noindex|nosnippet|noai|noimageai/i.test(robots)) {
    add(
      'robots',
      'missing',
      `The page asks not to be indexed or quoted: robots="${robots}".`,
      'This one is not a nuance. A directive of this kind is the page telling crawlers to leave it alone, and it outranks everything else in this report.',
      robots,
    )
  } else {
    add('robots', 'present', 'No noindex/nosnippet directive.', 'Nothing on the page refuses to be read.', robots || 'no robots meta tag')
  }

  const canonical = /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']*)["']/i.exec(html)?.[1] ?? ''
  add(
    'canonical',
    canonical ? 'present' : 'weak',
    canonical ? 'A canonical URL is declared.' : 'No canonical URL.',
    'Which address is the real one, when the same page is reachable at several. Absent, the citation a scan attributes to you may be split across duplicates of the same page.',
    canonical || 'no <link rel="canonical">',
  )

  /*
   * ⚠️ THE WHOLE DOCUMENT, NOT `extractSiteText`'S 20,000-CHARACTER BODY.
   *
   * Found by running this against sigzen.com, whose homepage strips to 173,000
   * characters: the classifier's cap meant coverage was judged on the first 12%
   * of the page and everything past it was reported as "never on the page".
   *
   * That cap is CORRECT where it lives and its docblock says why — a category
   * must be reproducible, and a footer that changes daily must not move one. A
   * gap report has the opposite requirement: it is asking "does this page ever
   * say this", and a cap turns that into a manufactured gap. Same document, two
   * questions, two right answers.
   */
  const pageText = [text.title, text.description, text.headings, wholeDocumentText(html)].join(' ')
  const coverage = coverageFor(pageText, opts.prompts)
  const meanCoverage = coverage.length === 0 ? 0 : coverage.reduce((s, c) => s + c.ratio, 0) / coverage.length

  return {
    domain: opts.domain,
    finalUrl: opts.finalUrl ?? '',
    truncated: opts.truncated === true,
    findings,
    coverage,
    meanCoverage,
    schemaTypes: types,
    words,
  }
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DRAFT.
 */

const DRAFT_SYSTEM = `You draft a short piece of web copy for a company's own site.

You are given: the company's domain, what its homepage currently says about
itself, and ONE question that real buyers in its market ask AI assistants — a
question the homepage does not currently address.

Write a heading and two to four short paragraphs that answer that question
directly and specifically, in the company's own voice, as copy that would sit on
their site.

Rules:
- Answer the question in the FIRST sentence. Do not build up to it.
- Use only what the homepage already tells you about this company. If you do not
  know a number, a price, a customer count or a certification, do not write one.
- Name no competitor and make no comparative claim.
- Claim no award, no ranking and no statistic.
- British-neutral English. No em-dashes. No marketing superlatives.
- Plain markdown: one "## " heading, then paragraphs. Nothing else.

This is a DRAFT for a person to edit. It will not be published by anything.`

export interface DraftInput {
  readonly domain: string
  readonly title: string
  readonly description: string
  readonly headings: string
  /** The question the page does not address — one of the bank's own prompts. */
  readonly prompt: string
  /** The terms of that question the page never uses. Named, so the draft covers them. */
  readonly missingTerms: readonly string[]
  readonly config: BankAuthorConfig
  readonly fetchImpl?: typeof fetch
  readonly log?: (message: string) => void
}

/**
 * Draft one answer block for one gap. Optional, and off unless a key is set.
 *
 * ⚠️ NEVER THROWS, AND NEVER PUBLISHES. It returns a string for a person to
 * read, edit and paste, or null when no model answered — the same degradation
 * `authorBank` makes, so an unconfigured author and a rate-limited one reach the
 * caller as one outcome. There is no code path from here to the customer's site.
 *
 * ⚠️ A MODEL IS ALLOWED HERE, AND THAT IS NOT A CONTRADICTION OF R1. R1 governs
 * SCORING: a number must be reproducible, so nothing that produces one may call
 * a model. This produces prose for a human to edit, which is CLAUDE.md §6's
 * "customer-facing generation" — the same category as the prompt-bank author,
 * behind the same seam and the same env vars. No number anywhere depends on what
 * it returns, and nothing stores it.
 *
 * ponytail: `openai-compatible` only. The Anthropic transport in `bank-author`
 * is a forced tool call shaped for a bank, and this needs prose; a config on
 * that provider gets null and a logged line rather than a wrong-shaped request.
 * Upgrade path if anyone runs Anthropic in anger: a plain text branch in
 * `askText`, about six lines.
 */
export async function draftGapContent(input: DraftInput): Promise<string | null> {
  const log = input.log ?? (() => {})
  if (input.config.provider !== 'openai-compatible') {
    log(`aeo-draft: provider "${input.config.provider}" has no prose transport; no draft was written`)
    return null
  }

  const user = [
    `Domain: ${input.domain}`,
    `Homepage title: ${input.title || '(none)'}`,
    `Homepage description: ${input.description || '(none)'}`,
    `Homepage headings: ${input.headings.slice(0, 1_500) || '(none)'}`,
    '',
    `The question buyers ask that this page does not address:`,
    `  "${input.prompt}"`,
    '',
    `Terms from that question the page never uses: ${input.missingTerms.join(', ') || '(none)'}`,
  ].join('\n')

  const models = [input.config.model, ...(input.config.fallbackModel ? [input.config.fallbackModel] : [])]
  for (const [i, model] of models.entries()) {
    try {
      const text = await askText(input.config, model, DRAFT_SYSTEM, user, {
        maxTokens: 1_200,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      })
      if (!text.trim()) throw new Error(`${model} returned nothing`)
      if (i > 0) log(`aeo-draft: ${input.config.model} did not answer; ${model} did`)
      return text.trim()
    } catch (e) {
      log(`aeo-draft: ${model} failed (${(e as Error).message})`)
    }
  }
  return null
}

/** The gap most worth drafting for: the prompt the page covers least. */
export function widestGap(report: AeoReport): PromptCoverage | null {
  const ranked = [...report.coverage].sort((a, b) => a.ratio - b.ratio || b.missing.length - a.missing.length)
  return ranked[0] ?? null
}
