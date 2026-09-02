import { describe, expect, it } from 'vitest'
import { MAX_SPOKEN_DENOMINATOR, MAX_SPOKEN_INFLATION, formatFrequency, type Frequency, type Metric } from './format.js'
import { wilson } from './wilson.js'

/**
 * ⚠️ HUMAN-OWNED (CLAUDE.md §4). `formatFrequency` decides what a customer is
 * told their number is, in the one view most of them will ever read.
 *
 * Two properties matter and they pull in opposite directions.
 *
 *   CONTAINMENT — the spoken range must never be narrower than the computed
 *   interval. Guaranteed by rounding the bounds outward, and asserted here by
 *   exhaustive sweep rather than by example.
 *
 *   FAITHFULNESS AND LEGIBILITY — the spoken range must not be much WIDER
 *   either, and its denominators must be numbers a person reads as quantities.
 *   Neither is guaranteed; both are gated, and outside the gates this refuses
 *   and the surface prints percentages.
 *
 * The gates are the whole design. Everything below exists to show where they
 * sit and that each of them earns its place.
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
const ratio = (f: Frequency) => f as Extract<Frequency, { kind: 'ratio' }>

/** A real Wilson interval, so the cases below are scans and not hypotheticals. */
const scan = (p: number, n: number) => {
  const w = wilson(Math.round(p * n), n)
  return metric(Math.round(p * n) / n, w.ci_low, w.ci_high, n)
}

describe('containment: the spoken range always holds the computed interval', () => {
  it('holds across every real Wilson interval from n=30 to n=600', () => {
    let spoken = 0
    let total = 0
    for (const n of [30, 50, 75, 100, 150, 200, 300, 450, 600]) {
      for (let successes = 0; successes <= n; successes++) {
        const w = wilson(successes, n)
        const m = metric(successes / n, w.ci_low, w.ci_high, n)
        const f = formatFrequency(m)
        total++
        if (f.kind !== 'ratio') continue
        spoken++
        expect([n, successes, rateOf(f.lowK) <= m.ci_low + 1e-12]).toEqual([n, successes, true])
        expect([n, successes, rateOf(f.highK) >= m.ci_high - 1e-12]).toEqual([n, successes, true])
      }
    }
    // Not a vacuous sweep. It is also not most of them — see the coverage block.
    expect(spoken).toBeGreaterThan(150)
    expect(total).toBe(1964)
  })

  it('the bounds are floored and ceilinged, not rounded to nearest', () => {
    // n=150 at p̂≈25%, the Starter unit and the case the design was built on.
    const f = ratio(formatFrequency(metric(0.247, 0.17, 0.312)))
    expect(f.kind).toBe('ratio')
    expect(rateOf(f.lowK)).toBeLessThanOrEqual(0.17)
    expect(rateOf(f.highK)).toBeGreaterThanOrEqual(0.312)
    // To-nearest on the high bound would give 1 in 3 here too, but on an
    // interval ending at 0.34 it gives 1/3 = 0.3333 — inside the measurement.
    expect(1 / Math.round(1 / 0.34)).toBeLessThan(0.34)
  })
})

describe('the worked example from the design plan', () => {
  it('reads as the sentence the simple view was designed around', () => {
    expect(formatFrequency(metric(0.247, 0.17, 0.312))).toEqual({
      kind: 'ratio',
      point: '1 in 4',
      low: '1 in 6',
      high: '1 in 3',
      pointK: 4,
      lowK: 6,
      highK: 3,
    })
    // "…in about 1 in 4 answers. Could be as few as 1 in 6, or as many as 1 in 3."
  })
})

describe('GATE 1 — resolution: it refuses to speak an interval it would inflate', () => {
  /*
   * "1 in k" is coarse near small k. At 25% the only frequencies either side
   * are 1 in 5 (20.0%) and 1 in 3 (33.3%), so any interval inside that gap is
   * spoken as the whole gap. Without this gate the product's value proposition
   * runs backwards: a bigger, more careful sample produces a vaguer sentence.
   */
  const inflation = (m: Metric) => {
    const f = ratio(formatFrequency(m))
    return (rateOf(f.highK) - rateOf(f.lowK)) / (m.ci_high - m.ci_low)
  }

  it('the free Grader scan speaks, and inflates 1.17x doing it', () => {
    expect(inflation(metric(0.247, 0.17, 0.312))).toBeCloseTo(1.17, 2)
  })

  it('THE CASE THIS GATE EXISTS FOR: four times the sample, refused', () => {
    // n=600 at p̂=25% is 21.7-28.6% and would speak as "1 in 5 to 1 in 3"
    // (20.0-33.3%) — 1.93x, VAGUER than the free tier's 1.17x on the same
    // brand, because it was measured more carefully.
    const f = formatFrequency(metric(0.25, 0.217, 0.286, 600))
    expect(f.kind).toBe('unavailable')
    expect((f as Extract<Frequency, { kind: 'unavailable' }>).reason).toMatch(/overstate/)
  })

  it('and the nine-point overstatement at p̂=33% is refused too', () => {
    // 26.0-41.0% would have spoken as "1 in 4 to 1 in 2" — "as many as one
    // answer in two" against a computed upper bound of 41%.
    expect(formatFrequency(metric(0.33, 0.26, 0.41)).kind).toBe('unavailable')
  })

  it('a razor-tight interval — the 33x case — never reaches a customer', () => {
    expect(formatFrequency(metric(0.25, 0.248, 0.252)).kind).toBe('unavailable')
  })

  it('the gate bites: every case it admits is within the stated bound', () => {
    for (const n of [30, 100, 150, 600]) {
      for (let s = 1; s <= n; s++) {
        const w = wilson(s, n)
        const m = metric(s / n, w.ci_low, w.ci_high, n)
        if (formatFrequency(m).kind !== 'ratio') continue
        expect([n, s, inflation(m) <= MAX_SPOKEN_INFLATION + 1e-9]).toEqual([n, s, true])
      }
    }
  })
})

describe('GATE 2 — legibility: it refuses denominators nobody reads', () => {
  /*
   * ⚠️ THE GATE THE FIRST PASS MISSED, and it guards the opposite end.
   * Inflation is blind here: at n=150 a brand at 5% speaks as "as few as 1 in
   * 42", which is faithful (1.13x) and unreadable. It is not an edge case —
   * every brand under about 8.5% at n=150 lands there, and on the free Grader
   * that is a large share of the brands that arrive.
   */
  it('a low-rate brand is refused however faithful the arithmetic is', () => {
    const f = formatFrequency(scan(0.05, 150))
    expect(f.kind).toBe('unavailable')
    expect((f as Extract<Frequency, { kind: 'unavailable' }>).reason).toMatch(/too low to speak/)
  })

  it('the two gates are jointly necessary — neither catches the other`s case', () => {
    // Low rate: legible gate fires, inflation would have passed it.
    const low = scan(0.05, 150)
    const lowK = Math.ceil(1 / low.ci_low)
    const lowInflation = (1 / Math.floor(1 / low.ci_high) - 1 / lowK) / (low.ci_high - low.ci_low)
    expect(lowK).toBeGreaterThan(MAX_SPOKEN_DENOMINATOR)
    expect(lowInflation).toBeLessThanOrEqual(MAX_SPOKEN_INFLATION)

    // High rate: inflation gate fires, legibility would have passed it.
    const high = metric(0.25, 0.217, 0.286, 600)
    expect(Math.ceil(1 / high.ci_low)).toBeLessThanOrEqual(MAX_SPOKEN_DENOMINATOR)
    expect(formatFrequency(high).kind).toBe('unavailable')
  })

  it('the readable middle still speaks', () => {
    const f = ratio(formatFrequency(scan(0.1, 150)))
    expect(f.kind).toBe('ratio')
    expect(f.lowK).toBeLessThanOrEqual(MAX_SPOKEN_DENOMINATOR)
  })

  it('an infinite denominator is exempt — it is a word, not a number', () => {
    // ci_low = 0 is common at small n and reads as "none at all", which is
    // perfectly legible and asserts exactly zero, so containment is exact.
    const f = ratio(formatFrequency(metric(0.02, 0, 0.09)))
    expect(f.kind).toBe('ratio')
    expect(f.low).toBe('none at all')
    expect(rateOf(f.lowK)).toBe(0)
  })
})

describe('zero is a finding, and it keeps its upper bound', () => {
  it('p̂ = 0 returns none, with the most that could be hiding', () => {
    const w = wilson(0, 150)
    const f = formatFrequency(metric(0, w.ci_low, w.ci_high, 150))
    expect(f.kind).toBe('none')
    expect((f as Extract<Frequency, { kind: 'none' }>).high).toMatch(/^1 in \d+$/)
  })

  it('the upper bound tightens as the sample grows, which is the whole point', () => {
    const at = (n: number) => {
      const w = wilson(0, n)
      return (formatFrequency(metric(0, w.ci_low, w.ci_high, n)) as Extract<Frequency, { kind: 'none' }>).highK
    }
    expect(at(600)).toBeGreaterThan(at(150))
    expect(at(150)).toBeGreaterThan(at(30))
  })

  it('NOT gated by MAX_SPOKEN_DENOMINATOR, deliberately', () => {
    // "not mentioned in any of 600 answers; at most about 1 in 250" is a single
    // bound, not a range, and a large denominator there is the good news rather
    // than an unreadable span. The legibility gate guards spans.
    const w = wilson(0, 600)
    const f = formatFrequency(metric(0, w.ci_low, w.ci_high, 600)) as Extract<Frequency, { kind: 'none' }>
    expect(f.kind).toBe('none')
    expect(f.highK).toBeGreaterThan(MAX_SPOKEN_DENOMINATOR)
  })
})

describe('it refuses rather than approximating', () => {
  it('refuses above one answer in two, testing the BOUND and not the estimate', () => {
    expect(formatFrequency(metric(0.42, 0.34, 0.51))).toEqual({
      kind: 'unavailable',
      reason: 'the interval reaches above one answer in two',
    })
  })

  it('refuses the good-news case, deliberately and with a reason', () => {
    // DEFERRED: "7 in 10" needs a numerator this function does not produce.
    expect(formatFrequency(metric(0.7, 0.62, 0.77)).kind).toBe('unavailable')
  })

  it('refuses an empty sample rather than dividing by it', () => {
    expect(formatFrequency(metric(0, 0, 1, 0))).toEqual({ kind: 'unavailable', reason: 'nothing was measured' })
  })

  it('refuses a non-finite metric instead of emitting NaN into a sentence', () => {
    expect(formatFrequency(metric(Number.NaN, 0, 0.3)).kind).toBe('unavailable')
    expect(formatFrequency(metric(0.2, Number.NaN, 0.3)).kind).toBe('unavailable')
  })

  it('every refusal carries a distinct, non-empty reason', () => {
    const reasons = new Set(
      [metric(0.42, 0.34, 0.51), metric(0, 0, 1, 0), scan(0.05, 150), metric(0.25, 0.217, 0.286, 600)]
        .map(formatFrequency)
        .filter((f) => f.kind === 'unavailable')
        .map((f) => (f as Extract<Frequency, { kind: 'unavailable' }>).reason),
    )
    expect(reasons.size).toBe(4)
    for (const r of reasons) expect(r.length).toBeGreaterThan(10)
  })
})

describe('⚠️ COVERAGE — how often the simple view actually speaks a frequency', () => {
  /*
   * THE NUMBER THE PRODUCT DECISION TURNS ON, and it is not flattering.
   *
   * Both gates are correct individually. Together they leave a narrow band:
   * frequency framing is faithful AND legible only for roughly 8-25% at
   * n=150, and the inflation is erratic rather than monotonic — it depends on
   * where the interval endpoints happen to fall against the 1/k lattice, so
   * the band is not even contiguous at every n.
   *
   * The consequence for a customer is that the headline sentence changes SHAPE
   * between scans for reasons they cannot see. That is an argument for letting
   * percentages own the headline permanently, and it is recorded here as a
   * measurement rather than an opinion. Flagged in ADR-0010.
   */
  const NS = [30, 50, 100, 150, 300, 600, 1000]
  const PS = [0.02, 0.05, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]

  it('a frequency is the minority rendering across the realistic grid', () => {
    let spoken = 0
    for (const n of NS) for (const p of PS) if (formatFrequency(scan(p, n)).kind === 'ratio') spoken++
    const share = spoken / (NS.length * PS.length)
    // Measured at ~1/3. Asserted as a band so the figure in ADR-0010 cannot
    // drift silently if a threshold is retuned.
    expect(share).toBeGreaterThan(0.2)
    expect(share).toBeLessThan(0.45)
  })

  it('and at the Starter unit it is a contiguous band, which is the best case', () => {
    const spoken = PS.filter((p) => formatFrequency(scan(p, 150)).kind === 'ratio')
    // 10%-25% at n=150. Contiguous, and only four of twelve bands: 8% and below
    // fail legibility (k=22 at 8%), 30% and above fail resolution.
    expect(spoken).toEqual([0.1, 0.15, 0.2, 0.25])
  })
})
