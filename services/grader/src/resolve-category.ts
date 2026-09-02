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
import { domainBrandForms, findMentions, normaliseForMatch, squash, type BrandSpec } from '@bliprank/scorer'
import { fetchSiteHtml, type FetchSiteOptions, type FetchSiteResult } from './fetch-site.js'
import { readPromoted } from './promote-competitors.js'
import {
  GENERATED_DISCOVERY,
  GENERATED_PROBLEM_LED,
  authorBank,
  type BankAuthorConfig,
  type GenerateInput,
  type GeneratedBank,
} from './bank-author.js'

/**
 * Re-exported so a caller needs one import for the ladder and its constants.
 * The counts live with the author because they are what a bank is validated
 * against, and the validation is there.
 */
export { GENERATED_DISCOVERY, GENERATED_PROBLEM_LED, type BankAuthorConfig, type GeneratedBank } from './bank-author.js'

/**
 * HOW a category was decided — permanent, and never `record`.
 *
 * Reading a decision back does not change how it was made, so a later resolve
 * still reports `leader-domain` or `generated`. WHETHER this particular call
 * read it back is `ResolvedCategory.fromRecord`, which is a different fact:
 * provenance is about the decision, freshness is about this lookup, and
 * collapsing them loses the one a reader actually wants first.
 */
export type CategorySource = 'leader-domain' | 'domain-token' | 'site-content' | 'generated' | 'fallback'

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
  /**
   * The brand's trading name, corroborated once from the site's own title.
   *
   * RECORDED, for the same reason the category is: `subjectFor` turns it into a
   * match alias, so a homepage rewritten on a Tuesday would otherwise change
   * what a historical number was measuring. Written when the homepage was read;
   * absent on a decision made without one, where the domain-derived forms carry
   * the match on their own.
   */
  readonly brandName?: string
}

export interface ResolvedCategory {
  readonly record: CategoryRecord
  readonly bank: PromptBank
  readonly category: CategoryDef
  /**
   * True when this call READ the decision rather than making it.
   *
   * The visible half of the stability guarantee: a surface can say "decided on
   * 12 March and reused since" instead of implying every scan re-derives the
   * category. Nothing was fetched and nothing was authored when this is true.
   */
  readonly fromRecord: boolean
  /** Set when the resolved bank is the fallback, carrying why. Mirrors `ScanResult.fallback`. */
  readonly fallback?: { readonly reason: 'unclassified' | 'ambiguous'; readonly detail: string; readonly candidates: readonly string[] }
}

export interface ResolveDeps {
  /** Where records and generated banks live. Same dir the gate ledgers use. */
  readonly dataDir: string
  /**
   * Which model authors a bank, and where it lives.
   *
   * Absent disables rung 4 entirely and the resolver falls back exactly as it
   * did before authoring existed — the same degradation as an author that fails,
   * so "no key configured" and "the free tier is down" reach the customer as one
   * outcome rather than two. Built by `bankAuthorConfig` from the environment,
   * so swapping models is an env edit (ADR-0009 Amendment 1).
   */
  readonly author?: BankAuthorConfig | undefined
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
          ...(typeof r.brandName === 'string' && r.brandName ? { brandName: r.brandName } : {}),
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
 * Every domain placed in one category, with its recorded trading name.
 *
 * Exported so competitor promotion can ask "who is the SUBJECT here" without a
 * second module learning where the record file lives or how a malformed one is
 * tolerated. A domain must never be proposed as its own competitor, and the
 * records are the only place that says which domains a category holds.
 */
export function recordedIn(dataDir: string, slug: string): readonly CategoryRecord[] {
  return Object.values(readRecords(dataDir)).filter((r) => r.slug === slug)
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

/**
 * Every bank generated so far. Read on each resolve so a sibling process's
 * writes are seen.
 *
 * ⚠️ THE LEADERS REFUSAL BELOW IS UNCHANGED AND STAYS UNCHANGED. ADR-0009's
 * third refusal — a generated bank file that has acquired any leaders is
 * DROPPED — is what stops a hand-edited file putting invented rivals on a
 * chart, and promotion did not weaken it. Promoted competitors live in their
 * own file, where every entry carries the collected answers it was learned from
 * (`promote-competitors.ts`), and are merged in AFTER this check. So a leader
 * reaches a chart by exactly one route, and it is the route with evidence
 * attached.
 */
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
      out.push({ category, bank: withPromoted(dataDir, { ...bank, leaders: [] } as PromptBank) })
    } catch {
      /* a malformed bank file is skipped, not fatal */
    }
  }
  return out
}

/**
 * Attach this category's PROMOTED competitors, if any have been promoted.
 *
 * ⚠️ THE ONLY WAY A GENERATED BANK EVER ACQUIRES A LEADER, and the reason it is
 * safe is that it does not read the bank file. `readPromoted` reads a separate
 * store in which every entry carries the collected answers it was learned from,
 * and drops any entry that does not. So the three refusals ADR-0009 built around
 * `leaders` are all still in force over the bank file, unweakened, and the one
 * path that adds a rival is the one that cannot be walked without evidence.
 *
 * THE VERSION MOVES WITH THE LEADERS. `comparisonBasisFor` stamps
 * `slug@version` into every metric, and adding competitors changes `position`
 * and therefore the preview score. A scan from before promotion and one from
 * after are not measurements of the same thing; carrying the promoted version
 * here is what makes `compare()` refuse to put them side by side instead of
 * reporting the difference as movement.
 */
function withPromoted(dataDir: string, bank: PromptBank): PromptBank {
  const promoted = readPromoted(dataDir, bank.category)
  if (!promoted || promoted.leaders.length === 0) return bank
  // `evidence` is stripped: a `Leader` has no such field, and the store is where
  // the evidence lives. Carrying it into the bank would put an unversioned blob
  // into `comparison_basis`'s neighbourhood for no reader's benefit.
  const leaders = promoted.leaders.map(({ id, name, aliases, domains }) => ({ id, name, aliases, domains }))
  return { ...bank, version: promoted.bankVersion, leaders }
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

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * RUNG 4 — authoring a bank for a category the taxonomy does not have.
 *
 * The model call itself lives in `bank-author.ts`, behind a provider seam, so
 * that swapping a rate-limited free tier is an environment edit rather than a
 * deploy. What stays here is everything that decides whether the answer is
 * ALLOWED TO EXIST, which is the part that must not vary by provider.
 */

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
 *
 * PROVIDER-INDEPENDENT ON PURPOSE. A forced tool call and a free model's loose
 * JSON both arrive here, and neither gets a weaker check than the other: a
 * schema that constrains the request is a convenience, not a guarantee, and the
 * guarantee has to hold for whichever model the environment happens to name
 * today.
 */
/**
 * Every brand the taxonomy already tracks, as the scorer's own `BrandSpec`.
 *
 * One entry per leader across every bank, deduplicated by id - a leader listed
 * in two banks is one brand, and matching it twice would only make the refusal
 * message repeat itself.
 *
 * `domains` is deliberately empty. This matches PROSE, not citations: a prompt
 * cannot cite anything, and carrying the domains would tempt a later reader into
 * using this list for attribution, which is the one job `Leader.domains` is
 * narrowed for.
 */
export function trackedBrands(banks: readonly PromptBank[]): readonly BrandSpec[] {
  const byId = new Map<string, BrandSpec>()
  for (const bank of banks) {
    for (const l of bank.leaders) {
      if (byId.has(l.id)) continue
      /*
       * ⚠️ THE ALIAS TABLE, AND ONLY THE ALIAS TABLE. The bare `l.name` used to
       * be added on the reasoning that "a bank may list `HubSpot` as the name
       * and only `HubSpot CRM` as an alias, and the bare name is the form a
       * generated prompt is most likely to use". That override threw away the
       * one piece of curation that matters here.
       *
       * Across the taxonomy, 104 leaders DO list their bare name among their
       * aliases and 12 deliberately do not — and all twelve are ordinary English
       * words: Wave, Sage, Amplitude, Plausible, Heap, Close, Kit, Crisp,
       * Notion, Moz, Zoom, Durable. Somebody wrote "wave accounting" and
       * "convertkit" and stopped short of "wave" and "kit" on purpose. Injecting
       * the name put those bare words back and made them refusal triggers.
       *
       * What that cost, in production: kreo-tech.com, a real gaming-peripherals
       * retailer, had a perfectly good authored bank DISCARDED because one
       * prompt said "best softbox lighting kit for tiktok videos" and `kit`
       * matched the brand Kit. The domain fell through to the general
       * business-software bank and was asked "what software should a small
       * business buy first" — a wrong measurement caused by a refusal that was
       * protecting an email-marketing tool from a sentence about lighting.
       *
       * HubSpot is still caught, because HubSpot's table lists `hubspot`. The
       * data already answers the question; this used to overrule it.
       */
      const aliases = [...new Set(l.aliases.map((a) => a.trim()).filter(Boolean))]
      byId.set(l.id, { id: l.id, name: l.name, aliases, domains: [] })
    }
  }
  return [...byId.values()]
}

/**
 * Does this prompt name a brand the taxonomy already tracks?
 *
 * MATCHED WITH THE SCORER'S OWN MATCHER, NOT A SECOND ONE.
 *
 * `findMentions` is the function that decides whether a brand counts as
 * mentioned in a collected answer. Using it here means the refusal and the
 * measurement share one definition of "this text names that brand" - including
 * the whole-token boundaries that stop `Zoho1` matching `Zoho`, the NFKC
 * folding, and the longest-match-wins overlap rule. A hand-rolled `includes()`
 * here would be a second definition, and the two would drift in the direction
 * that lets something through.
 *
 * Returns the brand's name and the alias that matched, so the refusal can say
 * exactly what it saw.
 */
export function namesTrackedBrand(text: string, brands: readonly BrandSpec[]): { name: string; alias: string } | null {
  const normalised = normaliseForMatch(text)
  for (const brand of brands) {
    const hit = findMentions(normalised, brand)
    if (hit) return { name: hit.name, alias: hit.matchedAlias }
  }
  return null
}

export function rejectionReason(candidate: GeneratedBank, host: string, banks: readonly PromptBank[] = []): string | null {
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
  /*
   * ⚠️ THE SAME BLIND SPOT THAT CAUSED THE FALSE ZERO, POINTED THE OTHER WAY.
   *
   * This tested `\bthecosmicbyte\b` — the literal concatenated label. Every
   * engine, and every model writing prompts from that homepage, writes "Cosmic
   * Byte" with a space, and a spaced form does not match a concatenated regex.
   * So the guard that exists to stop a prompt naming the subject would have
   * waved through "best Cosmic Byte gaming headset under 3000" — guaranteeing
   * the brand a mention in its own measurement, which is the exact failure
   * PROPERTY 2 refuses.
   *
   * One root cause, two victims: `subjectFor` could not FIND the brand, and
   * this could not REFUSE it. Both now go through the same alias derivation, so
   * a fix to one is a fix to both.
   */
  const forms = domainBrandForms(host)
  const subjectSpec: BrandSpec = { id: 'subject', name: forms.name, aliases: forms.aliases, squashedAliases: forms.squashedAliases, domains: [host] }
  for (const p of candidate.prompts) {
    if (findMentions(normaliseForMatch(p.text), subjectSpec)) {
      return `a prompt names the subject brand ("${p.text}"), which would measure our own phrasing`
    }
  }

  /*
   * NOR MAY IT NAME A BRAND WE ALREADY TRACK SOMEWHERE ELSE.
   *
   * The check above catches the subject naming ITSELF. This one catches the
   * subject's prompts naming somebody else's tracked brand, which is the same
   * failure pointed at a different victim - and it is the one an author will
   * actually produce, because a model writing buyer questions reaches for the
   * brands buyers know.
   *
   * Two distinct harms, and it is worth being clear that they are different:
   *
   *   MEASUREMENT. Every prompt a scan sends is `discovery` or `problem-led`
   *   precisely so it names no brand (scan.ts PROPERTY 2). A prompt naming
   *   HubSpot guarantees HubSpot a mention in the answer, and HubSpot is scored
   *   as a leader of crm-software - so an authored bank could silently move a
   *   TRACKED brand's mention rate by asking about it. Share of voice has to be
   *   unprompted or it is not share of voice, and that holds for every brand in
   *   the answer, not only for the one being graded.
   *
   *   HONESTY. `/category-bank`'s do-not-invent rule exists so a rival never
   *   appears beside a number nobody measured them against. A generated prompt
   *   reading "how does this compare to Salesforce" reintroduces exactly that,
   *   through the prompt TEXT instead of through `leaders` - and would have
   *   walked straight past all three refusals that guard `leaders`.
   *
   * THE LIST IS WHAT MAKES THIS SAFE, AND ITS LIMITS ARE THE DESIGN.
   *
   * It refuses only brands ALREADY ON FILE. `ERPNext` and `Frappe` are in no
   * leader table, so an ERP-implementation bank may name them - correctly,
   * because they are the platform the market is defined BY, the way "WordPress
   * hosting" is a real category, and naming one is not naming a rival. Nothing
   * here tries to detect brands in general: that is not a decidable check, and a
   * heuristic that guessed would refuse good banks for imagined reasons.
   *
   * So this is a partial guard, deliberately, over the subset that IS decidable -
   * and it is the subset that matters, because the brands whose mention rates we
   * publish are exactly the brands a prompt must not conjure.
   */
  const tracked = trackedBrands(banks)
  for (const p of candidate.prompts) {
    const named = namesTrackedBrand(p.text, tracked)
    // The WHOLE BANK, not the offending prompt, for the reason the check above
    // gives: a bank that lost prompts to filtering is a different sample size
    // from every other bank, and `n` is not something to lose quietly.
    if (named) {
      return `a prompt names ${named.name}, a brand this taxonomy already tracks ("${p.text}" matched "${named.alias}") - a prompt that names a brand guarantees it a mention`
    }
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
    note: `AUTO-GENERATED by ${g.model} from ${host}'s homepage on first scan, because no category in the taxonomy fit it. LEADERS IS EMPTY AND STAYS EMPTY: the prompt set is authored, the competitor set is not, because a competitor that was not measured is a competitor that was invented. Real competitors may only ever arrive from brands the engines actually name in collected answers. verified:false — the prompts are model-authored and have not been reviewed by a human.`,
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
      fromRecord: false,
      fallback: { reason, detail, candidates },
    }
  }

  /*
   * The trading name, corroborated from the site's own title — set once the
   * homepage has been read, and read by `settle` below.
   *
   * A closure variable rather than a fifth parameter because only the rungs
   * BELOW the fetch can have one: rungs 1 and 2 settle before any HTTP happens,
   * and there is nothing for them to pass. It stays undefined on those paths,
   * which is exactly right — the domain-derived forms carry the match alone.
   */
  let siteBrandName: string | undefined

  const settle = (slug: string, source: CategorySource, evidence: string, generated = false): ResolvedCategory | null => {
    const bank = bankFor(slug)
    const category = categoryFor(slug)
    // A slug with no bank is a wiring fault, not a user outcome — the same
    // refusal scan.ts makes. Falling through to the fallback here is correct and
    // is NOT recorded, so the next scan re-derives once the wiring is fixed.
    if (!bank || !category) return null
    const record = recordCategory(deps.dataDir, { host, slug, source, evidence, decidedAt, generated, ...(siteBrandName ? { brandName: siteBrandName } : {}) })
    const resolvedBank = bankFor(record.slug)
    const resolvedCategory = categoryFor(record.slug)
    if (!resolvedBank || !resolvedCategory) return null
    return record.slug === FALLBACK_SLUG
      ? { record, bank: resolvedBank, category: resolvedCategory, fromRecord: false, fallback: { reason: 'unclassified', detail: record.evidence, candidates: [] } }
      : { record, bank: resolvedBank, category: resolvedCategory, fromRecord: false }
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
        ? { record: existing, bank, category, fromRecord: true, fallback: { reason: 'unclassified', detail: existing.evidence, candidates: [] } }
        : { record: existing, bank, category, fromRecord: true }
    }
    // The recorded slug no longer has a bank — a generated bank file was deleted,
    // or the demo taxonomy was replaced. Say so rather than silently re-deriving
    // a DIFFERENT category for a domain that already has history.
    log(`category: ${host} has a record for ${existing.slug} but no bank exists for it; falling back for this scan and leaving the record alone`)
    return { record: existing, bank: bankFor(FALLBACK_SLUG)!, category: categoryFor(FALLBACK_SLUG)!, fromRecord: true, fallback: { reason: 'unclassified', detail: `the recorded category ${existing.slug} has no prompt bank in this build`, candidates: [] } }
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
    return { record, bank: bankFor(FALLBACK_SLUG)!, category: categoryFor(FALLBACK_SLUG)!, fromRecord: false, fallback: { reason: 'ambiguous', detail: byDomain.evidence, candidates: byDomain.candidates } }
  }

  // RUNG 3. The homepage. One GET, hard-bounded, through the SSRF boundary.
  const fetchSite = deps.fetchSite ?? fetchSiteHtml
  const fetched = await fetchSite(host, deps.fetchOptions)
  if (!fetched.ok) {
    log(`category: ${host} homepage not read (${fetched.reason}: ${fetched.message})`)
    return fallbackResult('unclassified', `no known brand or category keyword in the domain, and its homepage could not be read (${fetched.message})`, [])
  }

  const text = extractSiteText(fetched.html)

  /*
   * ⚠️ THE FALSE ZERO, HALF TWO. The homepage has just been read, and its title
   * is the one place the brand's real trading name is stated by the brand
   * itself. `domainBrandForms` accepts it only as CORROBORATION: a phrase is
   * taken as the name solely when it squashes to the domain label (optionally
   * minus a leading `the`/`get`/`use`). "Cosmic Byte" in thecosmicbyte.com's
   * title qualifies; "Best Gaming Gear in India" does not, and contributes
   * nothing. So this can sharpen a name, never invent one.
   *
   * Recorded through `settle`, so a re-scan that reads the decision scores
   * identically to the scan that made it (R5).
   */
  const derived = domainBrandForms(host, `${text.title} ${text.description}`)
  if (derived.name !== squash(derived.name)) siteBrandName = derived.name

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
    return { record, bank: bankFor(FALLBACK_SLUG)!, category: categoryFor(FALLBACK_SLUG)!, fromRecord: false, fallback: { reason: 'ambiguous', detail: byContent.evidence, candidates: byContent.candidates } }
  }

  // RUNG 4. Nothing in the taxonomy fits. Grow it.
  //
  // Hoisted out of the narrowing above because `settle` can decline (a slug with
  // no bank), so a `classified` content result can still reach this line. The
  // second arm names that wiring fault rather than reporting it as weak evidence.
  const weakReason = byContent.status === 'weak' ? byContent.reason : `the page resolved to ${byContent.status === 'classified' ? byContent.slug : 'a category'} but no bank exists for it`

  if (!deps.author) {
    log(`category: ${host} would need a new category, but no bank-author model is configured`)
    return fallbackResult('unclassified', `${weakReason}, and no model is configured to author a new category`, [])
  }

  let candidate: GeneratedBank | null = null
  try {
    candidate = await (deps.generate ?? authorBank)({
      host,
      title: text.title,
      description: text.description,
      headings: text.headings,
      existingSlugs: taxonomy.map((c) => c.slug),
      config: deps.author,
      log,
    })
  } catch (e) {
    // Authoring is best-effort by design. It failing must degrade to the
    // behaviour that shipped before it existed, never to a broken scan.
    log(`category: authoring a bank for ${host} failed (${(e as Error).message})`)
    return fallbackResult('unclassified', `${weakReason}, and a new category could not be authored (${(e as Error).message})`, [])
  }
  if (!candidate) return fallbackResult('unclassified', `${weakReason}, and no new category was produced`, [])

  // The banks in scope for THIS resolve, so a category authored earlier in the
  // same session is covered too. Its leaders are always empty so it contributes
  // nothing, but the list must not depend on load order.
  const refused = rejectionReason(candidate, host, banks)
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

  // The model goes ON THE RECORD, not only in a log. A category authored by a
  // free tier in September and one authored by Sonnet in December are different
  // artefacts, and a reader looking at a surprising bank two years from now
  // should be able to see which produced it. Same discipline as R8's
  // `algo_version` travelling with a metric.
  const record = recordCategory(deps.dataDir, { host, slug, source: 'generated', evidence: `authored from ${host}'s homepage by ${candidate.model}`, decidedAt, generated: true, ...(siteBrandName ? { brandName: siteBrandName } : {}) })
  log(`category: ${host} -> ${slug} (generated by ${candidate.model}: ${candidate.displayName}, ${candidate.prompts.length} prompts, no competitors)`)
  return { record, bank: written.bank, category: written.category, fromRecord: false }
}
