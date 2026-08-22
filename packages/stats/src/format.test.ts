import { describe, expect, it } from 'vitest'
import { compare, confidenceGrade, formatInterval, formatMetric, formatProvenance, formatValue, intervalWidth, type Metric } from './format.js'
import { wilson } from './wilson.js'

const metric = (over: Partial<Metric> = {}): Metric => ({
  value: 0.25,
  ci_low: 0.17,
  ci_high: 0.35,
  n: 150,
  algo_version: 'det-1',
  collection_path: 'third-party-grounded',
  ...over,
})

/** Build a Metric the way production will: straight off a Wilson interval. */
function fromWilson(successes: number, trials: number): Metric {
  const w = wilson(successes, trials)
  return { value: w.value, ci_low: w.ci_low, ci_high: w.ci_high, n: w.n, algo_version: 'det-1', collection_path: 'third-party-grounded' }
}

describe('formatting always carries the interval (R8)', () => {
  it('formatMetric shows value, interval and n in one string', () => {
    expect(formatMetric(metric())).toBe('25.0% (17.0–35.0%, n=150)')
  })

  it('formatProvenance carries algo version and collection path', () => {
    expect(formatProvenance(metric())).toBe('algo det-1 · third-party-grounded · n=150')
  })

  it('the pieces are consistent with the whole', () => {
    const m = metric()
    expect(formatMetric(m)).toContain(formatValue(m))
    expect(formatMetric(m)).toContain(formatInterval(m))
  })

  it('accepts a Wilson interval unchanged — no reshaping at the boundary', () => {
    const m = fromWilson(37, 150)
    expect(formatValue(m)).toBe('24.7%')
    // The bounds are whatever Wilson computed; formatting must not round them
    // into a different interval.
    expect(formatMetric(m)).toBe(`24.7% (${formatInterval(m)}, n=150)`)
    expect(m.ci_low).toBeLessThan(m.value)
    expect(m.ci_high).toBeGreaterThan(m.value)
  })

  it('handles the boundary cases Wilson produces exactly', () => {
    // k=0 and k=n are exact 0 and 1; the interval is one-sided and must render
    // as such rather than as a suspiciously tidy symmetric band.
    const zero = fromWilson(0, 10)
    const all = fromWilson(10, 10)
    expect(zero.value).toBe(0)
    expect(all.value).toBe(1)
    expect(formatMetric(zero)).toBe(`0.0% (0–${(zero.ci_high * 100).toFixed(1)}%, n=10)`)
    expect(formatMetric(all)).toBe(`100.0% (${(all.ci_low * 100).toFixed(1)}–100.0%, n=10)`)
    // and the two are mirror images, as Wilson requires
    expect(zero.ci_high).toBeCloseTo(1 - all.ci_low, 12)
  })
})

describe('the significance rule — no green arrow on noise', () => {
  it('overlapping intervals are "no significant change", whatever the point estimates say', () => {
    // 25% -> 31% looks like a 6-point jump. At n=150 it is not distinguishable.
    const c = compare(metric({ value: 0.31, ci_low: 0.23, ci_high: 0.4 }), metric())
    expect(c.significance).toBe('no-significant-change')
    expect(c.label).toBe('no significant change')
    expect(c.delta).toBeCloseTo(0.06, 9)
  })

  it('reports the delta even when it is not significant, rather than hiding it', () => {
    const c = compare(metric({ value: 0.26 }), metric())
    expect(c.delta).toBeCloseTo(0.01, 9)
  })

  it('separated intervals are significant, in the right direction', () => {
    const up = compare(metric({ value: 0.6, ci_low: 0.52, ci_high: 0.68 }), metric())
    expect(up.significance).toBe('higher')
    expect(up.label).toMatch(/^\+35\.0%/)
    const down = compare(metric({ value: 0.05, ci_low: 0.02, ci_high: 0.1 }), metric())
    expect(down.significance).toBe('lower')
    expect(down.label).toMatch(/^−20\.0%/)
  })

  it('a real 5-run cell can never claim significance against itself — the point of the rule', () => {
    // At n=5 the interval is enormous whatever the engine does, so week-on-week
    // movement is uninterpretable. The UI must say so.
    const w1 = fromWilson(1, 5) // 20%
    const w2 = fromWilson(4, 5) // 80% — a 4x "increase"
    expect(compare(w2, w1).significance).toBe('no-significant-change')
  })

  it('touching-but-not-crossing intervals are still not significant', () => {
    const a = metric({ value: 0.4, ci_low: 0.35, ci_high: 0.45 })
    const b = metric({ value: 0.25, ci_low: 0.17, ci_high: 0.35 })
    expect(compare(a, b).significance).toBe('no-significant-change')
  })

  it('is symmetric in magnitude', () => {
    const a = metric({ value: 0.6, ci_low: 0.52, ci_high: 0.68 })
    const b = metric()
    expect(Math.abs(compare(a, b).delta)).toBeCloseTo(Math.abs(compare(b, a).delta), 9)
    expect(compare(a, b).significance).toBe('higher')
    expect(compare(b, a).significance).toBe('lower')
  })

  it('refuses to compare when either side has no sample', () => {
    expect(compare(metric(), metric({ n: 0 })).significance).toBe('insufficient-data')
    expect(compare(metric({ n: 0 }), metric()).label).toBe('not enough data')
  })
})

describe('confidence grade reflects sample size, not brand performance', () => {
  it('grades on interval width', () => {
    expect(confidenceGrade(metric({ ci_low: 0.22, ci_high: 0.28 })).grade).toBe('A')
    expect(confidenceGrade(metric({ ci_low: 0.18, ci_high: 0.33 })).grade).toBe('B')
    expect(confidenceGrade(metric({ ci_low: 0.12, ci_high: 0.42 })).grade).toBe('C')
    expect(confidenceGrade(metric({ ci_low: 0.05, ci_high: 0.66 })).grade).toBe('D')
  })

  it('a 5-run cell grades D no matter how good the number looks', () => {
    expect(confidenceGrade(fromWilson(4, 5)).grade).toBe('D')
    expect(confidenceGrade(fromWilson(4, 5)).note).toMatch(/too few runs/)
  })

  it('the same p̂ at a larger n grades better — the grade is about evidence', () => {
    expect(confidenceGrade(fromWilson(80, 100)).grade).not.toBe('D')
    expect(intervalWidth(fromWilson(80, 100))).toBeLessThan(intervalWidth(fromWilson(4, 5)))
  })
})
