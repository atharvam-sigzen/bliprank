/**
 * THE CLASSIFICATION LABELLING BENCH — G3's ≥95% criterion, made a person's
 * afternoon instead of a person's week.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ WHICH LABELLED SET THIS IS. There are two, and they are routinely confused
 * because both are "the golden set" in conversation:
 *
 *   G2 · `services/scorer/golden/answers/*.json` — hand-labelled ANSWERS
 *        (mentioned, position, citation class). 7 of a 300–500 target. Its
 *        workflow is `services/scorer/golden/README.md`, and this file is not
 *        about it.
 *
 *   G3 · THIS ONE — hand-labelled DOMAINS (which category is right). The gate
 *        asks for ≥95% of 100 random real domains classified correctly. It has
 *        never existed: zero cases, no file, no harness. ADR-0009 set
 *        `MIN_SCORE`, `MIN_DISTINCT`, `MIN_MARGIN` and
 *        `MIN_SELF_DESCRIPTION_HITS` from six homepages and says so.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ IT PROPOSES. IT NEVER LABELS.
 *
 * The classifier's answer is a PROPOSAL in a column a person overrides. Nothing
 * here writes a label, infers one from a confident-looking score, or defaults a
 * blank verdict to agreement — an unreviewed row is `?` and `--import` refuses
 * the file until it is not. A harness that graded a classifier against labels
 * the classifier produced would report 100% and mean nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ IT WRITES NOTHING INTO `data-live`, AND THAT IS NOT TIDINESS.
 *
 * `resolveCategory` has two side effects a labelling run must not have:
 * `recordCategory` writes a domain's category down PERMANENTLY and refuses to
 * overwrite it, so classifying 100 domains would freeze 100 decisions nobody
 * reviewed; and rung 4 AUTHORS A BANK for a domain that fits nothing, so a
 * hundred-domain sweep would grow the taxonomy by however many markets it met.
 *
 * So the run points `dataDir` at a scratch directory it throws away, and passes
 * no `author` — which disables rung 4 entirely. The consequence is honest and
 * has to be understood when reading the results: a domain in no tracked
 * category resolves to the FALLBACK, never to an authored one. That is the
 * right thing to measure. G3 asks whether the classifier puts a domain in the
 * right category, and "no category we hold fits this" is a correct answer that
 * a labeller can confirm — `none` in the correction column says so.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ THE SAMPLE IS YOURS TO CHOOSE, AND IT DECIDES WHAT THE GATE MEANS.
 *
 * This tool takes a list of domains and will not invent one. The criterion says
 * "100 random real domains", and every plausible source biases it differently:
 *
 *   - a list of B2B SaaS homepages flatters the classifier, because the
 *     taxonomy is fifteen B2B SaaS categories and almost everything will fit
 *   - a global top-sites list depresses it, because most of the web is
 *     consumer sites in no tracked category, and the honest answer for each is
 *     the fallback
 *   - a customer or waitlist sample measures the population that actually
 *     matters, and is not random in the sense the criterion says
 *
 * None of these is wrong; they answer different questions. Pick deliberately
 * and record which in the labelled file's `sample` field, because the number
 * this produces is only interpretable beside it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE COMMANDS, IN ORDER.
 *
 *   pnpm grader:label -- --domains domains.txt --out labelling/
 *       One bounded homepage GET each, through `fetch-site.ts`'s SSRF boundary.
 *       Writes `worklist.csv` and `review.html`. No provider quota, no model.
 *
 *   ... then label, in either the spreadsheet or the browser page.
 *
 *   pnpm grader:label -- --import labelling/worklist.csv --out labelling/labelled.json
 *       Validates every row and refuses the file if any is unreviewed or names
 *       a category that does not exist.
 *
 *   pnpm grader:label -- --score labelling/labelled.json
 *       The G3 number, per signal and overall, with every disagreement listed.
 */

import { DEMO_TAXONOMY, FALLBACK_SLUG, extractSiteText } from '@bliprank/taxonomy'
import { fetchSiteHtml, type FetchSiteResult } from './fetch-site.js'
import { resolveCategory } from './resolve-category.js'

/** The verdict column. `?` is the unreviewed state and `--import` refuses it. */
export type Verdict = '?' | 'ok' | 'wrong' | 'unsure'

export interface WorklistRow {
  readonly domain: string
  /**
   * The page's own words, for the labeller to judge from.
   *
   * ⚠️ EMPTY MEANS TWO DIFFERENT THINGS, so `fetched` says which. The classifier
   * is a ladder and rungs 1 and 2 decide from the HOSTNAME ALONE — a domain that
   * is a tracked brand never gets fetched at all. Showing "(no title)" for one
   * of those tells the labeller the page has no title, which is false and is
   * exactly the kind of quiet wrong statement this product exists to refuse.
   */
  readonly title: string
  readonly description: string
  /** False when the classifier decided before it needed the page. */
  readonly fetched: boolean
  /** What the classifier proposed, and which rung decided it. */
  readonly proposed: string
  readonly signal: string
  readonly evidence: string
  readonly verdict: Verdict
  /** Set when `verdict` is `wrong`: the slug that IS right, or `none`. */
  readonly correct: string
  readonly notes: string
}

export const CATEGORY_SLUGS: readonly string[] = DEMO_TAXONOMY.map((c) => c.slug)
/** `none` means "no category we hold fits this", which is a correct answer, not a gap. */
export const CORRECTION_CHOICES: readonly string[] = ['none', ...CATEGORY_SLUGS]

/* ────────────────────────────────────────────────────────────────── CSV.
 * Hand-rolled, and that is a deliberate refusal of a dependency: the format
 * here is nine columns of short strings that a person edits in a spreadsheet.
 * What matters is that a quoted field survives a comma, a quote and a newline
 * in a meta description, which is fifteen lines, and that the parser rejects a
 * malformed file rather than guessing.
 */

const q = (s: string): string => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

export function toCsv(rows: readonly WorklistRow[]): string {
  const head = ['domain', 'title', 'description', 'fetched', 'proposed', 'signal', 'evidence', 'verdict', 'correct', 'notes']
  const body = rows.map((r) =>
    [r.domain, r.title, r.description, r.fetched ? 'yes' : 'no', r.proposed, r.signal, r.evidence, r.verdict, r.correct, r.notes].map(q).join(','),
  )
  return [head.join(','), ...body].join('\n') + '\n'
}

/** Split one CSV line, honouring quotes and doubled quotes. Returns null on an unterminated quote. */
export function splitCsvLine(line: string): string[] | null {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  if (quoted) return null
  out.push(cur)
  return out
}

/** Rows out of a CSV. A record may span lines because a description may contain one. */
export function parseCsv(text: string): { readonly rows: readonly Record<string, string>[]; readonly errors: readonly string[] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const errors: string[] = []
  const records: string[] = []
  let buf = ''
  for (const line of lines) {
    buf = buf ? `${buf}\n${line}` : line
    if (splitCsvLine(buf) !== null) {
      if (buf.trim() !== '') records.push(buf)
      buf = ''
    }
  }
  if (buf.trim() !== '') errors.push('the file ends inside an unterminated quoted field')
  const header = records.length ? splitCsvLine(records[0]!)! : []
  const rows = records.slice(1).map((r, i) => {
    const cells = splitCsvLine(r)!
    if (cells.length !== header.length) errors.push(`row ${i + 2}: ${cells.length} columns, header has ${header.length}`)
    return Object.fromEntries(header.map((h, j) => [h, cells[j] ?? '']))
  })
  return { rows, errors }
}

/* ──────────────────────────────────────────────────────── Building the worklist. */

export interface Proposal {
  readonly proposed: string
  readonly signal: string
  readonly evidence: string
  readonly title: string
  readonly description: string
  readonly fetched: boolean
}

/**
 * Classify one domain the way a scan would, and keep the page's own words.
 *
 * ⚠️ ONE FETCH SERVES BOTH. `resolveCategory` returns a DECISION, not a
 * document, so the display fields would need a second GET of the same homepage.
 * Injecting a capturing fetcher through the seam the resolver already exposes
 * means the classifier sees exactly the bytes the labeller is shown — which
 * also removes the possibility of judging a proposal against a page that had
 * changed between the two requests.
 */
export async function propose(domain: string, scratchDir: string): Promise<Proposal> {
  let captured: FetchSiteResult | null = null
  const resolved = await resolveCategory(domain, {
    dataDir: scratchDir,
    // No author: rung 4 is off, so nothing is written to the taxonomy and no
    // model is called. A domain in no tracked category lands on the fallback.
    fetchSite: async (d, o) => {
      const got = await fetchSiteHtml(d, o ?? {})
      captured = got
      return got
    },
    log: () => {},
  })
  const site = captured && (captured as FetchSiteResult).ok ? extractSiteText((captured as FetchSiteResult & { html: string }).html) : null
  return {
    proposed: resolved.record.slug,
    signal: resolved.record.source,
    evidence: resolved.record.evidence,
    title: site?.title ?? '',
    description: (site?.description ?? '').slice(0, 300),
    // The resolver only fetches when the free rungs did not settle it.
    fetched: site !== null,
  }
}

/** Read a domain list: one per line, `#` comments and blanks ignored, deduplicated. */
export function readDomainList(text: string): readonly string[] {
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const d = raw.split('#')[0]!.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '')
    if (d) seen.add(d)
  }
  return [...seen]
}

/* ─────────────────────────────────────────────────────────── The labelled set. */

export interface LabelledCase {
  readonly domain: string
  readonly proposed: string
  readonly signal: string
  /** What the human says is right: a slug, or `none` for "no category fits". */
  readonly correct: string
  readonly agreed: boolean
  readonly notes: string
}

export interface LabelledSet {
  readonly labelledAt: string
  /** Where the domains came from. The number is only interpretable beside this. */
  readonly sample: string
  readonly cases: readonly LabelledCase[]
}

/**
 * Turn a reviewed CSV into the labelled set, or refuse and say why.
 *
 * ⚠️ IT REFUSES A PARTLY-REVIEWED FILE RATHER THAN SCORING WHAT IT HAS. An
 * unreviewed row scored as agreement inflates the gate; dropped silently, it
 * shrinks the sample without saying so, and the criterion is a proportion of a
 * stated 100. Both are worse than a refusal naming the rows.
 *
 * `unsure` is kept as a first-class outcome and EXCLUDED from the denominator,
 * with the count reported. A labeller forced to choose between `ok` and `wrong`
 * on a domain they cannot judge produces a number that looks decisive and is
 * not.
 */
export function importLabels(csv: string, sample: string): LabelledSet | { readonly refuse: readonly string[] } {
  const { rows, errors } = parseCsv(csv)
  const problems = [...errors]
  const cases: LabelledCase[] = []

  for (const [i, r] of rows.entries()) {
    const at = `row ${i + 2} (${r['domain'] || 'no domain'})`
    const verdict = (r['verdict'] ?? '').trim().toLowerCase()
    const correctRaw = (r['correct'] ?? '').trim().toLowerCase()
    if (!r['domain']) {
      problems.push(`${at}: no domain`)
      continue
    }
    if (verdict === '' || verdict === '?') {
      problems.push(`${at}: not reviewed yet`)
      continue
    }
    if (!['ok', 'wrong', 'unsure'].includes(verdict)) {
      problems.push(`${at}: verdict "${verdict}" is not ok, wrong or unsure`)
      continue
    }
    if (verdict === 'wrong') {
      if (!correctRaw) {
        problems.push(`${at}: marked wrong but the correct column is empty — which category IS right, or "none"`)
        continue
      }
      if (!CORRECTION_CHOICES.includes(correctRaw)) {
        problems.push(`${at}: "${correctRaw}" is not a category. One of: ${CORRECTION_CHOICES.join(', ')}`)
        continue
      }
      if (correctRaw === (r['proposed'] ?? '').trim().toLowerCase()) {
        problems.push(`${at}: marked wrong but the correction is the proposal. Mark it ok, or name a different category.`)
        continue
      }
    }
    const proposed = (r['proposed'] ?? '').trim()
    cases.push({
      domain: r['domain']!.trim().toLowerCase(),
      proposed,
      signal: (r['signal'] ?? '').trim(),
      // `ok` means the proposal was right, so the correct answer IS the proposal.
      // Recorded explicitly rather than left implicit: the labelled set has to
      // stay readable when the classifier's proposal for that domain changes.
      correct: verdict === 'ok' ? (proposed === FALLBACK_SLUG ? 'none' : proposed) : verdict === 'wrong' ? correctRaw : 'unsure',
      agreed: verdict === 'ok',
      notes: (r['notes'] ?? '').trim(),
    })
  }

  const dupes = cases.map((c) => c.domain).filter((d, i, a) => a.indexOf(d) !== i)
  for (const d of new Set(dupes)) problems.push(`${d} appears more than once`)

  if (problems.length) return { refuse: problems }
  return { labelledAt: new Date().toISOString(), sample, cases }
}

export interface Score {
  readonly total: number
  readonly judged: number
  readonly unsure: number
  readonly correct: number
  readonly rate: number
  readonly meetsGate: boolean
  readonly bySignal: readonly { readonly signal: string; readonly judged: number; readonly correct: number }[]
  readonly wrong: readonly LabelledCase[]
}

/** G3's criterion. ≥95%, over the cases a human could actually judge. */
export const G3_TARGET = 0.95
export const G3_SAMPLE_SIZE = 100

export function scoreLabels(set: LabelledSet): Score {
  const judged = set.cases.filter((c) => c.correct !== 'unsure')
  const correct = judged.filter((c) => c.agreed)
  const signals = [...new Set(judged.map((c) => c.signal))].sort()
  return {
    total: set.cases.length,
    judged: judged.length,
    unsure: set.cases.length - judged.length,
    correct: correct.length,
    rate: judged.length ? correct.length / judged.length : 0,
    meetsGate: judged.length >= G3_SAMPLE_SIZE && judged.length > 0 && correct.length / judged.length >= G3_TARGET,
    bySignal: signals.map((s) => ({
      signal: s,
      judged: judged.filter((c) => c.signal === s).length,
      correct: judged.filter((c) => c.signal === s && c.agreed).length,
    })),
    wrong: judged.filter((c) => !c.agreed),
  }
}
