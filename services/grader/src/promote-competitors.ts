/**
 * ADR-0009's unbuilt half — where a generated category's competitors come from.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS IMPLEMENTS, VERBATIM FROM ADR-0009:
 *
 *   "Real competitors may only ever arrive later, from brands the engines
 *    actually named in answers we actually collected."
 *
 * The ADR enforced the first half — three independent refusals stop a model, a
 * response and a hand-edited file from putting a rival in `leaders` — and left
 * the second half undesigned. So an authored category carried `leaders: []`
 * permanently, and a customer in one saw "no comparison on this scan" forever,
 * while the answers we had already bought for them named six real competing
 * products by name.
 *
 * This is the second half. Nothing here invents a name. Every candidate is a
 * string that appeared in a stored answer, and every candidate carries the
 * answers it appeared in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ NO MODEL, ANYWHERE ON THIS PATH — R1, and not for the cost reason.
 *
 * Competitor detection is named in R1 as deterministic-first alongside mention
 * and citation. Asking a model "which of these are product names" would be one
 * cheap call, and it would make the competitor SET non-reproducible — and the
 * competitor set decides `position`, which decides the preview score, which is
 * on the sheet. Two runs over one corpus must yield one answer.
 *
 * So extraction is markdown shape plus arithmetic. It is a HEURISTIC and is
 * labelled one everywhere it surfaces; what makes it safe is not its precision
 * but the two things around it — a corpus-wide evidence bar that noise does not
 * clear, and a human who presses `--apply`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO CLASSES OF CANDIDATE, AND THEY ARE NOT EQUALLY GOOD.
 *
 *   `tracked`   — a brand already in a leader table somewhere in the taxonomy,
 *                 found with `findMentions`: the SAME matcher that decides
 *                 whether a brand counts as mentioned in a scored answer. It
 *                 brings a reviewed alias set with it. Highest confidence, and
 *                 it inherits ADR-0009 Amendment 2's known defect: five leaders
 *                 (Wave, Sage, Notion, Asana, Close) list bare aliases that are
 *                 ordinary English, and `Close` collides with the accounting
 *                 sense of "monthly close". The report prints the matched alias
 *                 and a quoted excerpt for exactly this reason.
 *
 *   `extracted` — a name nothing tracks yet, lifted from the shapes engines use
 *                 to list products: bold spans, headings, and the first column
 *                 of a comparison table. No alias set exists, so the alias list
 *                 is the name itself.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ `domains: []`, ALWAYS, ON A PROMOTED LEADER.
 *
 * `Leader.domains` is the citation-attribution list, and the docblock on it is
 * emphatic that it is deliberately narrow — `crm.zoho.com`, never the apex —
 * because a wrong entry credits somebody else's citation to this brand. We
 * learned a promoted name from prose; prose cites nothing. Guessing
 * `ornexa.com` from "Ornexa" is precisely the invention this whole module exists
 * not to commit, and ADR-0005 already refuses to bucket an unknown citation.
 * A promoted competitor is therefore comparable on MENTIONS and is silent on
 * citations, which is the honest shape of what was learned.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalisePrompt } from '@bliprank/contracts'
import { SCORING_ALGO_VERSION, findMentions, normaliseForMatch, squash, type BrandSpec } from '@bliprank/scorer'
import type { Leader } from '@bliprank/taxonomy'

/** One collected answer, reduced to what promotion reads. */
export interface AnswerSample {
  readonly text: string
  readonly prompt: string
  readonly engine: string
}

export interface CompetitorEvidence {
  /** How the name was found. See the two classes above. */
  readonly source: 'tracked' | 'extracted'
  /** Distinct answers the name appeared in. */
  readonly answers: number
  /** Distinct prompts, and distinct engines, those answers came from. */
  readonly prompts: number
  readonly engines: number
  /** The engine ids, so a one-engine candidate is visible as one at a glance. */
  readonly engineIds: readonly string[]
  /** The alias that matched (tracked), or the surface form seen (extracted). */
  readonly matchedAs: string
  /** One answer excerpt around the first hit, for the human who presses --apply. */
  readonly excerpt: string
}

export interface CompetitorCandidate {
  readonly name: string
  readonly evidence: CompetitorEvidence
}

/**
 * THE EVIDENCE BAR — the part that makes a heuristic safe enough to show a human.
 *
 * ⚠️ THE ENGINE COUNT IS THE LOAD-BEARING ONE. A single engine inventing a
 * plausible product name is the failure mode that matters: it is fluent, it is
 * repeatable within that engine, and it will clear an answer count and a prompt
 * count on its own. Two engines independently naming the same string is a much
 * harder thing to fake, because they are separate systems over separate indexes.
 *
 * Deliberately NOT tuned against a labelled set, and that is stated rather than
 * hidden — the same admission ADR-0009 makes about the classifier thresholds.
 * These are floors chosen to be obviously conservative on one real corpus, and
 * everything they let through is dry-run output that a human reads before
 * anything is written.
 */
export interface PromotionThresholds {
  readonly minAnswers: number
  readonly minPrompts: number
  readonly minEngines: number
}

export const DEFAULT_THRESHOLDS: PromotionThresholds = { minAnswers: 3, minPrompts: 2, minEngines: 2 }

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * EXTRACTION.
 */

/** Longest a product name is allowed to be. Past this it is a sentence. */
const MAX_NAME_CHARS = 40
const MAX_NAME_WORDS = 5

/**
 * Punctuation that says "this bold span is a phrase, not a name".
 *
 * Engines bold whole clauses constantly — "**gold/purity/weight inventory,
 * barcode tagging, making charges**" — and every one of them carries a comma, a
 * slash or a plus. Product names essentially never do. This one rule removes
 * most of the noise in a real answer before any counting happens.
 */
const PHRASE_PUNCTUATION = /[,;:/+?!"'’“”()[\]{}<>|%°×]|\.\s|\s-\s|—/

/** Markdown decorations to peel before a span is judged. */
const strip = (s: string): string =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [Name](url) -> Name
    .replace(/[*_`]/g, '')
    .replace(/^\s*\d+[.)]\s*/, '') // "1. Ornexa" -> "Ornexa"
    .replace(/^#+\s*/, '')
    .replace(/[.\s]+$/, '')
    .trim()

/**
 * Is this string shaped like a product name rather than like prose?
 *
 * Every rule here removes a specific thing seen in a real collected answer.
 * None of them is a judgement about the market — that is the point: this
 * function must not be able to prefer one brand over another, only a NAME over
 * a SENTENCE.
 */
export function looksLikeName(raw: string): boolean {
  const s = strip(raw)
  if (s.length < 3 || s.length > MAX_NAME_CHARS) return false
  if (PHRASE_PUNCTUATION.test(s)) return false
  if (s.split(/\s+/).length > MAX_NAME_WORDS) return false
  // Must OPEN like a name. "the best option" and "✅" both fail here.
  if (!/^[A-Z0-9]/.test(s)) return false
  /*
   * At least one lowercase letter, and this rule is doing real work.
   * A jewellery-ERP answer is dense with ERP, POS, GST, HUID, RFID, CRM, URD —
   * category vocabulary in caps, never a brand. Requiring a lowercase letter
   * removes all of them, and costs nothing real: a genuine all-caps brand still
   * arrives through the `tracked` path if anyone has ever reviewed it, and a
   * bare acronym is not a name a comparison could be defended on anyway.
   */
  if (!/[a-z]/.test(s)) return false
  /*
   * At least one run of three letters, which removes the OTHER thing engines
   * bold constantly: a measurement. A gaming-peripherals corpus is full of
   * "37g", "39g", "54 g", "50–60g" — bold, title-shaped, and units rather than
   * names. Every real brand seen in the corpus survives this, including the
   * digit-initial ones ("24KaratSolutions", "8BitDo Pro 2"), because a name has
   * a word in it and a weight does not.
   */
  if (!/[A-Za-z]{3}/.test(s)) return false
  return true
}

/**
 * Candidate names in one answer, from the three shapes engines list products in.
 *
 * Shapes, not vocabulary. An engine writing a shortlist puts each product in a
 * bold span, a heading, or the first cell of a comparison table, and it does
 * that whatever the category is — which is why this needs no per-category
 * tuning and cannot acquire a per-category opinion.
 */
export function extractCandidates(text: string): readonly string[] {
  const seen = new Map<string, string>()
  const add = (raw: string) => {
    const s = strip(raw)
    if (!looksLikeName(s)) return
    // Keyed on the squashed form so "24KaratSolutions" and "24 Karat Solutions"
    // are one candidate rather than two halves of one piece of evidence.
    const key = squash(s)
    if (key && !seen.has(key)) seen.set(key, s)
  }

  for (const m of text.matchAll(/\*\*([^*\n]{2,80})\*\*/g)) add(m[1] ?? '')
  for (const m of text.matchAll(/^#{1,6}\s+(.{2,80})$/gm)) add(m[1] ?? '')
  // The first cell of a markdown table row. `| --- |` separators strip to ''.
  for (const m of text.matchAll(/^\s*\|([^|\n]{2,80})\|/gm)) add(m[1] ?? '')

  return [...seen.values()]
}

/** ~120 characters of the answer around the first hit, for the human to read. */
function excerptAround(text: string, needle: string): string {
  const at = text.toLowerCase().indexOf(needle.toLowerCase())
  if (at === -1) return text.slice(0, 120).replace(/\s+/g, ' ').trim()
  const from = Math.max(0, at - 50)
  return `${from > 0 ? '…' : ''}${text.slice(from, at + needle.length + 60).replace(/\s+/g, ' ').trim()}…`
}

interface Tally {
  name: string
  source: 'tracked' | 'extracted'
  matchedAs: string
  excerpt: string
  answers: Set<number>
  prompts: Set<string>
  engines: Set<string>
}

/**
 * Every name the engines actually said across a corpus, with its evidence.
 *
 * `exclude` is the subject's own brand forms. A domain is not its own
 * competitor, and the subject arrives in these answers by exactly the shapes
 * this extractor looks for, so without this every scan would propose promoting
 * the customer against themselves.
 */
export function tallyCompetitors(
  answers: readonly AnswerSample[],
  opts: { readonly tracked: readonly BrandSpec[]; readonly exclude: readonly string[] },
): readonly CompetitorCandidate[] {
  const excluded = new Set(opts.exclude.map(squash).filter(Boolean))
  const byKey = new Map<string, Tally>()

  const record = (key: string, t: Omit<Tally, 'answers' | 'prompts' | 'engines'>, i: number, a: AnswerSample) => {
    const existing = byKey.get(key)
    const tally = existing ?? { ...t, answers: new Set<number>(), prompts: new Set<string>(), engines: new Set<string>() }
    tally.answers.add(i)
    tally.prompts.add(a.prompt)
    tally.engines.add(a.engine)
    if (!existing) byKey.set(key, tally)
  }

  for (const [i, a] of answers.entries()) {
    const normalised = normaliseForMatch(a.text)

    // TRACKED FIRST, so a brand with a reviewed alias table is recorded under
    // its curated name rather than under whichever surface form this answer
    // happened to use.
    for (const brand of opts.tracked) {
      const hit = findMentions(normalised, brand)
      if (!hit) continue
      const key = squash(brand.name)
      if (!key || excluded.has(key)) continue
      record(key, { name: brand.name, source: 'tracked', matchedAs: hit.matchedAlias, excerpt: excerptAround(a.text, hit.matchedAlias) }, i, a)
    }

    for (const candidate of extractCandidates(a.text)) {
      const key = squash(candidate)
      if (!key || excluded.has(key)) continue
      // A tracked brand found by shape is not a second candidate. The tracked
      // record already holds this answer, and counting it twice would let one
      // answer clear a two-answer bar.
      if (byKey.get(key)?.source === 'tracked') continue
      record(key, { name: candidate, source: 'extracted', matchedAs: candidate, excerpt: excerptAround(a.text, candidate) }, i, a)
    }
  }

  return [...byKey.values()]
    .map((t) => ({
      name: t.name,
      evidence: {
        source: t.source,
        answers: t.answers.size,
        prompts: t.prompts.size,
        engines: t.engines.size,
        engineIds: [...t.engines].sort(),
        matchedAs: t.matchedAs,
        excerpt: t.excerpt,
      },
    }))
    .sort((a, b) => b.evidence.answers - a.evidence.answers || (a.name < b.name ? -1 : 1))
}

/** Those clearing the bar. Everything else is reported, never written. */
export function promotable(
  candidates: readonly CompetitorCandidate[],
  t: PromotionThresholds = DEFAULT_THRESHOLDS,
): readonly CompetitorCandidate[] {
  return candidates.filter((c) => c.evidence.answers >= t.minAnswers && c.evidence.prompts >= t.minPrompts && c.evidence.engines >= t.minEngines)
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THE STORE — a file of its own, and that is the whole safety argument.
 */

/**
 * Promoted competitors for one category.
 *
 * ⚠️ WHY THIS IS NOT WRITTEN INTO THE BANK FILE. ADR-0009's third refusal is
 * that `readGeneratedBanks` DROPS a generated bank whose file has acquired any
 * leaders, so a hand-edited file cannot put invented rivals on a chart. That
 * refusal is load-bearing and it stays exactly as it was — writing promoted
 * leaders into the bank would have had to weaken it, and "the check is off for
 * the good writes" is not a check.
 *
 * So promotion writes here instead, and the merge happens on read. A leader can
 * therefore reach a chart by exactly one route: a file whose every entry
 * carries the answers it was learned from. The bank file's own `leaders` is
 * still, and permanently, refused.
 */
export interface PromotedCompetitors {
  readonly category: string
  /** ISO 8601. When a human ran `--apply`. */
  readonly promotedAt: string
  /** The scorer version the evidence was gathered under (R5 provenance). */
  readonly algoVersion: string
  /**
   * The version the bank takes once these leaders are attached.
   *
   * ⚠️ A BUMP, NOT A SILENT EDIT. `comparisonBasisFor` stamps `slug@version`
   * into every metric's `comparison_basis`, and adding competitors changes
   * `position`, which changes the preview score. A scan run before promotion and
   * one run after are therefore not measurements of the same thing, and
   * `compare()` must refuse to put them side by side rather than report the
   * difference as movement. Bumping the version is what makes it refuse — the
   * same discipline R5 applies to a scoring change.
   */
  readonly bankVersion: number
  readonly leaders: readonly (Leader & { readonly evidence: CompetitorEvidence })[]
}

const promotedDir = (dataDir: string): string => join(dataDir, 'promoted-competitors')
const promotedFile = (dataDir: string, slug: string): string => join(promotedDir(dataDir), `${slug}.json`)

/**
 * Read one category's promoted set, or null.
 *
 * ⚠️ EVERY ENTRY MUST CARRY ITS EVIDENCE, RE-CHECKED HERE ON READ. This is the
 * same discipline `readGeneratedBanks` applies to `leaders` on a bank file, and
 * it exists for the same reason: the file is on disk and a person can type into
 * it. An entry with no evidence is exactly what "an invented competitor" looks
 * like from here, so it is dropped — the whole file is not, because one bad row
 * should not silently remove rivals that were properly promoted.
 */
export function readPromoted(dataDir: string, slug: string): PromotedCompetitors | null {
  const path = promotedFile(dataDir, slug)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PromotedCompetitors>
    if (parsed.category !== slug || !Array.isArray(parsed.leaders)) return null
    const leaders = parsed.leaders.filter(
      (l): l is Leader & { evidence: CompetitorEvidence } =>
        typeof l?.name === 'string' &&
        l.name.trim() !== '' &&
        Array.isArray(l.aliases) &&
        l.aliases.length > 0 &&
        typeof l.evidence === 'object' &&
        l.evidence !== null &&
        Number.isFinite(l.evidence.answers) &&
        l.evidence.answers > 0 &&
        Number.isFinite(l.evidence.engines) &&
        l.evidence.engines > 0,
    )
    if (leaders.length === 0) return null
    return {
      category: slug,
      promotedAt: String(parsed.promotedAt ?? ''),
      algoVersion: String(parsed.algoVersion ?? ''),
      bankVersion: Number.isFinite(parsed.bankVersion) ? Number(parsed.bankVersion) : 2,
      // ⚠️ `domains` is forced empty on READ as well as on write. A promoted
      // name was learned from prose; crediting a citation to it would be an
      // attribution nobody verified. See the header.
      leaders: leaders.map((l) => ({ ...l, domains: [] })),
    }
  } catch {
    return null
  }
}

/** Every category with a promoted set. Used by the merge in `resolve-category.ts`. */
export function readAllPromoted(dataDir: string): readonly PromotedCompetitors[] {
  const dir = promotedDir(dataDir)
  if (!existsSync(dir)) return []
  const out: PromotedCompetitors[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue
    const p = readPromoted(dataDir, name.slice(0, -'.json'.length))
    if (p) out.push(p)
  }
  return out
}

/**
 * Turn cleared candidates into leaders and write them.
 *
 * ⚠️ ADDITIVE AND VERSION-BUMPING, NEVER A REWRITE. A second promotion round
 * keeps what the first promoted — removing a competitor from a category
 * silently would change what every later number means, and worse, it would do
 * so without the version moving. New names are appended and the version goes up
 * again, so each round is a distinct, comparable, refusable state.
 */
export function buildPromotion(
  slug: string,
  candidates: readonly CompetitorCandidate[],
  opts: { readonly bankVersion: number; readonly now: string; readonly existing?: PromotedCompetitors | null },
): PromotedCompetitors {
  const existing = opts.existing ?? null
  const held = new Map((existing?.leaders ?? []).map((l) => [squash(l.name), l]))
  for (const c of candidates) {
    const key = squash(c.name)
    if (!key || held.has(key)) continue
    held.set(key, {
      // Namespaced so a promoted id can never collide with a hand-authored
      // leader id, and so its origin is legible in a stored score row.
      id: `promoted:${key}`,
      name: c.name,
      aliases: [c.name],
      domains: [],
      evidence: c.evidence,
    })
  }
  return {
    category: slug,
    promotedAt: opts.now,
    algoVersion: SCORING_ALGO_VERSION,
    bankVersion: Math.max(opts.bankVersion + 1, (existing?.bankVersion ?? 0) + 1),
    leaders: [...held.values()],
  }
}

export function writePromotion(dataDir: string, promotion: PromotedCompetitors): string {
  mkdirSync(promotedDir(dataDir), { recursive: true })
  const path = promotedFile(dataDir, promotion.category)
  writeFileSync(path, JSON.stringify(promotion, null, 2) + '\n')
  return path
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * READING THE CORPUS.
 */

/**
 * Every stored answer whose prompt is one of this bank's, by walking the answer
 * store.
 *
 * Walked rather than key-reconstructed on purpose. Rebuilding `r2KeyFor` here
 * would need the day and the adapter id of every past collection, so a scan
 * from a different day or a different adapter would silently contribute
 * nothing — and "found less evidence than exists" is invisible in the output,
 * which is the worst shape for a bug in a promotion decision to take. The
 * store is a few megabytes and this runs once, by hand.
 *
 * ponytail: full walk, O(objects). Fine at demo scale; when the corpus is in R2
 * this becomes a prefix listing plus the index, and the matching rule below is
 * unchanged.
 */
export function readCorpus(answersRoot: string, prompts: readonly string[]): readonly AnswerSample[] {
  // `normalisePrompt` is the cache key's OWN normalisation, imported rather than
  // approximated. A hand-rolled lowercase here would be a second definition of
  // "the same prompt", and the two would drift in the direction that quietly
  // finds fewer answers than were collected — a shortfall nothing in the output
  // could show.
  const wanted = new Set(prompts.map(normalisePrompt))
  const out: AnswerSample[] = []

  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
          cell?: { normalisedPrompt?: string; engine?: string }
          runs?: { text?: unknown; prompt?: unknown; cell?: { engine?: string; normalisedPrompt?: string } }[]
        }
        for (const run of parsed.runs ?? []) {
          const prompt = typeof run.prompt === 'string' ? run.prompt : (parsed.cell?.normalisedPrompt ?? '')
          const engine = run.cell?.engine ?? parsed.cell?.engine ?? ''
          if (typeof run.text !== 'string' || !run.text || !engine) continue
          // Matched on the normalised prompt, which is what the cache key is
          // built from — so a prompt whose casing or spacing drifted between
          // the bank and the collection still matches its own answers.
          const normalised = run.cell?.normalisedPrompt ?? parsed.cell?.normalisedPrompt ?? normalisePrompt(prompt)
          if (!wanted.has(normalised) && !wanted.has(normalisePrompt(prompt))) continue
          out.push({ text: run.text, prompt, engine })
        }
      } catch {
        /* a corrupt object degrades the evidence; it must not stop the report */
      }
    }
  }

  walk(answersRoot)
  return out
}
