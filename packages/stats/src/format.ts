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
 */
export function formatInterval(m: Metric, dp = 1): string {
  return `${m.ci_low === 0 ? '0' : (m.ci_low * 100).toFixed(dp)}–${pct(m.ci_high, dp)}`
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
