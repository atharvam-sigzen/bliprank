import { describe, expect, it } from 'vitest'
import { wilson, type Metric } from '@bliprank/stats'
import { SCAN, subjectOf } from './scan-result'
import { PREVIEW_SCORE_CAPTION, previewScore } from './preview-score'
import { SCAN_BASIS } from './fixtures'
import type { ScanBrand } from './scan-result'

const metric = (k: number, n: number, basis: string = SCAN_BASIS): Metric => {
  const w = wilson(k, n)
  return { value: w.value, ci_low: w.ci_low, ci_high: w.ci_high, n: w.n, algo_version: 'det-1', collection_path: 'third-party-grounded', comparison_basis: basis }
}
const brand = (name: string, k: number, n: number, basis?: string): ScanBrand => ({
  id: name.toLowerCase(),
  name,
  isSubject: false,
  mentions: k,
  citations: 0,
  metric: basis ? metric(k, n, basis) : metric(k, n),
})

describe('the preview score is a placeholder that behaves honestly', () => {
  it('THE ORIENTATION: beating everyone scores far above losing to everyone', () => {
    // The failure this pins is silent. `compare(current, previous)` called with
    // the arguments the head-to-head uses would invert the position component,
    // and every score would still be a plausible-looking number in range.
    const you = brand('You', 70, 200)
    const weak = [brand('A', 10, 200), brand('B', 12, 200), brand('C', 8, 200)]
    const strong = [brand('A', 170, 200), brand('B', 175, 200), brand('C', 168, 200)]
    expect(previewScore(you, weak).score).toBeGreaterThan(previewScore(you, strong).score)
  })

  it('an overlapping interval is a draw, not a win decided by the point estimate', () => {
    // 100/200 versus 101/200: the intervals overlap enormously. Anything that
    // resolves that pair by "which number is bigger" is inventing a ranking the
    // sample cannot support, which is the thing this product refuses.
    const you = brand('You', 100, 200)
    const hairBehind = [brand('A', 99, 200)]
    const hairAhead = [brand('A', 101, 200)]
    expect(previewScore(you, hairBehind).score).toBe(previewScore(you, hairAhead).score)
  })

  it('a pair compare() refuses is excluded, not counted as a loss', () => {
    const you = brand('You', 100, 200)
    const other = brand('A', 190, 200, 'a-different-basis')
    const s = previewScore(you, [other])
    expect(s.comparable).toBe(0)
    // The component is dropped and NAMED, not given a middle value. Awarding
    // half marks for "unplaceable" scored a 0% brand above a 14% one.
    expect(s.parts.map((p) => p.label)).toEqual(['mention rate'])
    expect(s.missing).toContain('competitive position')
  })

  it('names what it could not measure instead of quietly scoring without it', () => {
    // With a rankable field, sentiment is the only thing missing.
    const s = previewScore(brand('You', 50, 200), [brand('A', 120, 200)])
    expect(s.missing).toEqual(['sentiment'])
    // Weights are renormalised over what exists, so the ceiling stays 100 — a
    // score capped at 85 reads as a bad brand rather than a missing input.
    expect(s.parts.reduce((t, p) => t + p.weight, 0)).toBeCloseTo(1, 10)
  })

  it('stays inside 0-100 across the whole range', () => {
    for (const k of [0, 1, 50, 199, 200]) {
      const s = previewScore(brand('You', k, 200), [brand('A', 100, 200)])
      expect([k, s.score >= 0 && s.score <= 100]).toEqual([k, true])
      expect([k, Number.isInteger(s.score)]).toEqual([k, true])
    }
  })

  it('runs on the real committed scan and produces something showable', () => {
    const subject = subjectOf(SCAN)
    const s = previewScore(subject, SCAN.brands.filter((b) => !b.isSubject))
    expect(s.score).toBeGreaterThan(0)
    expect(s.score).toBeLessThanOrEqual(100)
    // Close is measured at 0.0% and refused by compare() on precision
    // divergence, so it must not be in the denominator.
    expect(s.comparable).toBeLessThan(SCAN.brands.length - 1)
  })

  it('the provisional caption says provisional, in one place', () => {
    expect(PREVIEW_SCORE_CAPTION.toLowerCase()).toContain('preview')
    expect(PREVIEW_SCORE_CAPTION.toLowerCase()).toMatch(/finalis|finaliz/)
  })
})

describe('THE INVERSION THE PORTFOLIO CAUGHT', () => {
  it('a brand measured at zero never outscores a brand that was actually mentioned', () => {
    // 0/85 has an interval tight enough that compare() refuses every pairing on
    // precision divergence. When those refusals paid half of the position
    // component, zero scored 15 and 14.1% scored 10 — visible on the concept
    // portfolio, invisible to every unit test that existed at the time.
    const rivals = [brand('A', 47, 85), brand('B', 38, 85), brand('C', 26, 85)]
    const zero = previewScore(brand('Zero', 0, 85), rivals)
    const some = previewScore(brand('Some', 12, 85), rivals)
    expect(zero.score).toBe(0)
    expect(some.score).toBeGreaterThan(zero.score)
  })

  it('the score is monotone in mention rate when the field is held fixed', () => {
    const rivals = [brand('A', 47, 85), brand('B', 38, 85), brand('C', 26, 85)]
    const scores = [0, 10, 20, 40, 60, 80].map((k) => previewScore(brand('X', k, 85), rivals).score)
    for (let i = 1; i < scores.length; i += 1) expect([i, scores[i]! >= scores[i - 1]!]).toEqual([i, true])
  })
})
