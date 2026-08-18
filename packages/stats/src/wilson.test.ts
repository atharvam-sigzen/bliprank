import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { wilson, Z_95 } from './wilson.js'

interface Reference {
  reference: string
  statsmodels: string
  /** critical value per alpha, e.g. { "0.05": 1.959… } */
  z: Record<string, number>
  cases: { alpha: number; successes: number; trials: number; ci_low: number; ci_high: number }[]
}
const ref: Reference = JSON.parse(
  readFileSync(new URL('../reference/wilson.reference.json', import.meta.url), 'utf8'),
)

// PHASES.md gate G0: "Wilson implementation agrees with reference ≤ 1e-9 across the n×p̂ grid".
describe(`agreement with ${ref.reference} (statsmodels ${ref.statsmodels})`, () => {
  it('uses the same critical value for 95%', () => {
    expect(Z_95).toBe(ref.z['0.05'])
  })

  // Cases at alpha ≠ 0.05 exist so that an implementation which quietly hardcodes
  // z somewhere (e.g. in the denominator only) cannot pass on the default alone.
  it(`matches all ${ref.cases.length} reference cases (alphas ${Object.keys(ref.z).join(', ')}) to 1e-9`, () => {
    let worst = 0
    for (const c of ref.cases) {
      const z = ref.z[String(c.alpha)]
      if (z === undefined) throw new Error(`fixture has no z for alpha=${c.alpha}`)
      const w = c.alpha === 0.05 ? wilson(c.successes, c.trials) : wilson(c.successes, c.trials, z)
      worst = Math.max(worst, Math.abs(w.ci_low - c.ci_low), Math.abs(w.ci_high - c.ci_high))
      const at = `alpha=${c.alpha} k=${c.successes} n=${c.trials}`
      expect(w.ci_low, `ci_low ${at}`).toBeCloseTo(c.ci_low, 9)
      expect(w.ci_high, `ci_high ${at}`).toBeCloseTo(c.ci_high, 9)
    }
    expect(worst).toBeLessThanOrEqual(1e-9)
  })
})

describe('wilson properties', () => {
  const kn = fc
    .tuple(fc.integer({ min: 1, max: 1_000_000 }), fc.double({ min: 0, max: 1, noNaN: true }))
    .map(([n, u]) => ({ n, k: Math.round(u * n) }))

  const zs = fc.double({ min: 0.5, max: 4, noNaN: true })

  it('0 ≤ ci_low ≤ p̂ ≤ ci_high ≤ 1 for any z, and n is echoed', () => {
    fc.assert(
      fc.property(kn, zs, ({ k, n }, z) => {
        const w = wilson(k, n, z)
        expect(w.n).toBe(n)
        expect(w.value).toBe(k / n)
        expect(w.ci_low).toBeGreaterThanOrEqual(0)
        expect(w.ci_low).toBeLessThanOrEqual(w.value)
        expect(w.ci_high).toBeGreaterThanOrEqual(w.value)
        expect(w.ci_high).toBeLessThanOrEqual(1)
      }),
    )
  })

  it('is symmetric: interval for k of n mirrors interval for n−k of n', () => {
    fc.assert(
      fc.property(kn, ({ k, n }) => {
        const a = wilson(k, n)
        const b = wilson(n - k, n)
        expect(a.ci_low).toBeCloseTo(1 - b.ci_high, 12)
        expect(a.ci_high).toBeCloseTo(1 - b.ci_low, 12)
      }),
    )
  })

  it('narrows as n grows at fixed p̂', () => {
    fc.assert(
      fc.property(kn, fc.integer({ min: 2, max: 50 }), ({ k, n }, m) => {
        const a = wilson(k, n)
        const b = wilson(k * m, n * m) // same p̂, m× the evidence
        expect(b.ci_high - b.ci_low).toBeLessThan(a.ci_high - a.ci_low)
      }),
    )
  })

  it('never returns a degenerate interval at the boundaries', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (n) => {
        expect(wilson(0, n).ci_high).toBeGreaterThan(0)
        expect(wilson(n, n).ci_low).toBeLessThan(1)
      }),
    )
  })

  it('a larger z gives a wider interval', () => {
    fc.assert(
      fc.property(kn, zs, ({ k, n }, z) => {
        const a = wilson(k, n, z)
        const b = wilson(k, n, z + 0.5)
        expect(b.ci_high - b.ci_low).toBeGreaterThan(a.ci_high - a.ci_low)
      }),
    )
  })
})

describe('wilson rejects what it cannot measure', () => {
  it.each([
    [0, 0],
    [1, 0],
    [0, -1],
    [-1, 5],
    [6, 5],
    [Number.NaN, 5],
    [1, Number.POSITIVE_INFINITY],
  ])('successes=%s trials=%s', (k, n) => {
    expect(() => wilson(k, n)).toThrow(RangeError)
  })
  it.each([0, -1.96, Number.NaN, Number.POSITIVE_INFINITY])('rejects z=%s', (z) => {
    expect(() => wilson(1, 5, z)).toThrow(RangeError)
  })
})
