/**
 * THE AGENCY PORTFOLIO'S ROWS, as a model (MVP_PLAN D1): everything a row says
 * about one client, decided here from that client's REAL cycles and its
 * tracked status, so each sentence can be tested without a browser.
 *
 * ⚠️ NOTHING HERE IS INVENTED. Until D1 the portfolio carried six illustrative
 * clients with made-up counts (their file is deleted). A row now exists only
 * for a domain the person added, and carries a number only when a cycle
 * exists for it: the latest cycle's own metric, with its range and its n,
 * through `packages/stats`. And a row SAYS what kind of cycle that is: a
 * check this machine collected, the reference scan bundled with the build, or
 * a cycle over fixture answers. The first draft said "every number on this
 * page comes from a check this machine really collected", which was false of
 * the other two (statistics review of D1, MAJOR 2).
 *
 * ⚠️ NO TWO ROWS ARE COMPARED WITH EACH OTHER, EVER. Each client is measured
 * over its own category's questions, or over its own, so no two rows share a
 * basis: that is the NORMAL state of a portfolio, not a special case of
 * own-set rows (review, MAJOR 3; the C3 statistics pass, MAJOR 3). The page
 * says so unconditionally. So rows are ordered by what needs a person's
 * ATTENTION, which is a fact about one client's own record over time, never
 * about how its rate stands against another's:
 *
 *   0  its rate is lower and the ranges separate, against the check before it
 *      OR against the oldest check comparable with the latest (see below);
 *   1  its daily checks have ended, end today, or have fallen behind;
 *   2  it is not set to be re-checked daily, or that could not be read here;
 *   3  nothing to do. Within a group, by name.
 *
 * ⚠️ THE LAST PAIR ALONE MISSES A SUSTAINED FALL (review, MAJOR 6, measured:
 * fourteen daily checks drifting 60% to 25%, every neighbouring pair inside
 * the range, first against last separated). A daily loop manufactures exactly
 * that shape. So ONE more pair is compared, fixed in advance and never
 * searched for: the latest against the oldest check in the unbroken run of
 * checks comparable with it (same questions, same engines, same scoring
 * version, same collection path). Two comparisons per client, both
 * `compare()`'s through `compareCycles`, so every guard it has still speaks.
 * ⚠️ HUMAN REVIEW REQUIRED: statistics (a second, non-adjacent comparison).
 *
 * The words are `compare()`'s verdict and no more: "lower, and the two ranges
 * do not overlap", never "really fell". The floor on n and the design effect
 * are PROVISIONAL pending G0, so the ranges are narrower than the sampling
 * design supports, and a sentence about the world would claim more than the
 * test does (review, MINOR 2). No arrow, no delta; a movement inside the
 * range reads "no real change" (R8).
 */

import { MIN_N_FOR_COMPARISON, formatInterval, formatValue, type Metric } from '@bliprank/stats'
import { compareCycles, continuousCycles } from './compare-cycles'
import { cycleDayOf, whyInPlainWords } from './cycles'
import { promptSetOf, type PromptSetRef } from './prompt-set'
import { BUNDLED_SCANS, runInfoOf, subjectOf, type ScanResultFile } from './scan-result'
import type { TrackedStatus } from './tracked'

/** `undefined`: not read yet. `null`: asked, and it could not be read here. */
export type TrackedRead = TrackedStatus | null

export interface PortfolioRowModel {
  readonly domain: string
  readonly categoryName: string
  /** Set when the category was NOT identified and the general bank was asked: the row may not print the category as if it had been determined. */
  readonly categoryNote: string | null
  readonly metric: Metric
  /** `25.9% of answers (17.0–31.2%, n=85)`: the value and the range from packages/stats, with the noun a percentage needs and the rate's own n. */
  readonly stated: string
  readonly day: string
  readonly cycles: number
  /** What kind of cycle the number comes from, and the sentence to print when it is not a check this machine collected. */
  readonly origin: 'collected' | 'reference' | 'fixture'
  readonly originNote: string | null
  /** The trend verdict in plain words. Never an arrow, never a bare delta. */
  readonly movement: string
  /** The daily re-check, worded as the INSTRUCTION it is, never as an outcome. */
  readonly tracking: string
  /** Set when the number was measured over the client's own questions. */
  readonly ownSet: PromptSetRef | null
  readonly ownSetWords: string | null
  readonly attention: { readonly rank: 0 | 1 | 2 | 3; readonly why: string | null }
}

const dayBefore = (day: string): string => new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10)
const days = (n: number): string => `${n} more day${n === 1 ? '' : 's'}`

/** `25.9% of answers (17.0–31.2%, n=85)`. The value and the range are packages/stats' own strings; the noun is what a client needs to know 25.9% OF WHAT (review, MINOR 5). */
export const statedOf = (m: Metric): string => `${formatValue(m)} of answers (${formatInterval(m)}, n=${m.n})`

/**
 * The oldest check in the unbroken run of checks comparable with the latest,
 * or null when that is the check before it (already compared) or there is
 * none. Walks back from the latest and stops at the first boundary, so a
 * change of questions, engines, scoring version or path is never crossed.
 */
function oldestComparable(cycles: readonly ScanResultFile[]): ScanResultFile | null {
  const latest = cycles[cycles.length - 1]
  if (!latest || cycles.length < 3) return null
  let i = cycles.length - 1
  while (i > 0 && continuousCycles(subjectOf(cycles[i]!).metric, subjectOf(cycles[i - 1]!).metric)) i -= 1
  return i < cycles.length - 2 ? cycles[i]! : null
}

/** What the client's own checks say over time, in words a client would use. `compare()` decides; this only words its verdicts. */
export function movementWords(cycles: readonly ScanResultFile[]): { readonly words: string; readonly lower: string | null } {
  const latest = cycles[cycles.length - 1]
  if (!latest) return { words: 'no check yet', lower: null }
  const previous = cycles[cycles.length - 2]
  if (!previous) return { words: 'one check so far, so there is no trend yet', lower: null }
  const a = subjectOf(latest).metric
  const b = subjectOf(previous).metric
  const before = cycleDayOf(previous)
  const verdict = compareCycles(a, b)
  let words: string
  let lower: string | null = null
  switch (verdict.significance) {
    case 'higher':
      words = `higher than at the check before (${before}): the two ranges do not overlap`
      break
    case 'lower':
      words = `lower than at the check before (${before}): the two ranges do not overlap`
      lower = `it is lower than at the check before (${before}), and the two ranges do not overlap`
      break
    case 'no-significant-change':
      words = `no real change since the check before (${before}): the two ranges overlap`
      break
    case 'insufficient-data':
      // A set this small can NEVER be compared, so a rise or a fall could not show on this page at all: said, because the order
      // above advertises that it surfaces a fall (review, MINOR 9; the floor itself is the methodology owner's open question).
      words = `too few answers to compare with the check before (${before}); with fewer than ${MIN_N_FOR_COMPARISON} answers a check, a rise or a fall cannot show here`
      break
    case 'not-comparable':
      words = `not comparable with the check before (${before}): ${whyInPlainWords(a, b)}`
      break
  }
  // The one further pair, fixed in advance: the latest against the oldest check comparable with it.
  const oldest = oldestComparable(cycles)
  if (oldest && verdict.significance !== 'lower') {
    const window = compareCycles(a, subjectOf(oldest).metric)
    const since = cycleDayOf(oldest)
    if (window.significance === 'lower') {
      words += `; lower than on ${since}, the oldest check comparable with it: those two ranges do not overlap`
      lower = `it is lower than on ${since}, the oldest check comparable with it, and those two ranges do not overlap, though no single check moved outside the range`
    } else if (window.significance === 'higher') {
      words += `; higher than on ${since}, the oldest check comparable with it: those two ranges do not overlap`
    }
  }
  return { words, lower }
}

/**
 * The daily re-check in words, and whether it needs a person.
 *
 * ⚠️ WORDED AS THE INSTRUCTION, NEVER AS THE OUTCOME (review, MAJOR 1). An
 * entry in the tracked list says a person ASKED for a daily re-check until a
 * day. Whether one runs depends on a loop that is armed on no machine yet;
 * every other surface pairs the instruction with the schedule's own caveat,
 * and the page prints that caveat once above the rows. "Checked daily" was a
 * claim about the world; "set to be re-checked daily" is what is known.
 *
 * `today` is the UTC day, the day a cycle is filed under. An entry whose last
 * day has passed is ENDED whatever its `tracked` flag says: the status was
 * read when the page opened, and a tab left open across midnight UTC must not
 * say "today is the last day" of an entry that ended yesterday (MINOR 4).
 */
export function trackingWords(status: TrackedRead | undefined, latestDay: string, today: string): { readonly words: string; readonly needs: string | null; readonly rank: 1 | 2 | 3 } {
  if (status === undefined) return { words: 'reading whether it is set to be re-checked daily', needs: null, rank: 3 }
  // Asked, and it could not be read (a deployment with sign-in on, a fleet): said, and never ranked with the fine (MINOR 1).
  if (status === null) return { words: 'whether it is set to be re-checked daily could not be read here', needs: 'its daily re-check could not be read here', rank: 2 }
  if (status.until !== undefined && status.until < today) return { words: `its daily re-check ended on ${status.until}`, needs: `its daily re-check ended on ${status.until}`, rank: 1 }
  if (!status.tracked) return { words: 'not set to be re-checked daily', needs: 'it is not set to be re-checked daily', rank: 2 }
  const left = typeof status.daysLeft === 'number' && status.daysLeft >= 0 ? status.daysLeft : undefined
  const until = status.until ? ` until ${status.until}${left !== undefined ? ` (${left === 0 ? 'today is the last day' : days(left)})` : ''}` : ''
  const words = `set to be re-checked daily${until}`
  if (left === 0) return { words, needs: 'its daily re-check ends today', rank: 1 }
  // Set to be re-checked, and the newest check is older than yesterday: the re-check has not been happening.
  if (latestDay && latestDay < dayBefore(today)) return { words: `${words}; its latest check is from ${latestDay}`, needs: `it is set to be re-checked daily, and its latest check is from ${latestDay}`, rank: 1 }
  return { words, needs: null, rank: 3 }
}

/** In AGENCY chrome the reader is the agency and the questions are the client's: "your 3 prompts" would be ambiguous about whose (review, MINOR 8). Same count, same version, same word the record uses. */
const clientSetWords = (s: PromptSetRef): string => `this client’s own ${s.count} ${s.count === 1 ? 'prompt' : 'prompts'}, version ${s.version}`

export const REFERENCE_NOTE = 'Reference scan: a demonstration record bundled with this build and shown to every visitor. It is a real collected scan, and it is not a check this machine collected for this client.'
export const FIXTURE_NOTE = 'Fixture answers: this cycle ran the real pipeline over fixture answers, offline. It is not a measurement of what the engines say.'
export const FALLBACK_NOTE = 'Its category was not identified, so it was asked the general business-software questions. That is a real measurement, and it is not comparable with a check asked a category’s questions.'
export const UNREADABLE_SET_NOTE = 'measured over a set of its own questions that this page cannot read from the record'

/** One client's row, or null when it has no cycle at all (then it is a queued row, which carries no number). */
export function portfolioRowOf(domain: string, cycles: readonly ScanResultFile[], status: TrackedRead | undefined, today: string): PortfolioRowModel | null {
  const latest = cycles[cycles.length - 1]
  if (!latest) return null
  const metric = subjectOf(latest).metric
  const day = cycleDayOf(latest)
  const movement = movementWords(cycles)
  const tracking = trackingWords(status, day, today)
  const ownSet = promptSetOf(latest.comparisonBasis)
  // A basis that names a set of the client's own and cannot be read must not render UNLABELLED beside category rows: on this page the
  // safe direction is to say so (review, NOTE 3).
  const unreadableSet = ownSet === null && /\|custom=/.test(latest.comparisonBasis ?? '')
  const mode = runInfoOf(latest).mode
  const origin: PortfolioRowModel['origin'] = BUNDLED_SCANS.includes(latest) ? 'reference' : mode === 'fixture' || mode === 'stub' ? 'fixture' : 'collected'
  const attention: PortfolioRowModel['attention'] = movement.lower ? { rank: 0, why: movement.lower } : tracking.needs ? { rank: tracking.rank, why: tracking.needs } : { rank: 3, why: null }
  return {
    domain,
    categoryName: latest.categoryName,
    categoryNote: latest.fallback ? FALLBACK_NOTE : null,
    metric,
    stated: statedOf(metric),
    day,
    cycles: cycles.length,
    origin,
    originNote: origin === 'reference' ? REFERENCE_NOTE : origin === 'fixture' ? FIXTURE_NOTE : null,
    movement: movement.words,
    tracking: tracking.words,
    ownSet,
    ownSetWords: ownSet ? clientSetWords(ownSet) : unreadableSet ? UNREADABLE_SET_NOTE.replace(/^measured over /, '') : null,
    attention,
  }
}

/** By what needs attention, then by name. NEVER by rate. */
export function byAttention(rows: readonly PortfolioRowModel[]): readonly PortfolioRowModel[] {
  return [...rows].sort((a, b) => a.attention.rank - b.attention.rank || a.domain.localeCompare(b.domain))
}

export const ORDER_NOTE =
  'Ordered by what needs attention, never by rate: first a client whose own rate is lower than at an earlier check of its own with the two ranges not overlapping, then daily re-checks that have ended, end today or have fallen behind, then clients not set to be re-checked daily, and the rest by name.'

/** Unconditional: it is the normal state of a portfolio, not a special case of own-set rows (review, MAJOR 3). */
export const NOT_A_RANKING =
  'No two rows on this page are compared with each other, whether their ranges overlap or not. Each client is measured over its own category’s questions, or over questions of its own, so the rates answer different questions: a higher rate here is not a better position than a lower one there.'

export const OWN_SET_NOTE = 'Some clients here are measured over questions of their own rather than their category’s, and the row says so.'

export const PORTFOLIO_NOTICE =
  'Every rate on this page comes from a cycle a budgeted runner filed, and a row says when that cycle is the bundled reference scan or ran over fixture answers. The list of clients lives in this browser only: there are no agency accounts in this build, so nothing here is billed, metered or shared.'

export const UTC_NOTE = 'Days on this page are UTC days, the day a check is filed under.'
