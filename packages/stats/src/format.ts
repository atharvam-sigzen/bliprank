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
}

export type Significance = 'higher' | 'lower' | 'no-significant-change' | 'insufficient-data'

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

  if (current.n <= 0 || previous.n <= 0) {
    return { significance: 'insufficient-data', delta, label: 'not enough data' }
  }

  const separated = current.ci_low > previous.ci_high || current.ci_high < previous.ci_low
  if (!separated) {
    return { significance: 'no-significant-change', delta, label: 'no significant change' }
  }

  const direction: Significance = delta > 0 ? 'higher' : 'lower'
  return {
    significance: direction,
    delta,
    label: `${delta > 0 ? '+' : '−'}${pct(Math.abs(delta), 1)} vs previous`,
  }
}

/**
 * Confidence grade A–D from the interval width — the Grader's headline.
 * A wide interval is not a bad brand, it is a small sample, and the grade says
 * so rather than letting the reader mistake noise for a finding.
 */
export function confidenceGrade(m: Metric): { grade: 'A' | 'B' | 'C' | 'D'; note: string } {
  const w = intervalWidth(m)
  if (w <= 0.1) return { grade: 'A', note: `±${pct(w / 2, 1)} — tight enough to act on` }
  if (w <= 0.2) return { grade: 'B', note: `±${pct(w / 2, 1)} — directional` }
  if (w <= 0.35) return { grade: 'C', note: `±${pct(w / 2, 1)} — indicative only` }
  return { grade: 'D', note: `±${pct(w / 2, 1)} — too few runs to conclude anything` }
}
