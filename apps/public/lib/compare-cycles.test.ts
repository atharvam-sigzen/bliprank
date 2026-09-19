/**
 * The trend across a change of questions, and across a change back
 * (MVP_PLAN C3r item 1). `compare()` is never re-implemented here: these cases
 * show what it is handed, and that every other guard it has still speaks.
 */

import { describe, expect, it } from 'vitest'
import { customBasisOf, formatBasis, type Basis } from '@bliprank/contracts/basis'
import { compare, wilson, type Metric } from '@bliprank/stats'
import { compareCycles, continuousCycles } from './compare-cycles'

const base: Basis = { format: 'grader', engines: ['chatgpt', 'gemini'], locale: 'en-US', geo: 'US', bank: { slug: 'crm-software', version: 1 }, unprompted: 0, runs: 1 }
const A = ['What is the best CRM for a small team?', 'Which CRM has the best mobile app?', 'Which CRM is cheapest to start with?']
const B = ['What is the best CRM for a small team?', 'Which CRM has the best mobile app?', 'Which CRM do accountants recommend?']
const on = (prompts: readonly string[], version: number): string => formatBasis({ ...base, custom: customBasisOf(prompts, version) })
const m = (mentions: number, n: number, basis: string, over: Partial<Metric> = {}): Metric => ({ ...wilson(mentions, n), algo_version: 'det-3', collection_path: 'third-party-grounded', comparison_basis: basis, ...over })

describe('a revert to a list asked before is the same sample', () => {
  it('version 3 holding version 1’s list compares with it, where compare() alone refuses on the string', () => {
    const day1 = m(30, 100, on(A, 1))
    const day3 = m(31, 100, on(A, 3))
    expect(compare(day3, day1).significance).toBe('not-comparable')
    expect(compareCycles(day3, day1).significance).toBe('no-significant-change')
    expect(continuousCycles(day3, day1)).toBe(true)
  })

  it('the version between them, a different list, is refused both ways and breaks the line', () => {
    const day1 = m(30, 100, on(A, 1))
    const day2 = m(60, 100, on(B, 2))
    const day3 = m(31, 100, on(A, 3))
    expect(compareCycles(day2, day1).significance).toBe('not-comparable')
    expect(compareCycles(day3, day2).significance).toBe('not-comparable')
    expect(continuousCycles(day2, day1)).toBe(false)
    expect(continuousCycles(day3, day2)).toBe(false)
  })

  it('two different lists saved as the same count and version are refused: the string alone used to let them through', () => {
    expect(compareCycles(m(60, 100, on(B, 1)), m(30, 100, on(A, 1))).significance).toBe('not-comparable')
  })

  it('every other guard still speaks on a reverted pair: the scoring version, the collection path, the floor on n', () => {
    const day1 = m(30, 100, on(A, 1))
    expect(compareCycles(m(31, 100, on(A, 3), { algo_version: 'det-4' }), day1).label).toContain('scored by det-3 then det-4')
    expect(compareCycles(m(31, 100, on(A, 3), { collection_path: 'official-api' }), day1).significance).toBe('not-comparable')
    expect(compareCycles(m(3, 9, on(A, 3)), m(2, 9, on(A, 1))).significance).toBe('insufficient-data')
    expect(continuousCycles(m(31, 100, on(A, 3), { algo_version: 'det-4' }), day1)).toBe(false)
  })

  it('a cycle stored before the fingerprint existed is compared as the string it is: equal to itself, refused against a fingerprinted one', () => {
    const old = formatBasis({ ...base, custom: { count: 3, version: 1 } })
    expect(compareCycles(m(31, 100, old), m(30, 100, old)).significance).toBe('no-significant-change')
    expect(compareCycles(m(31, 100, on(A, 1)), m(30, 100, old)).significance).toBe('not-comparable')
  })

  it('an identical basis is handed to compare() untouched', () => {
    const a = m(60, 100, on(A, 1))
    const b = m(30, 100, on(A, 1))
    expect(compareCycles(a, b)).toEqual(compare(a, b))
  })
})
