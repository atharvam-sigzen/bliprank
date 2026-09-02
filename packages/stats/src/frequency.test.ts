import { describe, expect, it } from 'vitest'
import { formatFrequency, type Frequency, type Metric } from './format.js'
import { wilson } from './wilson.js'

/**
 * ⚠️ THIS FILE IS THE REVIEW SURFACE FOR A HUMAN-OWNED CHANGE.
 *
 * `formatFrequency` decides what a customer is told their number is, in the one
 * view most of them will ever read. These tests are written to make the three
 * judgements in its doc comment concrete enough to accept or reject, not to
 * demonstrate that the arithmetic runs.
 *
 * The property that matters is CONTAINMENT: the spoken range must never be
 * narrower than the computed interval. It is asserted here by exhaustive sweep
 * rather than by example, because a rounding rule that is right on the cases
 * someone thought of is exactly the failure mode this product cannot have.
 */

const metric = (value: number, ci_low: number, ci_high: number, n = 150): Metric => ({
  value,
  ci_low,
  ci_high,
  n,
  algo_version: 'det-1',
  collection_path: 'third-party-grounded',
  comparison_basis: 'five-engine/en-GB/GB/30d',
})

/** The rate a spoken "1 in k" actually asserts. "none at all" asserts zero. */
const rateOf = (k: number): number => (Number.isFinite(k) ? 1 / k : 0)

describe('the spoken range always contains the computed interval', () => {
  /*
   * JUDGEMENT 1, AS A PROPERTY.
   *
   * The bounds round outward: the low denominator up, the high denominator
   * down. A customer therefore always reads a range at least as wide as the one
   * the arithmetic supports. Rounding to nearest would be closer on average and
   * would sometimes speak a range TIGHTER than the measurement, which is the
   * single error this package exists to refuse.
   */
  it('holds across every real Wilson interval from n=30 to n=600', () => {
    let checked = 0
    for (const n of [30, 50, 75, 100, 150, 200, 300, 450, 600]) {
      for (let successes = 0; successes <= n; successes++) {
        const w = wilson(successes, n)
        const m = metric(successes / n, w.ci_low, w.ci_high, n)
        const f = formatFrequency(m)
        if (f.kind !== 'ratio') continue
        checked++
        // The spoken low is at or below the computed low; the spoken high at or above.
        expect([n, successes, rateOf(f.lowK) <= m.ci_low + 1e-12]).toEqual([n, successes, true])
        expect([n, successes, rateOf(f.highK) >= m.ci_high - 1e-12]).toEqual([n, successes, true])
      }
    }
    // Not a vacuous sweep: the ratio branch has to be the common one.
    expect(checked).toBeGreaterThan(400)
  })

  it('the check bites — rounding the bounds to nearest would break containment', () => {
    // 17.0–31.2%: to-nearest gives 1 in 6 (0.1667 < 0.170, still fine) but
    // 1 in 3 (0.3333 > 0.312, fine too). The failure is on the other side.
    // p = 0.26: to-nearest on the high bound of 0.34 gives 1 in 3 = 0.3333,
    // which is BELOW 0.34 — a range narrower than the measurement.
    const nearestHigh = Math.round(1 / 0.34)
    expect(1 / nearestHigh).toBeLessThan(0.34)
    // The implementation floors instead, so it cannot produce that.
    const f = formatFrequency(metric(0.26, 0.19, 0.34))
    expect(f.kind).toBe('ratio')
    expect(rateOf((f as Extract<Frequency, { kind: 'ratio' }>).highK)).toBeGreaterThanOrEqual(0.34)
  })
})

describe('the worked example from the design plan', () => {
  it('reads as the sentence the simple view was designed around', () => {
    const f = formatFrequency(metric(0.247, 0.17, 0.312))
    expect(f).toEqual({ kind: 'ratio', point: '1 in 4', low: '1 in 6', high: '1 in 3', pointK: 4, lowK: 6, highK: 3 })
    // "…in about 1 in 4 answers. Could be as few as 1 in 6, or as many as 1 in 3."
  })
})

describe('zero is a finding, and it keeps its upper bound', () => {
  /*
   * JUDGEMENT 3. The Grader already has a branch for this and already says the
   * right thing about it; the frequency form has to preserve that. A zero
   * without an upper bound is a bug being reported as a result.
   */
  it('p̂ = 0 returns none, with the most that could be hiding', () => {
    const w = wilson(0, 150)
    const f = formatFrequency(metric(0, w.ci_low, w.ci_high, 150))
    expect(f.kind).toBe('none')
    expect((f as Extract<Frequency, { kind: 'none' }>).highK).toBeGreaterThan(1)
    expect((f as Extract<Frequency, { kind: 'none' }>).high).toMatch(/^1 in \d+$/)
  })

  it('the upper bound tightens as the sample grows, which is the whole point', () => {
    const at = (n: number) => {
      const w = wilson(0, n)
      const f = formatFrequency(metric(0, w.ci_low, w.ci_high, n))
      return (f as Extract<Frequency, { kind: 'none' }>).highK
    }
    // A bigger k is a smaller rate: more answers, less that could be hiding.
    expect(at(600)).toBeGreaterThan(at(150))
    expect(at(150)).toBeGreaterThan(at(30))
  })
})

describe('a bound at zero is spoken, not printed as a huge denominator', () => {
  it('ci_low = 0 becomes "none at all" rather than "1 in 100000"', () => {
    const f = formatFrequency(metric(0.02, 0, 0.09))
    expect(f.kind).toBe('ratio')
    expect((f as Extract<Frequency, { kind: 'ratio' }>).low).toBe('none at all')
    // and it still contains: "none at all" asserts 0, which is <= ci_low.
    expect(rateOf((f as Extract<Frequency, { kind: 'ratio' }>).lowK)).toBeLessThanOrEqual(0)
  })
})

describe('it refuses rather than approximating', () => {
  /*
   * JUDGEMENT 2 and the DEFERRAL. Every refusal here sends the surface to the
   * percentage sentence, which is always available. None of them is a silent
   * fallback: the reason is returned so a caller cannot mistake a refusal for a
   * measurement.
   */
  it('refuses above one answer in two, testing the BOUND and not the estimate', () => {
    // The estimate is comfortably under a half; the interval is not.
    const f = formatFrequency(metric(0.42, 0.34, 0.51))
    expect(f).toEqual({ kind: 'unavailable', reason: 'the interval reaches above one answer in two' })
  })

  it('refuses the good-news case, deliberately and with a reason', () => {
    // DEFERRED in the implementation: "7 in 10" needs a numerator this function
    // does not produce, and choosing how that numerator rounds is a judgement
    // for the owner of this file.
    expect(formatFrequency(metric(0.7, 0.62, 0.77)).kind).toBe('unavailable')
  })

  it('refuses an empty sample rather than dividing by it', () => {
    expect(formatFrequency(metric(0, 0, 1, 0))).toEqual({ kind: 'unavailable', reason: 'nothing was measured' })
  })

  it('refuses a non-finite metric instead of emitting NaN into a sentence', () => {
    expect(formatFrequency(metric(Number.NaN, 0, 0.3)).kind).toBe('unavailable')
    expect(formatFrequency(metric(0.2, Number.NaN, 0.3)).kind).toBe('unavailable')
  })

  it('every refusal carries a reason, and none is empty', () => {
    const refusals = [metric(0.42, 0.34, 0.51), metric(0.7, 0.62, 0.77), metric(0, 0, 1, 0), metric(Number.NaN, 0, 0.3)]
      .map(formatFrequency)
      .filter((f) => f.kind === 'unavailable')
    expect(refusals.length).toBe(4)
    for (const r of refusals) expect((r as Extract<Frequency, { kind: 'unavailable' }>).reason.length).toBeGreaterThan(10)
  })
})

describe('⚠️ THE COST OF THIS FRAMING, MEASURED — the reviewer decides', () => {
  /*
   * FOUND WHILE WRITING THESE TESTS, AND IT IS THE REASON THIS FILE IS FLAGGED.
   *
   * Outward rounding guarantees containment, so the spoken range is never
   * tighter than the measurement. The price is the opposite error, and it is
   * not small: "1 in k" has coarse granularity near small k, so a PRECISE
   * measurement is spoken as a vague one.
   *
   * At p̂ = 25% the neighbouring speakable frequencies are 1 in 5 (20.0%) and
   * 1 in 3 (33.3%). Any interval inside that gap — including a superbly tight
   * one — is spoken as "as few as 1 in 5, as many as 1 in 3". A brand measured
   * to ±0.2 points is told its rate might be anywhere from a fifth to a third.
   *
   * For a product whose entire claim is that its numbers are more trustworthy
   * than the competition's, systematically making good measurements SOUND worse
   * than they are is a real cost, not a rounding detail. It is also the exact
   * mirror of the dishonesty we refuse: overstating uncertainty is not neutral
   * when precision is the thing being sold.
   *
   * Three ways out, none of which I should pick:
   *   (a) accept it — the simple view is for gist, and the detailed view has
   *       the real interval one switch away;
   *   (b) speak the range only when the inflation is under some factor, and
   *       fall back to the percentage sentence otherwise;
   *   (c) allow numerators ("2 in 9"), which restores resolution and costs
   *       idiom.
   * That is a product judgement about what a customer is told, which is what
   * §4 reserves to a human. The number below exists so the choice is made with
   * the magnitude visible rather than in the abstract.
   */
  const inflation = (m: Metric) => {
    const f = formatFrequency(m) as Extract<Frequency, { kind: 'ratio' }>
    return (rateOf(f.highK) - rateOf(f.lowK)) / (m.ci_high - m.ci_low)
  }

  it('outward rounding always widens, so the bounds never collapse onto the estimate', () => {
    // The good half of the trade: a caller can always print a real span.
    const f = formatFrequency(metric(0.25, 0.248, 0.252)) as Extract<Frequency, { kind: 'ratio' }>
    expect(f.lowK).toBeGreaterThan(f.highK)
    expect(rateOf(f.lowK)).toBeLessThanOrEqual(0.248)
    expect(rateOf(f.highK)).toBeGreaterThanOrEqual(0.252)
  })

  it('a razor-tight interval at 25% is spoken 33x wider than it is', () => {
    expect(inflation(metric(0.25, 0.248, 0.252))).toBeCloseTo(33.33, 1)
  })

  it('the free Grader scan inflates modestly — the case for accepting this', () => {
    // n = 150 at p̂ ≈ 25%, the Starter unit: 17.0-31.2% spoken as 16.7-33.3%.
    expect(inflation(metric(0.247, 0.17, 0.312))).toBeCloseTo(1.17, 2)
  })

  it('⚠️ BUT A BIGGER SAMPLE INFLATES MORE, WHICH INVERTS WHAT THE TIER BUYS', () => {
    /*
     * THE FINDING THAT MATTERS, AND IT IS NOT THE EXTREME CASE.
     *
     * The perverse direction was easy to dismiss while the only example was a
     * ±0.2-point interval nobody will ever measure. It is not confined there.
     * A customer paying for four times the sample gets a TIGHTER interval and a
     * WIDER spoken range, because 1-in-5 and 1-in-3 are the only frequencies
     * available either side of 25% and both intervals sit between them:
     *
     *   n = 150, 17.0-31.2%  ->  "1 in 6 to 1 in 3"  (16.7-33.3%)  1.17x
     *   n = 600, 21.7-28.6%  ->  "1 in 5 to 1 in 3"  (20.0-33.3%)  1.93x
     *
     * The paid tier's headline sentence is VAGUER than the free one, on the
     * same brand, because it measured more carefully. That is not a rounding
     * detail; it is the product's value proposition running backwards in the
     * one view most customers will read.
     */
    const starter = inflation(metric(0.247, 0.17, 0.312))
    const paid = inflation(metric(0.25, 0.217, 0.286))
    expect(paid).toBeCloseTo(1.93, 2)
    expect(paid).toBeGreaterThan(starter)
  })

  it('and the top bound can overstate by 9 points on an ordinary scan', () => {
    // n = 150 at p̂ = 33%: 26.0-41.0% spoken as "1 in 4 to 1 in 2" = 25.0-50.0%.
    // "as many as one answer in two" for a measurement whose upper bound is 41%.
    const f = formatFrequency(metric(0.33, 0.26, 0.41)) as Extract<Frequency, { kind: 'ratio' }>
    expect(f.high).toBe('1 in 2')
    expect(rateOf(f.highK) - 0.41).toBeCloseTo(0.09, 2)
  })
})
