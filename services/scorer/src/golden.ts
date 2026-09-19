/**
 * Golden set — PHASES.md 2.5, gate G2.
 *
 * 300-500 labelled answers plus an agreement harness. This file is the
 * structure and the scoring of agreement; the cases live in
 * `services/scorer/golden/answers/*.json`.
 *
 * The harness deliberately reports rather than asserts a verdict. G2 wants
 * >= 95% deterministic agreement, >= 97% citation-class agreement and 0%
 * silently bucketed as `owned` — but those thresholds only mean something at
 * the full set size. Judged on a seed set of a dozen answers they would be
 * noise dressed as a gate, so `gateStatus` returns NOT_RUN until the set is
 * populated. A criterion with no executable check is NOT RUN, not PASS
 * (docs/PHASES.md).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ WHO SAID SO. A label is ground truth here: the harness reports the SCORER
 * as wrong wherever the two differ. That is only honest when a person stands
 * behind the label. MVP_PLAN E4 fills the set with labels an agent proposed by
 * reading each answer, and an agent's reading is a second instrument, not a
 * referee. So the verdict has a state between NOT_RUN and PASS/FAIL:
 *
 *   NOT_RUN    the set is below the target size
 *   PROPOSED   the size is met, some labels are agent-proposed and unverified,
 *              and no usable human spot-check vouches for them. The three
 *              agreement figures are reported. It can never read PASS.
 *   PASS/FAIL  every label is a person's, or a recorded human spot-check of the
 *              seeded random sample agreed with the proposed labels at or above
 *              `SPOT_CHECK_MIN_AGREE_RATE`.
 *
 * `runGoldenSet(cases)` with no second argument is the first two states only
 * whenever a proposed label is present. The second argument is the sheet as a
 * person left it, never somebody's summary of it: THIS module draws the seeded
 * sample, checks the sheet is that sample and that every fingerprint is
 * current, counts the ticks and applies the threshold. The first build took a
 * pre-judged outcome with a caller-supplied `problems: []`, and the stats
 * review walked a hand-picked 30 straight through it (E4 review, B1): a guard
 * in a module the gate does not call is not a guard.
 *
 * ⚠️ NOT DECIDED HERE, AND THE OWNER'S TO DECIDE (E4 review, B3). PASS compares
 * three point estimates to three bars, as it always has. The pooled
 * deterministic figure is six dependent checks per case, so it has no honest
 * simple interval; the case-level reading does, and `casesFullyAgreed` carries
 * it so the report never shows the headline alone. Whether PASS should require
 * a lower bound to clear the bar is a methodology decision.
 */

import { createHash } from 'node:crypto'
import type { AnswerBody } from '@bliprank/contracts'
import { wilson } from '@bliprank/stats'
import type { SourceClass } from './classify-source.js'
import { scoreAnswer, type BrandSpec } from './score.js'

/** The G2 target set size. Agreement below this is diagnostic, not a verdict. */
export const GOLDEN_SET_TARGET = 300

/** How many proposed cases a person checks by hand. */
export const SPOT_CHECK_SIZE = 30

/** The seed of the spot-check sample. A sheet drawn with any other seed is a chosen sample, and is refused. */
export const SPOT_CHECK_SEED = 'bliprank-golden-spot-check-e4-2026-09-19'

/**
 * The six per-case checks `deterministicRate` pools, in report order. PINNED by
 * a test: adding or dropping a field moves the G2 headline, so it is a decision,
 * not an edit. PHASES.md 2.5 says "deterministic signals >= 95% vs human labels"
 * and names no denominator; this harness has always read it as field checks
 * pooled over cases. The checks of one case move together (a missed competitor
 * alias costs brandsDetected, competitorsMentioned and often position at once),
 * so the report shows the case-level reading beside it.
 */
export const DETERMINISTIC_FIELDS = ['mentioned', 'mentionCount', 'brandsDetected', 'cited', 'position', 'competitorsMentioned'] as const

/**
 * The share of the spot-check sample the person must AGREE with before the
 * proposed labels may referee the scorer: 29 of 30.
 *
 * ⚠️ PROPOSED BY THE BUILDER (E4), FOR THE SCORING-RULE OWNER TO CONFIRM.
 *
 * Why not lower. G2 holds the scorer to 95%. 28 of 30 is 93.3%: labels
 * OBSERVED to be less accurate than the bar the instrument is held to cannot
 * tell a scorer at 94% from one at 96%, which is the only question G2 asks.
 * 29 of 30 (96.7%) is the smallest count whose point estimate clears 95%.
 *
 * Why not 30 of 30. It would reject good labels about as often as it accepts
 * them: a label set with a true 2% error rate passes 30/30 only 54.5% of the
 * time (0.98^30), against 87.9% at 29/30. A gate that fails a good label set
 * on a coin flip teaches people to re-roll the sample, which is worse than the
 * looser threshold.
 *
 * What it buys, measured (binomial, n = 30, pass = at most one disagreement):
 * a label set that is 10% wrong passes 18.4% of the time, 15% wrong 4.8%,
 * 20% wrong 1.1%.
 *
 * ⚠️ WHAT IT DOES NOT BUY. Thirty cases cannot certify the labels. The Wilson
 * 95% interval on 29/30 runs from 83.3%, and on 30/30 from 88.6%, so a passed
 * spot-check says "not badly wrong", never "at least 95% right". It has little
 * power in the band that matters for a 95% bar: a label set that is 5% wrong
 * passes 55.4% of the time, 7% wrong 36.9%. And label error pulls the G2
 * figures themselves down (measured agreement cannot exceed the labels' own
 * accuracy by much), so an accepted spot-check does not make 95.8% mean 95.8%.
 * The report carries the interval beside the count so the spot-check is never
 * read as more than the tripwire it is.
 *
 * A case the person disagreed with STAYS in the figures and is named. The first
 * build left it out; the review showed that deleting exactly the labels known
 * to be wrong is a lever on the verdict (E4 review, S5), and one case is at
 * most 6 of 1800 checks. The report shows the figure both ways.
 */
export const SPOT_CHECK_MIN_AGREE_RATE = 29 / 30

/** The agreeing answers a sample of `n` needs. 29 at n = 30; every one of them below that. */
export const spotCheckMinAgree = (n: number): number => (n <= 0 ? 0 : Math.ceil(n * SPOT_CHECK_MIN_AGREE_RATE - 1e-9))

/** One place a brand is named in the answer text. Checkable: the span must sit at the offset. */
export interface MentionEvidence {
  /** `brand.id` of the subject or of one competitor in the case. */
  readonly brand: string
  /** The characters exactly as they stand in `answer.text`. */
  readonly span: string
  /** 0-based offset of `span` in `answer.text` (UTF-16 units, as `String.prototype.indexOf` counts). */
  readonly offset: number
}

/** What the labeller saw, so a disputed label can be checked against the text instead of argued about. */
export interface LabelEvidence {
  /** EVERY counted occurrence of the subject, and at least the first appearance of each competitor found. */
  readonly mentions: readonly MentionEvidence[]
  /** Brand names in order of first appearance: the list `position` was read off. */
  readonly order: readonly string[]
  /** Per citation position: why it has the class it has. */
  readonly citations: Readonly<Record<string, string>>
  readonly notes?: string
  /** A label changed after it was first proposed, each time by re-reading the answer, never to match the scorer. */
  readonly revisions?: readonly { readonly field: string; readonly from: unknown; readonly to: unknown; readonly reason: string }[]
}

/** One labelled answer. Everything the labeller asserts about it. */
export interface GoldenCase {
  readonly id: string
  /** Where the answer came from, so a disputed label can be traced back. */
  readonly source: {
    readonly engine: string
    readonly collectedAt?: string
    readonly note?: string
    /** A real stored answer names the cycle it came from and the cache cell it is stored under. */
    readonly domain?: string
    readonly category?: string
    readonly day?: string
    readonly prompt?: string
    readonly cell?: { readonly key: string; readonly adapter: string; readonly run: number }
    readonly comparisonBasis?: string
  }
  readonly answer: AnswerBody
  readonly brand: BrandSpec
  readonly competitors?: readonly BrandSpec[]
  readonly publishers?: Readonly<Record<string, string>>
  /** What the labeller says the correct output is. */
  readonly label: {
    readonly mentioned: boolean
    /**
     * Occurrences a human counts. Labelled because the harness previously
     * checked mentioned/cited/position/competitors only — so a bug that
     * double-counted every "Brand + product line" alias pair was structurally
     * invisible and would have passed G2 at 300/300.
     */
    readonly mentionCount: number
    /** Total brands (subject + competitors) a human finds in the text. */
    readonly brandsDetected: number
    readonly cited: boolean
    /** 1-based rank among detected brands, or null. */
    readonly position: number | null
    /** Competitor names, in order of first appearance. */
    readonly competitorsMentioned: readonly string[]
    /** Expected class per citation position. */
    readonly citationClasses: Readonly<Record<string, SourceClass>>
  }
  /** Why this case is in the set: the edge it covers. */
  readonly covers?: string
  /**
   * Who made the label. Absent on the hand-built seed fixtures, which a person
   * wrote together with their text. REQUIRED on a case that names a stored
   * cell: a real answer's label always says whose reading it is.
   */
  readonly labelledBy?: 'human' | 'agent-proposed'
  /** The person who checked an agent-proposed label, or null while nobody has. */
  readonly verifiedBy?: string | null
  /**
   * `labelFingerprint` of the case as that person saw it. A name alone would let
   * a label be edited after it was verified and still count as a person's; with
   * this, an edited label is a proposal again until somebody re-verifies it.
   */
  readonly verifiedFingerprint?: string | null
  /** Required when `labelledBy` is `agent-proposed`. */
  readonly evidence?: LabelEvidence
}

const sha = (x: string): string => createHash('sha256').update(x).digest('hex')

/**
 * Twelve hex characters that change when anything a person was asked to judge
 * changes: the answer, the specs the label is relative to, or the label.
 * Evidence is left out on purpose: tidying a note must not void a check.
 */
export function labelFingerprint(c: GoldenCase): string {
  return sha(
    JSON.stringify([
      c.id,
      c.answer.text,
      c.answer.citations.map((k) => [k.position, k.url]),
      [c.brand.id, c.brand.name, c.brand.domains],
      (c.competitors ?? []).map((b) => [b.id, b.name, b.domains]),
      [c.label.mentioned, c.label.mentionCount, c.label.brandsDetected, c.label.cited, c.label.position, c.label.competitorsMentioned, Object.entries(c.label.citationClasses).sort(([a], [b]) => Number(a) - Number(b))],
    ]),
  ).slice(0, 12)
}

/** A person has verified THIS label: named, and the fingerprint they signed is still the label's. */
export const isVerified = (c: GoldenCase): boolean => typeof c.verifiedBy === 'string' && c.verifiedBy.trim() !== '' && c.verifiedFingerprint === labelFingerprint(c)

/** A label no person stands behind yet, including one edited after somebody verified it. */
export const isProposed = (c: GoldenCase): boolean => c.labelledBy === 'agent-proposed' && !isVerified(c)

/**
 * The cases a person checks: of EVERY agent-proposed label, the `size` with the
 * smallest `sha256(seed | id)`. A seeded random draw with no generator state,
 * so it does not depend on file order.
 *
 * Drawn from every agent-proposed label, verified since or not, on purpose:
 * the right response to a label the person disputes is to correct it by
 * re-reading and have them verify it, and if that removed the case from the
 * pool the sample would be redrawn and their hour thrown away.
 */
export function spotCheckSample(cases: readonly GoldenCase[], seed: string = SPOT_CHECK_SEED, size: number = SPOT_CHECK_SIZE): GoldenCase[] {
  return cases
    .filter((c) => c.labelledBy === 'agent-proposed')
    .map((c) => ({ c, rank: sha(`${seed}|${c.id}`) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .slice(0, size)
    .map((x) => x.c)
}

/**
 * WHICH labels a sheet's sample was drawn from: a fingerprint of the ids of
 * every agent-proposed case, and how many there are.
 *
 * A hash-rank draw has a property that needs this: delete cases OUTSIDE the
 * sample and the sample does not move, so a signed sheet would go on vouching
 * for a set that has quietly lost its awkward cases (the E4 review did exactly
 * that: 17 disagreeing cases removed, 95.8% became 98.8%, the sheet still
 * judged clean). A sample vouches for the population it was drawn from, so the
 * sheet names it and the harness refuses a sheet whose population has changed.
 */
export function spotCheckPopulation(cases: readonly GoldenCase[]): { readonly count: number; readonly fingerprint: string } {
  const ids = cases.filter((c) => c.labelledBy === 'agent-proposed').map((c) => c.id).sort()
  return { count: ids.length, fingerprint: sha(ids.join('\n')).slice(0, 12) }
}

export interface FieldAgreement {
  readonly field: string
  readonly agreed: number
  readonly total: number
  readonly rate: number
  readonly disagreements: readonly { caseId: string; expected: unknown; actual: unknown }[]
}

/**
 * The spot-check sheet exactly as a person left it, read off the Markdown by
 * `parseSpotCheckSheet`. Nothing here is a conclusion: the harness draws the
 * sample, compares the fingerprints and counts the ticks itself.
 */
export interface SpotCheckSheet {
  readonly checkedBy: string
  readonly checkedOn: string
  readonly seed: string | null
  /** `spotCheckPopulation(...).fingerprint` of the set the sheet was written for. */
  readonly population: string | null
  readonly entries: readonly { readonly id: string; readonly fingerprint: string; readonly verdict: 'agree' | 'disagree' | 'both' | 'unanswered'; readonly note: string }[]
}

export interface SpotCheckStanding {
  /**
   * not-needed       no proposed label in the set
   * missing          proposed labels, and nothing recorded
   * unusable         a sheet exists and cannot be used; `problems` says why
   * below-threshold  the person disagreed too often: the proposed labels are not accepted
   * accepted         the proposed labels may referee the scorer
   */
  readonly status: 'not-needed' | 'missing' | 'unusable' | 'below-threshold' | 'accepted'
  readonly required: number
  readonly minAgree: number
  readonly checked: number
  readonly agreed: number
  /** Wilson 95% on agreed/checked, when anything was checked. Never the count alone. */
  readonly interval: { readonly low: number; readonly high: number } | null
  readonly checkedBy: string | null
  /** Cases the person disagreed with. They STAY in the agreement figures, named, until a person corrects the label. */
  readonly disputed: readonly { readonly id: string; readonly note: string }[]
  /** Everything the person wrote, beside an AGREE as much as a DISAGREE: an objection to a convention arrives here. */
  readonly notes: readonly { readonly id: string; readonly verdict: string; readonly note: string }[]
  readonly problems: readonly string[]
}

export interface GoldenReport {
  readonly cases: number
  readonly deterministic: readonly FieldAgreement[]
  /** The six `DETERMINISTIC_FIELDS` checks pooled over every case: the G2 headline. */
  readonly deterministicRate: number
  readonly citationClass: FieldAgreement
  /**
   * ADR-0005's hard constraint: a URL a human labelled as anything else must
   * never come back `owned`. Any count above zero is a correctness failure, not
   * an accuracy shortfall — it inflates the customer's own number.
   */
  readonly silentOwned: readonly { caseId: string; url: string; expected: SourceClass }[]
  readonly gateStatus: 'NOT_RUN' | 'PROPOSED' | 'PASS' | 'FAIL'
  readonly gateNote: string
}

/**
 * What `runGoldenSet` returns: the report, plus whose labels it rests on and
 * where the spot-check stands. A separate type because `GoldenReport` is also
 * built by hand elsewhere (the version diff's tests), and those literals are
 * about agreement, not about who labelled what.
 */
export interface GoldenSetReport extends GoldenReport {
  /** Whose labels these are. `proposed` is agent-proposed and unverified. */
  readonly labels: { readonly human: number; readonly proposed: number; readonly verified: number }
  /**
   * Was anything measured at all? A rate of 0 from an empty set, or a citation
   * rate of 0 from a set with no citations, is "nothing measured", not "zero
   * agreement" and not "zero silently owned". The numeric rates stay numbers
   * because the version diff reads them; a reader checks this first.
   */
  readonly measured: { readonly deterministic: boolean; readonly citations: boolean }
  /**
   * The case-level reading of the deterministic figure: cases where all six
   * checks agree. A case is the sampling unit, so THIS has an honest interval
   * (Wilson 95%); the pooled rate does not, its checks move together.
   */
  readonly casesFullyAgreed: { readonly agreed: number; readonly total: number; readonly interval: { readonly low: number; readonly high: number } | null }
  /** Silent-owned over every labelled citation: the third G2 figure, as a rate. Meaningless unless `measured.citations`. */
  readonly silentOwnedRate: number
  /** Wilson 95% upper bound on the silent-owned rate. Zero observed is not zero proven: 0 of 640 is compatible with 0.6%. */
  readonly silentOwnedUpper: number | null
  readonly spotCheck: SpotCheckStanding
}

const eqArray = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Where the proposed labels stand, from the set and the sheet as a person left
 * it. Pure, and it trusts nothing the caller concluded: the sample is drawn
 * HERE, from the cases, under the recorded seed.
 */
function standingOf(cases: readonly GoldenCase[], sheet: SpotCheckSheet | undefined): SpotCheckStanding {
  const expected = spotCheckSample(cases)
  const required = expected.length
  const minAgree = spotCheckMinAgree(required)
  const base = { required, minAgree, checked: 0, agreed: 0, interval: null, checkedBy: null, disputed: [], notes: [], problems: [] as string[] }
  // Needed while ANY label is still only proposed. Once a person has verified every one of them, their word is on each label.
  if (!cases.some(isProposed)) return { ...base, status: 'not-needed' }
  if (!sheet) return { ...base, status: 'missing' }

  const problems: string[] = []
  if (sheet.seed !== SPOT_CHECK_SEED) problems.push(`the sheet's sample seed is ${sheet.seed ?? 'missing'}, not ${SPOT_CHECK_SEED}: a sample drawn any other way is a chosen one`)
  if (!sheet.checkedBy.trim()) problems.push('nobody has signed the spot-check: the "Checked by" line is empty')
  const population = spotCheckPopulation(cases)
  if (sheet.population !== population.fingerprint) problems.push(`the sheet was drawn from a different set of agent-proposed labels (it records ${sheet.population ?? 'none'}, the set on file is ${population.fingerprint} with ${population.count}): cases were added or removed since it was written`)

  const expectedIds = new Set(expected.map((c) => c.id))
  const ids = sheet.entries.map((e) => e.id)
  if (new Set(ids).size !== ids.length) problems.push('the sheet lists a case twice')
  const missing = [...expectedIds].filter((id) => !ids.includes(id))
  const extra = ids.filter((id) => !expectedIds.has(id))
  if (missing.length || extra.length) {
    problems.push(`the sheet is not the seeded sample of this set (${missing.length} sampled case(s) missing, ${extra.length} case(s) the seed did not draw${extra.length ? `: ${extra.slice(0, 5).join(', ')}` : ''}): regenerate it, the set has changed since it was written`)
  }
  const byId = new Map(cases.map((c) => [c.id, c]))
  // A label the person DISPUTED is expected to change: that is the correction. One they agreed with, or have not reached, may not.
  const stale = sheet.entries.filter((e) => e.verdict !== 'disagree' && byId.has(e.id) && labelFingerprint(byId.get(e.id)!) !== e.fingerprint).map((e) => e.id)
  if (stale.length) problems.push(`${stale.length} label(s) changed after the sheet was written, so what was checked is not what is on file: ${stale.slice(0, 5).join(', ')}`)

  // Only an entry for a case the seed drew can vote. Anything else is already a problem above.
  const inSample = sheet.entries.filter((e) => expectedIds.has(e.id))
  const both = inSample.filter((e) => e.verdict === 'both').map((e) => e.id)
  if (both.length) problems.push(`${both.length} answer(s) have both boxes ticked: ${both.slice(0, 5).join(', ')}`)
  const agreedIds = inSample.filter((e) => e.verdict === 'agree')
  const disputed = inSample.filter((e) => e.verdict === 'disagree').map((e) => ({ id: e.id, note: e.note }))
  const checked = agreedIds.length + disputed.length
  if (checked < required) problems.push(`${required - checked} of ${required} case(s) have no answer yet`)
  // Cannot happen once the ids are the sample and listed once; said anyway, because the threshold below is a RATE over `checked`.
  if (checked > required) problems.push(`the sheet answers ${checked} case(s) and the sample is ${required}`)

  const agreed = agreedIds.length
  const w = checked > 0 ? wilson(agreed, checked) : null
  const notes = sheet.entries.filter((e) => e.note.trim()).map((e) => ({ id: e.id, verdict: e.verdict, note: e.note }))
  const seen = { ...base, checked, agreed, interval: w ? { low: w.ci_low, high: w.ci_high } : null, checkedBy: sheet.checkedBy.trim() || null, disputed, notes }
  if (problems.length) return { ...seen, status: 'unusable', problems }
  // A rate over exactly the required sample: 29 agreed of 81 answered is 36%, and was once read as "29, accepted" (E4 review, B2).
  if (checked !== required || agreed < spotCheckMinAgree(checked)) return { ...seen, status: 'below-threshold' }
  return { ...seen, status: 'accepted' }
}

/**
 * Run the scorer over every labelled case and report agreement per field.
 * Never throws on disagreement — disagreement is the output.
 *
 * @param sheet the spot-check sheet as a person left it (`parseSpotCheckSheet`).
 *              Without it a set holding any proposed label can reach NOT_RUN
 *              or PROPOSED and nothing else. With it, the harness still decides
 *              for itself whether the sheet can be used.
 */
export function runGoldenSet(cases: readonly GoldenCase[], sheet?: SpotCheckSheet): GoldenSetReport {
  const fields: Record<string, { agreed: number; total: number; disagreements: { caseId: string; expected: unknown; actual: unknown }[] }> = Object.fromEntries(
    DETERMINISTIC_FIELDS.map((f) => [f, { agreed: 0, total: 0, disagreements: [] }]),
  )
  const citation = { agreed: 0, total: 0, disagreements: [] as { caseId: string; expected: unknown; actual: unknown }[] }
  const silentOwned: { caseId: string; url: string; expected: SourceClass }[] = []
  let fullyAgreed = 0

  const standing = standingOf(cases, sheet)

  for (const c of cases) {
    let caseAgrees = true
    const row = scoreAnswer({
      answer: c.answer,
      brand: c.brand,
      ...(c.competitors ? { competitors: c.competitors } : {}),
      ...(c.publishers ? { publishers: c.publishers } : {}),
    })

    const check = (field: string, expected: unknown, actual: unknown, ok: boolean) => {
      const f = fields[field]!
      f.total++
      if (ok) f.agreed++
      else {
        caseAgrees = false
        f.disagreements.push({ caseId: c.id, expected, actual })
      }
    }
    check('mentioned', c.label.mentioned, row.mentioned, c.label.mentioned === row.mentioned)
    check('mentionCount', c.label.mentionCount, row.mentionCount, c.label.mentionCount === row.mentionCount)
    check('brandsDetected', c.label.brandsDetected, row.brandsDetected, c.label.brandsDetected === row.brandsDetected)
    check('cited', c.label.cited, row.cited, c.label.cited === row.cited)
    check('position', c.label.position, row.position, c.label.position === row.position)
    check(
      'competitorsMentioned',
      c.label.competitorsMentioned,
      row.competitorsMentioned,
      eqArray(c.label.competitorsMentioned, row.competitorsMentioned),
    )

    for (const got of row.citations) {
      const expected = c.label.citationClasses[String(got.position)]
      if (expected === undefined) continue // unlabelled citation: not counted either way
      citation.total++
      if (expected === got.sourceClass) citation.agreed++
      else {
        citation.disagreements.push({ caseId: c.id, expected: `${got.url} => ${expected}`, actual: got.sourceClass })
        if (got.sourceClass === 'owned') silentOwned.push({ caseId: c.id, url: got.url, expected })
      }
    }
    if (caseAgrees) fullyAgreed++
  }

  const deterministic = Object.entries(fields).map(([field, f]) => ({
    field,
    agreed: f.agreed,
    total: f.total,
    rate: f.total === 0 ? 0 : f.agreed / f.total,
    disagreements: f.disagreements,
  }))
  const agreedAll = deterministic.reduce((s, f) => s + f.agreed, 0)
  const totalAll = deterministic.reduce((s, f) => s + f.total, 0)
  const deterministicRate = totalAll === 0 ? 0 : agreedAll / totalAll
  const citationRate = citation.total === 0 ? 0 : citation.agreed / citation.total
  const silentOwnedRate = citation.total === 0 ? 0 : silentOwned.length / citation.total
  const fullyW = cases.length > 0 ? wilson(fullyAgreed, cases.length) : null
  const fullyInterval = fullyW ? { low: fullyW.ci_low, high: fullyW.ci_high } : null

  const labels = {
    human: cases.filter((c) => c.labelledBy !== 'agent-proposed').length,
    proposed: cases.filter(isProposed).length,
    verified: cases.filter((c) => c.labelledBy === 'agent-proposed' && isVerified(c)).length,
  }
  // Every figure with its denominator: a rate that does not say what it is a rate OF is the thing this product refuses to ship.
  const figures = `deterministic ${(deterministicRate * 100).toFixed(1)}% (${agreedAll}/${totalAll} checks, need 95), citation class ${(citationRate * 100).toFixed(1)}% (${citation.agreed}/${citation.total}, need 97), silent owned ${silentOwned.length} of ${citation.total} (need 0)`
  const whose = labels.proposed > 0 ? ` — ${labels.proposed} of them agent-proposed and unverified` : ''

  let gateStatus: GoldenReport['gateStatus'] = 'NOT_RUN'
  let gateNote = `golden set holds ${cases.length} of ${GOLDEN_SET_TARGET} cases${whose} — G2 agreement thresholds are NOT RUN until it is populated`
  if (cases.length >= GOLDEN_SET_TARGET) {
    const judged = standing.status === 'not-needed' || standing.status === 'accepted'
    if (!judged) {
      // The one branch a proposed label can reach at full size. There is no `pass` computed here on purpose.
      gateStatus = 'PROPOSED'
      const why =
        standing.status === 'missing'
          ? `no human spot-check is recorded (a person checks a seeded random ${standing.required})`
          : standing.status === 'below-threshold'
            ? `the spot-check agreed with ${standing.agreed} of ${standing.checked}, below the ${standing.minAgree} required, so the proposed labels are not accepted as ground truth`
            : `the recorded spot-check cannot be used: ${standing.problems.join('; ')}`
      gateNote = `PROPOSED, not a verdict: ${labels.proposed} label(s) are agent-proposed and ${why}. Reported: ${figures}`
    } else {
      const pass = deterministicRate >= 0.95 && citationRate >= 0.97 && silentOwned.length === 0
      gateStatus = pass ? 'PASS' : 'FAIL'
      const checkedNote =
        standing.status === 'accepted'
          ? `; proposed labels accepted on ${standing.checkedBy}'s spot-check, ${standing.agreed} of ${standing.checked} agreed (95% interval ${(standing.interval!.low * 100).toFixed(1)}% to ${(standing.interval!.high * 100).toFixed(1)}%)` +
            (standing.disputed.length ? `, ${standing.disputed.length} label(s) the person disputed are still counted until corrected: ${standing.disputed.map((d) => d.id).join(', ')}` : '')
          : ''
      gateNote = figures + checkedNote
    }
  }

  return {
    cases: cases.length,
    labels,
    deterministic,
    deterministicRate,
    citationClass: { field: 'sourceClass', agreed: citation.agreed, total: citation.total, rate: citationRate, disagreements: citation.disagreements },
    silentOwned,
    measured: { deterministic: totalAll > 0, citations: citation.total > 0 },
    casesFullyAgreed: { agreed: fullyAgreed, total: cases.length, interval: fullyInterval },
    silentOwnedRate,
    silentOwnedUpper: citation.total > 0 ? wilson(silentOwned.length, citation.total).ci_high : null,
    spotCheck: standing,
    gateStatus,
    gateNote,
  }
}

/** Structural validation of a labelled case, so a bad label fails at load. */
export function validateGoldenCase(c: GoldenCase): string[] {
  const errs: string[] = []
  if (!c.id) errs.push('missing id')
  if (!c.brand?.id) errs.push(`${c.id}: missing brand.id`)
  if (!c.brand?.aliases?.length) errs.push(`${c.id}: brand has no aliases — mention detection would always be false`)
  if (typeof c.answer?.text !== 'string') errs.push(`${c.id}: answer.text must be a string`)
  if (!Array.isArray(c.answer?.citations)) errs.push(`${c.id}: answer.citations must be an array`)
  if (c.label?.mentioned === false && c.label?.position !== null) errs.push(`${c.id}: not mentioned but position is not null`)
  if (typeof c.label?.mentionCount !== 'number') errs.push(`${c.id}: label.mentionCount is required`)
  if (typeof c.label?.brandsDetected !== 'number') errs.push(`${c.id}: label.brandsDetected is required`)
  if (c.label?.mentioned === false && c.label?.mentionCount !== 0) errs.push(`${c.id}: not mentioned but mentionCount is not 0`)
  if (c.label?.mentioned === true && (c.label?.mentionCount ?? 0) < 1) errs.push(`${c.id}: mentioned but mentionCount is 0`)
  // Every citation must be labelled or explicitly skipped. A partially-labelled
  // case silently shrinks the citation-class denominator as the set grows.
  for (const cit of c.answer?.citations ?? []) {
    if (c.label?.citationClasses?.[String(cit.position)] === undefined) {
      errs.push(`${c.id}: citation at position ${cit.position} has no label`)
    }
  }
  if (c.label?.mentioned === true && c.label?.position === null) errs.push(`${c.id}: mentioned but position is null`)
  for (const [pos, cls] of Object.entries(c.label?.citationClasses ?? {})) {
    if (!c.answer.citations.some((x) => String(x.position) === pos)) errs.push(`${c.id}: label for citation position ${pos} which does not exist`)
    if (cls === 'owned' && !c.brand.domains?.length) errs.push(`${c.id}: labelled 'owned' but the brand has no domains`)
  }

  // Whose label it is. A real stored answer always says; an agent's label always shows its working.
  if (c.labelledBy !== undefined && c.labelledBy !== 'human' && c.labelledBy !== 'agent-proposed') errs.push(`${c.id}: labelledBy must be 'human' or 'agent-proposed'`)
  if (c.source?.cell && c.labelledBy === undefined) errs.push(`${c.id}: a case from a stored cell must say who labelled it (labelledBy)`)
  if (c.verifiedBy !== undefined && c.verifiedBy !== null && (typeof c.verifiedBy !== 'string' || !c.verifiedBy.trim())) errs.push(`${c.id}: verifiedBy is a person's name, or null`)
  if (typeof c.verifiedBy === 'string' && c.verifiedBy.trim() && c.label && Array.isArray(c.answer?.citations)) {
    if (!c.verifiedFingerprint) errs.push(`${c.id}: verifiedBy needs verifiedFingerprint, the fingerprint of the label ${c.verifiedBy} checked`)
    else if (c.verifiedFingerprint !== labelFingerprint(c)) errs.push(`${c.id}: the label changed after ${c.verifiedBy} verified it (${c.verifiedFingerprint} is no longer its fingerprint): it is a proposal again until somebody verifies it`)
  }
  if (c.labelledBy === 'agent-proposed') {
    if (c.verifiedBy === undefined) errs.push(`${c.id}: an agent-proposed label carries verifiedBy (null until a person checks it)`)
    if (!c.evidence) errs.push(`${c.id}: an agent-proposed label must carry its evidence`)
    else errs.push(...validateEvidence(c))
  }
  return errs
}

/**
 * Is the evidence consistent with the text and with the label it supports?
 *
 * Mechanical, and it never calls the scorer: a span must stand at its offset,
 * the subject's spans must number `mentionCount`, the order must follow the
 * offsets, and `position`, `brandsDetected` and `competitorsMentioned` must be
 * what that order says. It cannot tell whether the labeller MISSED a mention;
 * it can tell that nothing they claimed is invented.
 */
export function validateEvidence(c: GoldenCase): string[] {
  const errs: string[] = []
  const ev = c.evidence
  if (!ev) return [`${c.id}: no evidence`]
  if (!Array.isArray(ev.mentions) || !Array.isArray(ev.order) || typeof ev.citations !== 'object' || ev.citations === null) return [`${c.id}: evidence needs mentions[], order[] and citations{}`]

  const text = c.answer.text
  const nameOf = new Map<string, string>([[c.brand.id, c.brand.name], ...(c.competitors ?? []).filter((b) => b.id !== c.brand.id).map((b) => [b.id, b.name] as [string, string])])
  const first = new Map<string, number>()
  for (const m of ev.mentions) {
    if (!nameOf.has(m.brand)) {
      errs.push(`${c.id}: evidence names brand "${m.brand}", which is neither the subject nor in the competitor set`)
      continue
    }
    if (typeof m.span !== 'string' || !m.span || !Number.isInteger(m.offset) || m.offset < 0) {
      errs.push(`${c.id}: evidence for ${m.brand} needs a non-empty span and a whole, non-negative offset`)
      continue
    }
    if (text.slice(m.offset, m.offset + m.span.length) !== m.span) errs.push(`${c.id}: "${m.span}" is not at offset ${m.offset} of the answer`)
    first.set(m.brand, Math.min(first.get(m.brand) ?? Infinity, m.offset))
  }

  const subject = ev.mentions.filter((m) => m.brand === c.brand.id).sort((a, b) => a.offset - b.offset)
  if (subject.length !== c.label.mentionCount) errs.push(`${c.id}: mentionCount is ${c.label.mentionCount} but the evidence quotes ${subject.length} occurrence(s) of the subject`)
  subject.forEach((m, i) => {
    const prev = subject[i - 1]
    if (prev && m.offset < prev.offset + prev.span.length) errs.push(`${c.id}: two subject spans overlap at offset ${m.offset}; one stretch of text is one mention`)
  })

  // The order must be the brands in the evidence, by first offset. Equal offsets may stand in either order.
  const names = new Set([...first.keys()].map((id) => nameOf.get(id)!))
  if (names.size !== ev.order.length || ev.order.some((n) => !names.has(n))) errs.push(`${c.id}: evidence.order must list exactly the brands the evidence quotes (${[...names].join(', ') || 'none'})`)
  const idOf = new Map([...nameOf].map(([id, name]) => [name, id]))
  for (let i = 1; i < ev.order.length; i++) {
    const a = first.get(idOf.get(ev.order[i - 1]!) ?? '')
    const b = first.get(idOf.get(ev.order[i]!) ?? '')
    if (a !== undefined && b !== undefined && a > b) errs.push(`${c.id}: evidence.order puts ${ev.order[i - 1]} before ${ev.order[i]}, but it first appears later (${a} > ${b})`)
  }

  const at = ev.order.indexOf(c.brand.name)
  const position = at >= 0 ? at + 1 : null
  if (position !== c.label.position) errs.push(`${c.id}: label.position is ${c.label.position} but the evidence order gives ${position}`)
  if (ev.order.length !== c.label.brandsDetected) errs.push(`${c.id}: label.brandsDetected is ${c.label.brandsDetected} but the evidence order holds ${ev.order.length}`)
  const rivals = ev.order.filter((n) => n !== c.brand.name)
  if (!eqArray(rivals, c.label.competitorsMentioned)) errs.push(`${c.id}: label.competitorsMentioned is [${c.label.competitorsMentioned.join(', ')}] but the evidence order gives [${rivals.join(', ')}]`)

  for (const cit of c.answer.citations) {
    const why = ev.citations[String(cit.position)]
    if (typeof why !== 'string' || !why.trim()) errs.push(`${c.id}: citation ${cit.position} has a class and no reason`)
  }
  for (const pos of Object.keys(ev.citations)) if (!c.answer.citations.some((x) => String(x.position) === pos)) errs.push(`${c.id}: a reason is given for citation ${pos}, which does not exist`)
  return errs
}
