/**
 * Metric formatting — CLAUDE.md §8: "Numbers in UI always formatted through
 * packages/stats/format so intervals never get dropped."
 *
 * ⚠️ HUMAN-OWNED (CLAUDE.md §4): this file decides what a customer is told a
 * number means. The arithmetic is trivial; the judgement is not.
 *
 * This is where rule R8 is enforced in code rather than in a review comment.
 * The type makes the interval non-optional, so a component physically cannot
 * render a point estimate: there is no shape you can pass to `formatMetric`
 * that omits `ci_low`, `ci_high`, `n`, `algo_version` and `collection_path`.
 * Provenance travels with the number.
 *
 * The significance rule is the other half. If a week-on-week movement falls
 * inside the interval, the UI says "no significant change" — it does not draw a
 * green arrow. A green arrow on noise is the single most common dishonesty in
 * this category, and it is the thing customers pay us not to do.
 */

import type { CollectionPath } from './types.js'

/** The only shape the UI may render. Every field is required, deliberately. */
export interface Metric {
  readonly value: number
  readonly ci_low: number
  readonly ci_high: number
  /** Disclosed sample size. */
  readonly n: number
  readonly algo_version: string
  readonly collection_path: CollectionPath
  /**
   * What this number is a measurement OF — everything that must match before
   * two of them can be compared: engine set, locale, geo, prompt-bank version,
   * window length. Any string, as long as the producer derives it the same way
   * every time.
   *
   * Required, and that is the point. A review found that five engines at
   * 50/30/5/20/20% with one going dark produces 25.0% -> 30.0% with separated
   * intervals and a SIGNIFICANT verdict, while **no engine's rate changed at
   * all**. Version-stamping alone could not see it: the composition of the
   * denominator moved, not the algorithm. That is R8's false arrow, produced by
   * the code that exists to prevent it, so the basis travels with the number
   * exactly as the interval does.
   */
  readonly comparison_basis: string
}

export type Significance = 'higher' | 'lower' | 'no-significant-change' | 'insufficient-data' | 'not-comparable'

/**
 * Minimum disclosed sample before two measurements may be compared at all.
 *
 * ⚠️ PROVISIONAL. 30 is a placeholder chosen to be conservative, not derived.
 * The real floor comes out of G0: once the pilot reports DEFF per engine, the
 * minimum is the n whose effective size n/DEFF still supports a usable
 * interval. Until that number exists, inventing a "better" one would be the
 * same error the G0 criterion was rewritten to avoid — arithmetic dressed as
 * evidence. Tracked against PHASES.md 0.6.
 */
export const MIN_N_FOR_COMPARISON = 30
export const MIN_N_STATUS = 'PROVISIONAL: placeholder pending G0 design-effect data' as const

/**
 * Largest effective false-positive rate we will still call a change at.
 *
 * ⚠️ PROVISIONAL. The overlap test's real type I error is not a constant: it is
 * ~1-in-180 when the two cycles have similar precision and degrades toward the
 * ordinary 1-in-20 as their sample sizes diverge (verified by exact
 * enumeration: n=30 vs n=1000 at p=0.25 gives 1-in-44). Rather than assume the
 * best case, `compare()` computes the actual rate for the pair in front of it
 * and refuses above this line. 0.01 is the point at which the claim "materially
 * stronger than a conventional 95% test" stops being true; the number itself is
 * a judgement, not a derivation.
 */
export const MAX_EFFECTIVE_ALPHA = 0.01

/** Normal CDF, Abramowitz & Stegun 7.1.26 via erf. Accurate to ~1.5e-7. */
function phi(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2)
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - p : p
}

/**
 * The overlap test's ACTUAL false-positive rate for this pair of measurements.
 *
 * Two intervals separate when their gap exceeds z(s1 + s2); under the null the
 * difference has SD sqrt(s1^2 + s2^2). So the effective critical value is
 * z(s1+s2)/sqrt(s1^2+s2^2), which is maximised at s1 = s2 (giving z*sqrt(2),
 * i.e. ~1-in-180) and falls to z as the standard errors diverge (~1-in-20).
 * Half-widths stand in for the standard errors; Wilson is asymmetric, so this
 * is an approximation, and it is used only to decide whether to trust the
 * comparison at all.
 */
export function effectiveAlpha(a: Metric, b: Metric): number {
  const s1 = intervalWidth(a) / 2
  const s2 = intervalWidth(b) / 2
  if (s1 <= 0 || s2 <= 0) return 0.05
  const crit = 1.9599639845400545 * ((s1 + s2) / Math.sqrt(s1 * s1 + s2 * s2))
  return 2 * (1 - phi(crit))
}

export interface Comparison {
  readonly significance: Significance
  /** Signed difference in the metric's own units. Present even when not significant. */
  readonly delta: number
  /** Human-readable verdict for the UI. Never implies a direction it cannot support. */
  readonly label: string
}

const pct = (x: number, dp: number): string => `${(x * 100).toFixed(dp)}%`

/** `23.4%` — the point estimate alone. Never render this without `formatInterval`. */
export function formatValue(m: Metric, dp = 1): string {
  return pct(m.value, dp)
}

/**
 * `17.0–31.2%` — the interval. The unit is written once, on the upper bound:
 * two per-cent signs in a range read as two separate numbers rather than one
 * span, which is the opposite of the point.
 *
 * Both bounds carry the same `dp` as the estimate, an exact zero included:
 * `0.0–4.3%` beside `0.0%`, not `0–4.3%`. The special case that printed a bare
 * `0` was the one row in a tabular-figures column whose decimals did not line
 * up, and it made the lower bound look like a different kind of number from
 * the estimate it belongs to (removed 2026-09-07).
 */
export function formatInterval(m: Metric, dp = 1): string {
  return `${(m.ci_low * 100).toFixed(dp)}–${pct(m.ci_high, dp)}`
}

/**
 * `23.4% (17.0–31.2%, n=150)` — the full disclosure, in one string.
 * Use this anywhere a number appears without a dedicated interval element.
 */
export function formatMetric(m: Metric, dp = 1): string {
  return `${formatValue(m, dp)} (${formatInterval(m, dp)}, n=${m.n})`
}

/** `algo det-1 · third-party-grounded · n=150` — the provenance line (R8). */
export function formatProvenance(m: Metric): string {
  return `algo ${m.algo_version} · ${m.collection_path} · n=${m.n}`
}

/** Half-width of the interval, the honest measure of how much this number knows. */
export function intervalWidth(m: Metric): number {
  return m.ci_high - m.ci_low
}

/**
 * Compare two measurements of the same metric.
 *
 * The test is interval overlap, not a difference of point estimates. Two
 * intervals that overlap are not distinguishable at this sample size, and
 * saying otherwise would be inventing precision we did not measure.
 *
 * Note this is deliberately CONSERVATIVE: non-overlapping intervals imply a
 * significant difference, but overlapping intervals do not prove its absence —
 * for a proper two-proportion test the right answer is a difference interval,
 * which belongs with the DiD work in P7. Erring toward "no significant change"
 * is the correct direction for a product whose claim is restraint.
 */
export function compare(current: Metric, previous: Metric): Comparison {
  const delta = current.value - previous.value

  // R5: a score row is stamped with the algorithm that produced it, and rows
  // from different algorithms are answers to different questions. Comparing
  // across a version bump would silently attribute a definition change to the
  // brand's behaviour, which is precisely the rebasing competitors do and we
  // do not. Same for collection path: an official-API number and a
  // third-party-grounded number are not measurements of the same thing.
  if (current.algo_version !== previous.algo_version) {
    return {
      significance: 'not-comparable',
      delta,
      label: `not comparable: scored by ${previous.algo_version} then ${current.algo_version}`,
    }
  }
  if (current.collection_path !== previous.collection_path) {
    return {
      significance: 'not-comparable',
      delta,
      label: `not comparable: collected via ${previous.collection_path} then ${current.collection_path}`,
    }
  }
  if (current.comparison_basis !== previous.comparison_basis) {
    // The denominator changed shape. An engine dropping out moves the aggregate
    // with no engine's rate moving at all, and separated intervals would render
    // that as a significant rise.
    return {
      significance: 'not-comparable',
      delta,
      label: 'not comparable: measured over a different engine set, locale, geo or window',
    }
  }

  // Below the floor there is no interval worth testing — see MIN_N_FOR_COMPARISON.
  const smallest = Math.min(current.n, previous.n)
  if (smallest < MIN_N_FOR_COMPARISON) {
    return {
      significance: 'insufficient-data',
      delta,
      label: smallest <= 0 ? 'not enough data' : `not enough data (n=${smallest}, need ${MIN_N_FOR_COMPARISON})`,
    }
  }

  const separated = current.ci_low > previous.ci_high || current.ci_high < previous.ci_low
  if (!separated) {
    return { significance: 'no-significant-change', delta, label: 'no significant change' }
  }

  // The intervals separate — but separation only carries the strength we claim
  // when the two cycles are similarly precise. Mismatched precision makes this
  // an ordinary 95% test wearing a 99.4% badge, so it is refused rather than
  // reported at a confidence we did not earn.
  const alpha = effectiveAlpha(current, previous)
  if (alpha > MAX_EFFECTIVE_ALPHA) {
    return {
      significance: 'not-comparable',
      delta,
      label: `not comparable: the two cycles differ too much in precision (n=${previous.n} then ${current.n})`,
    }
  }

  const direction: Significance = delta > 0 ? 'higher' : 'lower'
  return {
    significance: direction,
    delta,
    label: `${delta > 0 ? '+' : '−'}${pct(Math.abs(delta), 1)} vs previous`,
  }
}

/**
 * ⚠️ PROVISIONAL — these four numbers have no empirical basis.
 *
 * 0.1 / 0.2 / 0.35 interval width were picked by hand to feel about right. They
 * decide what a prospect is told about their own data on the free surface, so
 * "about right" is not good enough. The real thresholds get derived from G0
 * pilot output: the interval width actually achieved at each tier's runs-per-
 * cell, once DEFF is known per engine.
 *
 * Deliberately NOT replaced with a different invented number in the meantime —
 * a second guess would look more considered while being exactly as unfounded.
 */
export const CONFIDENCE_GRADE_THRESHOLDS = { A: 0.1, B: 0.2, C: 0.35 } as const
export const CONFIDENCE_GRADE_STATUS = 'PROVISIONAL: hand-picked, pending G0 pilot data' as const

/** True when this build is customer-facing, so provisional numbers must not ship. */
export function isLiveFacingBuild(env: Record<string, string | undefined> = process.env): boolean {
  return (env['BLIPRANK_ENV'] ?? env['NEXT_PUBLIC_BLIPRANK_ENV']) === 'live'
}

export class ProvisionalMetricError extends Error {
  override readonly name = 'ProvisionalMetricError'
}

/**
 * Module-scope guard for any page that renders a provisional number.
 *
 * `confidenceGrade` throwing is not enough on its own: in a client component it
 * only runs when a user interacts, so a live build would compile happily and
 * fail in front of the customer instead. Called at module scope, this fails the
 * BUILD, which is where a shipping-blocker belongs.
 */
export function assertProvisionalAllowed(what: string, env: Record<string, string | undefined> = process.env): void {
  if (isLiveFacingBuild(env)) {
    throw new ProvisionalMetricError(
      `${what} depends on provisional numbers (${CONFIDENCE_GRADE_STATUS}) and cannot be part of a live build. ` +
        `Derive the thresholds from G0 pilot data (PHASES.md 0.6) first.`,
    )
  }
}

/**
 * Confidence grade A–D from the interval width — the Grader's headline.
 * A wide interval is not a bad brand, it is a small sample, and the grade says
 * so rather than letting the reader mistake noise for a finding.
 *
 * REFUSES in a live-facing build. The thresholds are provisional, and a
 * provisional grade shown to a customer is indistinguishable from a real one.
 * Failing the build is the point: it cannot be forgotten, and there is no
 * configuration that quietly re-enables it — the block lifts when the numbers
 * are derived from G0 and this guard is removed deliberately.
 */
export function confidenceGrade(
  m: Metric,
  opts: { allowProvisional?: boolean; env?: Record<string, string | undefined> } = {},
): { grade: 'A' | 'B' | 'C' | 'D'; note: string; provisional: true } {
  if (isLiveFacingBuild(opts.env) && !opts.allowProvisional) {
    throw new ProvisionalMetricError(
      `confidenceGrade is ${CONFIDENCE_GRADE_STATUS} and must not reach a customer. ` +
        `Derive the thresholds from G0 pilot data (PHASES.md 0.6) before shipping, or pass allowProvisional for an internal preview.`,
    )
  }
  const w = intervalWidth(m)
  const t = CONFIDENCE_GRADE_THRESHOLDS
  // Signed distances, never "±". A Wilson interval is asymmetric, and printing
  // ±19.1% beside an interval of 7.0–45.2% states two different things about
  // the same number - the Wald symmetry this package exists to avoid.
  const spread = `${pct(m.value - m.ci_low, 1).replace(/^/, '−')} / +${pct(m.ci_high - m.value, 1)}`
  if (w <= t.A) return { grade: 'A', note: `${spread} — tight enough to act on`, provisional: true }
  if (w <= t.B) return { grade: 'B', note: `${spread} — directional`, provisional: true }
  if (w <= t.C) return { grade: 'C', note: `${spread} — indicative only`, provisional: true }
  return { grade: 'D', note: `${spread} — too few runs to conclude anything`, provisional: true }
}

/* ==========================================================================
   FREQUENCY — a rate as a spoken quantity
   ==========================================================================
   ⚠️ HUMAN REVIEW REQUIRED: packages/stats — the rounding rule below decides
   what a customer is told their number is. Check the three judgements marked
   JUDGEMENT, and the deferral marked DEFERRED, before this reaches a customer.

   WHY THIS EXISTS. The simple depth (see apps/public data-depth) must state a
   measurement in plain language WITHOUT dropping its interval — the whole
   product claim is that a number never appears without how much it does not
   know. The way to keep both is to typeset the interval as language rather
   than as a figure and a rail:

       "AI assistants mention acme.com in about 1 in 4 answers.
        Could be as few as 1 in 6, or as many as 1 in 3."

   That sentence carries value, ci_low, ci_high and (with the clause the caller
   appends) n. It satisfies R8 in words. A tooltip would not: it fails on touch,
   in print, and in the screenshot a customer sends their board.

   Frequencies rather than percentages because people read them more accurately,
   and — the reason that matters here — because the WIDTH of an interval is
   audible in a frequency and silent in a percentage. "17.0–31.2%" reads as
   precision; "as few as 1 in 6, as many as 1 in 3" reads as the uncertainty it
   is, to a reader who has never thought about a confidence interval.

   This function returns numerals and the k values, never a sentence. The voice
   belongs to the surface; the arithmetic and the refusals belong here.
   ========================================================================== */

/**
 * The largest rate worth speaking. Above one answer in two, "1 in k" stops
 * being idiomatic — 1/0.6 rounds to "1 in 2", which understates, and there is
 * no natural single-numerator phrasing above a half.
 */
const FREQUENCY_CEILING = 0.5

/**
 * How much wider than the computed interval the SPOKEN range may be.
 *
 * ⚠️ PROVISIONAL, and chosen from measurement rather than taste — see the grid
 * in frequency.test.ts. The bounds round outward so the spoken range always
 * contains the interval; the cost is that "1 in k" is coarse near small k, and
 * near 25% the only frequencies either side are 1 in 5 (20.0%) and 1 in 3
 * (33.3%). Any interval inside that gap is spoken as the whole gap.
 *
 * WITHOUT THIS GATE THE PRODUCT'S VALUE PROPOSITION RUNS BACKWARDS. A customer
 * paying for four times the sample gets a tighter interval and a vaguer
 * sentence — n=150 at 17.0-31.2% inflates 1.17x, n=600 at 21.7-28.6% inflates
 * 1.93x, on the same brand, because it was measured more carefully.
 *
 * 1.5 is where the n=150 band stays contiguous (10-25% all speak; 30% and above
 * do not), which matters more than the number itself: a threshold that admits
 * 20% and 30% while refusing 25% would look arbitrary to anyone comparing two
 * scans. It is not a derived constant and it is not defended as one.
 */
export const MAX_SPOKEN_INFLATION = 1.5

/**
 * The largest denominator a reader will actually read as a quantity.
 *
 * ⚠️ PROVISIONAL, and the gate I MISSED on the first pass. Inflation catches
 * the high-rate failure — small k, poor resolution — and is blind to the
 * low-rate one: at n=150 a brand at 5% has ci_low ≈ 0.027, which speaks as "as
 * few as 1 in 37". That is faithful (1.13x) and unreadable, and it is not an
 * edge case — every brand under about 8.5% at n=150 lands there, which on the
 * free Grader is a large share of the brands that arrive.
 *
 * So the two failure modes sit at opposite ends and the readable band is
 * narrow. 20 is a round number at the edge of what reads as a quantity rather
 * than as an arbitrary integer; "1 in 17" still lands, "1 in 37" does not.
 *
 * An INFINITE denominator is exempt: it renders as "none at all", which is a
 * word rather than a number and reads perfectly.
 */
export const MAX_SPOKEN_DENOMINATOR = 20

export type Frequency =
  /**
   * A speakable ratio. `point` carries "about" at the call site, never here.
   * The k values are exposed so a caller can see when the bounds collapse onto
   * the estimate and choose not to print a range that is no range.
   */
  | { readonly kind: 'ratio'; readonly point: string; readonly low: string; readonly high: string; readonly pointK: number; readonly lowK: number; readonly highK: number }
  /** p̂ = 0. Not a missing value: a finding, and it still has an upper bound. */
  | { readonly kind: 'none'; readonly high: string; readonly highK: number }
  /** Frequency framing would mislead here. The caller falls back to percentages. */
  | { readonly kind: 'unavailable'; readonly reason: string }

/** "1 in 4", or "none at all" for an unbounded denominator. */
const inOne = (k: number): string => (Number.isFinite(k) ? `1 in ${k}` : 'none at all')

/**
 * A metric as a spoken frequency, or an explicit refusal to speak it.
 *
 * JUDGEMENT 1 — THE ROUNDING IS OUTWARD ON THE BOUNDS AND NEAREST ON THE
 * ESTIMATE. The point estimate rounds to nearest, because the surface says
 * "about" in front of it. The bounds round the way that WIDENS the spoken
 * range: the low bound's denominator rounds up (a bigger k is a smaller rate)
 * and the high bound's rounds down. So the sentence a customer reads always
 * CONTAINS the computed interval and can never be tighter than it. Rounding to
 * nearest on the bounds would be more accurate on average and would sometimes
 * state a range narrower than the one the arithmetic supports, which is the one
 * error this package exists to refuse.
 *
 * JUDGEMENT 2 — ABOVE ONE ANSWER IN TWO IT REFUSES rather than approximating.
 * See FREQUENCY_CEILING. The test is on ci_high, not on the estimate: an
 * interval that reaches past a half cannot be spoken as "1 in k" at its top end
 * however small its centre is.
 *
 * JUDGEMENT 3 — ZERO IS A FINDING, NOT AN ABSENCE. p̂ = 0 returns 'none' with
 * its upper bound, so the surface can say "not mentioned in any of the 150
 * answers, and the most that could be hiding in a sample this size is about 1
 * in 60". A zero with no upper bound is the shape of a bug being reported as a
 * result.
 *
 * DEFERRED — THE GOOD-NEWS CASE HAS NO PHRASING YET. A brand mentioned in 70%
 * of answers gets 'unavailable' and a percentage sentence, because "7 in 10"
 * needs a numerator this function does not produce. That is a copy decision
 * with a statistical edge (what does the numerator round to?), so it is left
 * for the human who owns this file rather than approximated by me.
 */
export function formatFrequency(m: Metric): Frequency {
  if (!Number.isFinite(m.value) || !Number.isFinite(m.ci_low) || !Number.isFinite(m.ci_high)) {
    return { kind: 'unavailable', reason: 'the metric is not a finite proportion' }
  }
  if (m.n < 1) {
    return { kind: 'unavailable', reason: 'nothing was measured' }
  }
  if (m.ci_high > FREQUENCY_CEILING) {
    // Includes every p̂ above a half, since ci_high >= value for a Wilson interval.
    return { kind: 'unavailable', reason: 'the interval reaches above one answer in two' }
  }

  // ci_high = 0 only when the interval is degenerate; there is no upper bound to
  // speak and "1 in Infinity" is not a sentence.
  const highK = m.ci_high > 0 ? Math.floor(1 / m.ci_high) : Number.POSITIVE_INFINITY
  if (!Number.isFinite(highK)) {
    return { kind: 'unavailable', reason: 'the interval has no upper bound to state' }
  }

  if (m.value <= 0) {
    return { kind: 'none', high: inOne(highK), highK }
  }

  // Infinity when ci_low is 0 — a real and common case at small n, and the
  // honest phrase for it is "none at all" rather than a very large denominator.
  const lowK = m.ci_low > 0 ? Math.ceil(1 / m.ci_low) : Number.POSITIVE_INFINITY
  const pointK = Math.round(1 / m.value)

  /*
   * THE TWO GATES, AND THEY GUARD OPPOSITE ENDS OF THE SAME BAND.
   *
   * Readability fails at LOW rates, where the denominators grow past what
   * anyone reads as a quantity. Resolution fails at HIGH rates, where the
   * available frequencies are too far apart to carry an interval. Frequency
   * framing wins in the middle and nowhere else, so outside the middle this
   * refuses and the surface prints percentages — which are always available,
   * always exact, and carry no readability cliff.
   *
   * Refusing is not a degraded outcome here. A percentage with its interval is
   * the honest rendering of this number; the frequency is a better rendering
   * only where it is both faithful and legible.
   */
  if (Number.isFinite(lowK) && lowK > MAX_SPOKEN_DENOMINATOR) {
    return { kind: 'unavailable', reason: 'the rate is too low to speak as a frequency anyone would read' }
  }

  const spokenWidth = 1 / highK - (Number.isFinite(lowK) ? 1 / lowK : 0)
  const computedWidth = m.ci_high - m.ci_low
  if (computedWidth > 0 && spokenWidth / computedWidth > MAX_SPOKEN_INFLATION) {
    return { kind: 'unavailable', reason: 'speaking this interval as a frequency would overstate how little is known' }
  }

  return { kind: 'ratio', point: inOne(pointK), low: inOne(lowK), high: inOne(highK), pointK, lowK, highK }
}
