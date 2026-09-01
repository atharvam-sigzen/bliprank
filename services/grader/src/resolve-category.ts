/**
 * PHASES 3.1 — one domain, one category, decided once and kept.
 *
 * This is the composition layer for classification, and it owns the one property
 * that everything downstream depends on:
 *
 *   ⚠️ A DOMAIN'S CATEGORY IS DECIDED ONCE AND NEVER SILENTLY CHANGES.
 *
 * `classify-domain.ts` explains why determinism matters — the category picks the
 * prompt bank, the bank picks `comparison_basis`, and a category that moves makes
 * two scans of the same domain measurements of different things, which is the
 * change `compare()` exists to refuse. That module gets determinism from being
 * pure. This one cannot: it reads a live homepage, and a homepage is rewritten
 * on Tuesdays.
 *
 * So determinism here is achieved by WRITING THE ANSWER DOWN. The first scan of
 * a domain derives its category; every later scan reads the record. A site that
 * relaunches with new copy does not quietly become a different category and
 * invalidate its own history — changing it is an explicit act with a version
 * bump behind it, the same discipline R5 applies to score rows.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LADDER, IN ORDER, AND EVERY RUNG IS CHEAPER THAN THE NEXT.
 *
 *   0. THE RECORD          free      already decided, so nothing is re-derived
 *   1. leader-domain       free      the host IS a brand we track
 *   2. domain-token        free      a whole token of the host is a keyword
 *   3. site-content        1 GET     the homepage says what the business does
 *   4. generated           1 model   nothing in the taxonomy fits; author a bank
 *   5. fallback            free      none of the above worked; say so
 *
 * Rungs 1 and 2 are `classifyDomain`, unchanged and still first, because a free
 * deterministic answer should never be bought. Rung 3 is the signal PHASES 3.1
 * named and never built. Rung 4 is the taxonomy growing from real usage instead
 * of being exhaustively pre-authored — 200 hand-built banks is the plan, and a
 * plan that requires the 201st visitor to be turned away is not a plan.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ A GENERATED CATEGORY NEVER HAS COMPETITORS. NON-NEGOTIABLE.
 *
 * `leaders: []`, always, constructed here and not by the model — the tool schema
 * the model answers has no field for a competitor at all, so there is no path by
 * which one could be supplied and then dropped. This is the same rule the
 * fallback bank already follows and the same rule `/category-bank` states: "Do
 * not invent competitor names. Derive them from actual collected answers or from
 * a verifiable source."
 *
 * A plausible-looking rival on a chart that nobody measured against anything is
 * precisely the failure this product is positioned against, and a model asked to
 * name the leaders in a category will always produce five. Real competitors may
 * only ever arrive later, from brands the engines actually named in answers we
 * actually collected.
 *
 * What IS generated is the prompt set, and only that. A prompt names no brand by
 * construction — the scan runs `discovery` and `problem-led` intents only — and
 * the bank is stamped `verified: false` so no surface can present it as
 * reviewed.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import {
  DEMO_BANKS,
  DEMO_TAXONOMY,
  FALLBACK_SLUG,
  classifyContent,
  classifyDomain,
  extractSiteText,
  normaliseHost,
  type CategoryDef,
  type PromptBank,
} from '@bliprank/taxonomy'
import { fetchSiteHtml, type FetchSiteOptions, type FetchSiteResult } from './fetch-site.js'

/** CLAUDE.md §6: Sonnet 5 is the customer-facing generation model. */
export const BANK_AUTHOR_MODEL = 'claude-sonnet-5'

/** Unprompted prompts a generated bank must carry. Matches every hand-authored bank's 17. */
export const GENERATED_DISCOVERY = 10
export const GENERATED_PROBLEM_LED = 7

export type CategorySource = 'record' | 'leader-domain' | 'domain-token' | 'site-content' | 'generated' | 'fallback'

/** What gets written down, permanently, the first time a domain is seen. */
export interface CategoryRecord {
  readonly host: string
  readonly slug: string
  readonly source: CategorySource
  /** What actually matched, so a surprising category is explainable years later. */
  readonly evidence: string
  /** ISO date. Provenance travels with the decision (R8's discipline, applied here). */
  readonly decidedAt: string
  /** True when this slug's bank was authored by a model rather than by a human. */
  readonly generated: boolean
}

export interface ResolvedCategory {
  readonly record: CategoryRecord
  readonly bank: PromptBank
  readonly category: CategoryDef
  /** Set when the resolved bank is the fallback, carrying why. Mirrors `ScanResult.fallback`. */
  readonly fallback?: { readonly reason: 'unclassified' | 'ambiguous'; readonly detail: string; readonly candidates: readonly string[] }
}

export interface ResolveDeps {
  /** Where records and generated banks live. Same dir the gate ledgers use. */
  readonly dataDir: string
  /** Absent disables rung 4 entirely; the resolver falls back exactly as before. */
  readonly anthropicApiKey?: string | undefined
  readonly fetchOptions?: FetchSiteOptions
  /** Injected in tests. */
  readonly fetchSite?: (domain: string, options?: FetchSiteOptions) => Promise<FetchSiteResult>
  readonly generate?: (input: GenerateInput) => Promise<GeneratedBank | null>
  readonly now?: Date
  readonly log?: (message: string) => void
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THE STORE. Two files, both write-once, both plain JSON.
 *
 * A JSON file rather than Postgres because there is no Postgres on this path:
 * `apps/public` is a static deploy with one route handler and the gate ledgers
 * already live here. When accounts exist this becomes a table with the same two
 * columns and the same write-once rule.
 *
 * ponytail: single-process, last-writer-wins. Two concurrent first-scans of the
 * same brand-new domain can both derive it; both derive the same answer from the
 * same signals, so the loss is one wasted fetch, not an inconsistent record.
 * Upgrade path when this is multi-process: an INSERT ... ON CONFLICT DO NOTHING.
 */

const recordsFile = (dataDir: string): string => join(dataDir, 'domain-categories.json')
const banksDir = (dataDir: string): string => join(dataDir, 'generated-banks')

type RecordStore = Record<string, CategoryRecord>

function readRecords(dataDir: string): RecordStore {
  const f = recordsFile(dataDir)
  try {
    if (!existsSync(f)) return {}
    const parsed: unknown = JSON.parse(readFileSync(f, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: RecordStore = {}
    for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Storage is a trust boundary — a stale build or a hand edit can hold any
      // legal JSON. Same discipline as readAgencyDomains: validate, drop what
      // fails, never throw. A dropped record means the domain is re-derived,
      // which is recoverable; a malformed one crashing the route is not.
      const r = value as Partial<CategoryRecord>
      if (typeof r.slug === 'string' && r.slug && typeof r.source === 'string') {
        out[host] = {
          host,
          slug: r.slug,
          source: r.source as CategorySource,
          evidence: typeof r.evidence === 'string' ? r.evidence : '',
          decidedAt: typeof r.decidedAt === 'string' ? r.decidedAt : '',
          generated: r.generated === true,
        }
      }
    }
    return out
  } catch {
    // Unparseable. Re-deriving is the safe failure: it costs one fetch and
    // cannot produce a wrong answer, whereas trusting a corrupt file could.
    return {}
  }
}

export function readCategoryRecord(dataDir: string, domain: string): CategoryRecord | null {
  const host = normaliseHost(domain)
  return host ? (readRecords(dataDir)[host] ?? null) : null
}

/**
 * Write a domain's category, ONCE.
 *
 * An existing record is returned unchanged rather than overwritten, and that
 * refusal IS the stability guarantee — not a convention anyone has to remember.
 * Changing a domain's category is therefore a deliberate act against the file,
 * with the version bump and history that implies, exactly as R5 requires of a
 * score row.
 */
export function recordCategory(dataDir: string, record: CategoryRecord): CategoryRecord {
  const store = readRecords(dataDir)
  const existing = store[record.host]
  if (existing) return existing
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(recordsFile(dataDir), JSON.stringify({ ...store, [record.host]: record }, null, 2) + '\n')
  return record
}

/** A generated bank, on disk, paired with the category the classifier sees. */
export interface GeneratedBankFile {
  readonly category: CategoryDef
  readonly bank: PromptBank
}

/** Every bank generated so far. Read on each resolve so a sibling process's writes are seen. */
export function readGeneratedBanks(dataDir: string): readonly GeneratedBankFile[] {
  const dir = banksDir(dataDir)
  if (!existsSync(dir)) return []
  const out: GeneratedBankFile[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<GeneratedBankFile>
      const bank = parsed.bank
      const category = parsed.category
      // The invariant is re-checked on READ as well as on write. A file edited
      // by hand to add leaders would otherwise put invented competitors into a
      // chart, which is the one outcome this module exists to prevent.
      if (!bank || !category || !Array.isArray(bank.prompts) || bank.prompts.length === 0) continue
      if (Array.isArray(bank.leaders) && bank.leaders.length > 0) continue
      out.push({ category, bank: { ...bank, leaders: [] } as PromptBank })
    } catch {
      /* a malformed bank file is skipped, not fatal */
    }
  }
  return out
}

function writeGeneratedBank(dataDir: string, file: GeneratedBankFile): void {
  const dir = banksDir(dataDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${file.bank.category}.json`)
  // Write-once, same rule as the record: a second domain landing in a generated
  // category reuses the bank rather than re-authoring it, so the two scans stay
  // comparable to each other.
  if (existsSync(path)) return
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n')
}

/** Banks and taxonomy a scan should run with: the hand-authored set plus everything grown since. */
export function allBanks(dataDir: string): readonly PromptBank[] {
  return [...DEMO_BANKS, ...readGeneratedBanks(dataDir).map((g) => g.bank)]
}

export function allCategories(dataDir: string): readonly CategoryDef[] {
  return [...DEMO_TAXONOMY, ...readGeneratedBanks(dataDir).map((g) => g.category)]
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * RUNG 4 — authoring a bank for a category the taxonomy does not have.
 */

export interface GenerateInput {
  readonly host: string
  readonly title: string
  readonly description: string
  readonly headings: string
  readonly existingSlugs: readonly string[]
  readonly apiKey: string
}

export interface GeneratedBank {
  readonly displayName: string
  readonly description: string
  readonly prompts: readonly { readonly text: string; readonly intent: 'discovery' | 'problem-led' }[]
}

/** `Gaming peripherals` → `gaming-peripherals`. Derived here, never taken from the model. */
export function slugify(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/**
 * Everything a generated bank must satisfy before it is allowed to exist.
 *
 * Returns the reason it is refused, or null. Refusing means falling back, which
 * is the behaviour that shipped before this module existed — so a rejected
 * generation is a no-op, never a degradation.
 */
export function rejectionReason(candidate: GeneratedBank, host: string): string | null {
  if (!candidate.displayName?.trim() || !slugify(candidate.displayName)) return 'no usable category name'
  if (candidate.displayName.length > 60) return 'category name is implausibly long'

  const discovery = candidate.prompts.filter((p) => p.intent === 'discovery')
  const problemLed = candidate.prompts.filter((p) => p.intent === 'problem-led')
  if (discovery.length < GENERATED_DISCOVERY) return `only ${discovery.length} discovery prompts, ${GENERATED_DISCOVERY} needed`
  if (problemLed.length < GENERATED_PROBLEM_LED) return `only ${problemLed.length} problem-led prompts, ${GENERATED_PROBLEM_LED} needed`

  /*
   * THE SUBJECT'S OWN NAME MAY NOT APPEAR IN ITS OWN PROMPTS.
   *
   * This is scan.ts PROPERTY 2 enforced at authoring time. A prompt naming the
   * brand guarantees a mention and reports our own phrasing back as the brand's
   * visibility; share of voice has to be unprompted or it is not share of voice.
   * The whole bank is refused rather than the offending prompt dropped, because
   * a bank that lost three prompts to filtering is a different sample size than
   * the one every other bank has.
   */
  const label = host.split('.')[0] ?? ''
  if (label.length >= 3) {
    const needle = new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    const named = candidate.prompts.find((p) => needle.test(p.text))
    if (named) return `a prompt names the subject brand ("${named.text}"), which would measure our own phrasing`
  }

  const empty = candidate.prompts.find((p) => !p.text?.trim() || p.text.length > 200)
  if (empty) return 'a prompt is empty or over 200 characters'

  const seen = new Set<string>()
  for (const p of candidate.prompts) {
    const key = p.text.trim().toLowerCase()
    if (seen.has(key)) return `duplicate prompt: ${p.text}`
    seen.add(key)
  }
  return null
}

const AUTHORING_SYSTEM = `You author prompt banks for an AI search visibility measurement product.

A prompt bank is the set of questions real buyers type into ChatGPT, Gemini and
Copilot when they are looking for a product in a category — BEFORE they know
which brands exist. We send those questions to the engines and measure which
brands the engines volunteer in reply.

Two intents:
- discovery: someone looking for this kind of product and naming no brand.
  "Best mechanical keyboard for programmers with a quiet switch"
- problem-led: someone describing the problem, not the product category.
  "My wrists hurt after long coding sessions, what should I change about my desk setup"

ABSOLUTE RULES, and a bank breaking any of them is discarded:
1. NEVER name a company, brand, product or vendor in any prompt. Not the site's
   own brand, not a competitor, not a market leader, not an example. A prompt
   that names a brand measures our phrasing instead of the engine's answer, and
   naming competitors we have not measured is the specific dishonesty this
   product exists to argue against.
2. Write questions a BUYER would type, not questions a marketer would write.
   Specific, awkward, concrete. Budgets, constraints, use cases, geographies.
3. The category is the MARKET the business competes in, not the business itself.
   A company selling gaming keyboards is in "gaming peripherals", not in
   "Acme Corp products".
4. No prompt over 200 characters. No duplicates.

You will be given a homepage's own words. Infer the market, then write the bank.`

/**
 * One model call, once per novel category, ever.
 *
 * Not batched, and R2 is not violated: R2 governs SCORING, which is high-volume
 * and latency-insensitive. This is a one-off authoring step on the interactive
 * path — a visitor is waiting for the preview — and there is nothing to batch it
 * with. It runs at most once per category for the lifetime of the taxonomy,
 * because the result is written to disk.
 *
 * The tool has NO competitor field. That is the enforcement: the model is not
 * asked to be trustworthy about leaders, it is structurally unable to supply
 * them.
 */
export async function generateBank(input: GenerateInput): Promise<GeneratedBank | null> {
  const client = new Anthropic({ apiKey: input.apiKey })
  const response = await client.messages.create({
    model: BANK_AUTHOR_MODEL,
    max_tokens: 8_000,
    system: AUTHORING_SYSTEM,
    tool_choice: { type: 'tool', name: 'publish_category' },
    tools: [
      {
        name: 'publish_category',
        description: 'Publish the category and its prompt bank. There is deliberately no field for competitors or leading brands.',
        input_schema: {
          type: 'object',
          properties: {
            display_name: { type: 'string', description: 'The market, in title case, two to four words. e.g. "Gaming peripherals", "Cybersecurity consulting"' },
            description: { type: 'string', description: 'One sentence describing what companies in this category sell.' },
            prompts: {
              type: 'array',
              minItems: GENERATED_DISCOVERY + GENERATED_PROBLEM_LED,
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'The question, verbatim, naming no brand. Under 200 characters.' },
                  intent: { type: 'string', enum: ['discovery', 'problem-led'] },
                },
                required: ['text', 'intent'],
                additionalProperties: false,
              },
            },
          },
          required: ['display_name', 'description', 'prompts'],
          additionalProperties: false,
        },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          `Homepage of ${input.host}.`,
          '',
          `Title: ${input.title || '(none)'}`,
          `Description: ${input.description || '(none)'}`,
          `Headings: ${input.headings.slice(0, 2_000) || '(none)'}`,
          '',
          `Categories that already exist (do not duplicate one of these; if the business genuinely belongs in one, use that exact name): ${input.existingSlugs.join(', ')}`,
          '',
          `Write ${GENERATED_DISCOVERY} discovery prompts and ${GENERATED_PROBLEM_LED} problem-led prompts.`,
        ].join('\n'),
      },
    ],
  })

  const block = response.content.find((b) => b.type === 'tool_use')
  if (!block || block.type !== 'tool_use') return null
  const raw = block.input as Partial<{ display_name: string; description: string; prompts: { text: string; intent: string }[] }>
  if (!Array.isArray(raw.prompts)) return null

  return {
    displayName: String(raw.display_name ?? '').trim(),
    description: String(raw.description ?? '').trim(),
    prompts: raw.prompts
      .filter((p) => typeof p?.text === 'string' && (p.intent === 'discovery' || p.intent === 'problem-led'))
      .map((p) => ({ text: p.text.trim(), intent: p.intent as 'discovery' | 'problem-led' })),
  }
}

const bankFromGenerated = (slug: string, host: string, g: GeneratedBank): GeneratedBankFile => ({
  category: {
    slug,
    displayName: g.displayName,
    description: g.description,
    // NO domain keywords. A generated category is reached through the record or
    // through page content, never by guessing that a host token means this
    // market — that guess is how `compass.com` becomes a password manager, and
    // the hand-authored keyword lists were reviewed for exactly that. An
    // unreviewed list must not be given the same authority.
    domainKeywords: [],
    contentKeywords: [],
  },
  bank: {
    category: slug,
    displayName: g.displayName,
    description: g.description,
    locale: 'en-US',
    geo: 'US',
    version: 1,
    verified: false,
    note: `AUTO-GENERATED from ${host}'s homepage on first scan, because no category in the taxonomy fit it. LEADERS IS EMPTY AND STAYS EMPTY: the prompt set is authored, the competitor set is not, because a competitor that was not measured is a competitor that was invented. Real competitors may only ever arrive from brands the engines actually name in collected answers. verified:false — the prompts are model-authored and have not been reviewed by a human.`,
    leaders: [],
    prompts: g.prompts,
  },
})

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RESOLVER.
 */

export async function resolveCategory(domain: string, deps: ResolveDeps): Promise<ResolvedCategory> {
  const host = normaliseHost(domain)
  const now = deps.now ?? new Date()
  const decidedAt = now.toISOString()
  const log = deps.log ?? (() => {})

  const banks = allBanks(deps.dataDir)
  const taxonomy = allCategories(deps.dataDir)
  const bankFor = (slug: string): PromptBank | undefined => banks.find((b) => b.category === slug)
  const categoryFor = (slug: string): CategoryDef | undefined => taxonomy.find((c) => c.slug === slug)

  const fallbackResult = (reason: 'unclassified' | 'ambiguous', detail: string, candidates: readonly string[]): ResolvedCategory => {
    const record = recordCategory(deps.dataDir, { host, slug: FALLBACK_SLUG, source: 'fallback', evidence: detail, decidedAt, generated: false })
    return {
      record,
      bank: bankFor(record.slug)!,
      category: categoryFor(record.slug)!,
      fallback: { reason, detail, candidates },
    }
  }

  const settle = (slug: string, source: CategorySource, evidence: string, generated = false): ResolvedCategory | null => {
    const bank = bankFor(slug)
    const category = categoryFor(slug)
    // A slug with no bank is a wiring fault, not a user outcome — the same
    // refusal scan.ts makes. Falling through to the fallback here is correct and
    // is NOT recorded, so the next scan re-derives once the wiring is fixed.
    if (!bank || !category) return null
    const record = recordCategory(deps.dataDir, { host, slug, source, evidence, decidedAt, generated })
    const resolvedBank = bankFor(record.slug)
    const resolvedCategory = categoryFor(record.slug)
    if (!resolvedBank || !resolvedCategory) return null
    return record.slug === FALLBACK_SLUG
      ? { record, bank: resolvedBank, category: resolvedCategory, fallback: { reason: 'unclassified', detail: record.evidence, candidates: [] } }
      : { record, bank: resolvedBank, category: resolvedCategory }
  }

  // RUNG 0. Already decided. Nothing is fetched, nothing is generated, nothing
  // moves. This is the guarantee, and it is checked before anything else can
  // cost time or money.
  const existing = readCategoryRecord(deps.dataDir, host)
  if (existing) {
    const bank = bankFor(existing.slug)
    const category = categoryFor(existing.slug)
    if (bank && category) {
      log(`category: ${host} -> ${existing.slug} (from the record, decided ${existing.decidedAt.slice(0, 10)} by ${existing.source})`)
      return existing.slug === FALLBACK_SLUG
        ? { record: existing, bank, category, fallback: { reason: 'unclassified', detail: existing.evidence, candidates: [] } }
        : { record: existing, bank, category }
    }
    // The recorded slug no longer has a bank — a generated bank file was deleted,
    // or the demo taxonomy was replaced. Say so rather than silently re-deriving
    // a DIFFERENT category for a domain that already has history.
    log(`category: ${host} has a record for ${existing.slug} but no bank exists for it; falling back for this scan and leaving the record alone`)
    return { record: existing, bank: bankFor(FALLBACK_SLUG)!, category: categoryFor(FALLBACK_SLUG)!, fallback: { reason: 'unclassified', detail: `the recorded category ${existing.slug} has no prompt bank in this build`, candidates: [] } }
  }

  // RUNGS 1 AND 2. Free and deterministic, so always first.
  const byDomain = classifyDomain(host, banks, taxonomy)
  if (byDomain.status === 'classified') {
    const settled = settle(byDomain.slug, byDomain.signal, byDomain.evidence)
    if (settled) {
      log(`category: ${host} -> ${byDomain.slug} (${byDomain.signal}: ${byDomain.evidence})`)
      return settled
    }
  }
  if (byDomain.status === 'ambiguous') {
    // NOT overridden by content, and deliberately. `zoho.com` genuinely leads
    // three of these categories; that is information, not a failure, and page
    // content would resolve it by picking whichever product the homepage
    // happens to feature this quarter. Recorded as ambiguous so it stays that
    // way, and carried into the result so the page can say which three.
    const record = recordCategory(deps.dataDir, { host, slug: FALLBACK_SLUG, source: 'fallback', evidence: byDomain.evidence, decidedAt, generated: false })
    log(`category: ${host} -> fallback (ambiguous across ${byDomain.candidates.join(', ')})`)
    return { record, bank: bankFor(FALLBACK_SLUG)!, category: categoryFor(FALLBACK_SLUG)!, fallback: { reason: 'ambiguous', detail: byDomain.evidence, candidates: byDomain.candidates } }
  }

  // RUNG 3. The homepage. One GET, hard-bounded, through the SSRF boundary.
  const fetchSite = deps.fetchSite ?? fetchSiteHtml
  const fetched = await fetchSite(host, deps.fetchOptions)
  if (!fetched.ok) {
    log(`category: ${host} homepage not read (${fetched.reason}: ${fetched.message})`)
    return fallbackResult('unclassified', `no known brand or category keyword in the domain, and its homepage could not be read (${fetched.message})`, [])
  }

  const text = extractSiteText(fetched.html)
  const byContent = classifyContent(text, taxonomy)
  if (byContent.status === 'classified') {
    const settled = settle(byContent.slug, 'site-content', byContent.evidence)
    if (settled) {
      log(`category: ${host} -> ${byContent.slug} (site-content: ${byContent.evidence})`)
      return settled
    }
  }
  if (byContent.status === 'ambiguous') {
    const record = recordCategory(deps.dataDir, { host, slug: FALLBACK_SLUG, source: 'fallback', evidence: byContent.evidence, decidedAt, generated: false })
    log(`category: ${host} -> fallback (page content ambiguous: ${byContent.evidence})`)
    return { record, bank: bankFor(FALLBACK_SLUG)!, category: categoryFor(FALLBACK_SLUG)!, fallback: { reason: 'ambiguous', detail: byContent.evidence, candidates: byContent.candidates } }
  }

  // RUNG 4. Nothing in the taxonomy fits. Grow it.
  //
  // Hoisted out of the narrowing above because `settle` can decline (a slug with
  // no bank), so a `classified` content result can still reach this line. The
  // second arm names that wiring fault rather than reporting it as weak evidence.
  const weakReason = byContent.status === 'weak' ? byContent.reason : `the page resolved to ${byContent.status === 'classified' ? byContent.slug : 'a category'} but no bank exists for it`

  if (!deps.anthropicApiKey) {
    log(`category: ${host} would need a new category, but no ANTHROPIC_API_KEY is configured`)
    return fallbackResult('unclassified', `${weakReason}, and no key is configured to author a new category`, [])
  }

  let candidate: GeneratedBank | null = null
  try {
    candidate = await (deps.generate ?? generateBank)({
      host,
      title: text.title,
      description: text.description,
      headings: text.headings,
      existingSlugs: taxonomy.map((c) => c.slug),
      apiKey: deps.anthropicApiKey,
    })
  } catch (e) {
    // Authoring is best-effort by design. It failing must degrade to the
    // behaviour that shipped before it existed, never to a broken scan.
    log(`category: authoring a bank for ${host} failed (${(e as Error).message})`)
    return fallbackResult('unclassified', `${weakReason}, and a new category could not be authored (${(e as Error).message})`, [])
  }
  if (!candidate) return fallbackResult('unclassified', `${weakReason}, and no new category was produced`, [])

  const refused = rejectionReason(candidate, host)
  if (refused) {
    log(`category: the authored bank for ${host} was refused (${refused})`)
    return fallbackResult('unclassified', `${weakReason}, and the authored category was refused: ${refused}`, [])
  }

  const slug = slugify(candidate.displayName)
  // The model was shown the existing slugs and told to reuse one if it fits. If
  // it named an existing category, that is the right answer and no bank is
  // written — the domain joins the reviewed bank rather than a duplicate of it.
  const already = taxonomy.find((c) => c.slug === slug)
  if (already) {
    const settled = settle(slug, 'site-content', `the homepage describes ${already.displayName}`)
    if (settled) {
      log(`category: ${host} -> ${slug} (authoring named an existing category)`)
      return settled
    }
  }

  writeGeneratedBank(deps.dataDir, bankFromGenerated(slug, host, candidate))
  // Re-read rather than trusting the in-memory value: if a concurrent resolve
  // wrote this slug first, the bank on disk is the one every other scan will
  // use, and this scan must use the same one or the two are not comparable.
  const written = readGeneratedBanks(deps.dataDir).find((g) => g.bank.category === slug)
  if (!written) return fallbackResult('unclassified', `${weakReason}, and the authored category could not be stored`, [])

  const record = recordCategory(deps.dataDir, { host, slug, source: 'generated', evidence: `authored from ${host}'s homepage`, decidedAt, generated: true })
  log(`category: ${host} -> ${slug} (generated: ${candidate.displayName}, ${candidate.prompts.length} prompts, no competitors)`)
  return { record, bank: written.bank, category: written.category }
}
