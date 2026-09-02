import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wilson } from '@bliprank/stats'
import { cycleDayOf, cyclesFor, earlierCategoryCycles, latestMovement, nextCycleDay, trendOf } from './cycles'
import { rememberScan, scanFor, SCAN, type ScanResultFile } from './scan-result'
import { NO_RUN_BLOCK_SCAN } from './__fixtures__/no-run-block-scan'

/**
 * SYNTHETIC CYCLES. Every day, count and interval here is invented for the
 * test; nothing is collected and no real domain is measured. The arithmetic is
 * real: each metric comes from `wilson()`, so the comparisons below are the
 * ones `compare()` would make on a real pair.
 */
const BASIS = NO_RUN_BLOCK_SCAN.comparisonBasis
const cycle = (domain: string, day: string, mentions: number, n = 85, extra: Partial<ScanResultFile> = {}): ScanResultFile => {
  const w = wilson(mentions, n)
  return {
    ...NO_RUN_BLOCK_SCAN,
    domain,
    collectedAt: `${day}T09:00:00.000Z`,
    run: { mode: 'live', plan: 'payg', day, engines: ['chatgpt', 'gemini', 'copilot', 'google-ai-mode', 'google-ai-overviews'], capUsd: 5, at: `${day}T09:05:00.000Z` },
    brands: [
      {
        id: 'domain:' + domain,
        name: domain,
        isSubject: true,
        mentions,
        citations: 0,
        metric: { value: w.value, ci_low: w.ci_low, ci_high: w.ci_high, n: w.n, algo_version: 'det-2', collection_path: 'third-party-grounded', comparison_basis: BASIS },
      },
    ],
    ...extra,
  }
}

let store: Map<string, string>
beforeEach(() => {
  store = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
})
afterEach(() => vi.unstubAllGlobals())

describe('cycles are kept side by side, one per day', () => {
  it('a second day is a second cycle, and the latest is what scanFor returns', () => {
    rememberScan(cycle('acme.test', '2026-09-01', 20))
    rememberScan(cycle('acme.test', '2026-09-08', 30))
    expect(cyclesFor('acme.test').map(cycleDayOf)).toEqual(['2026-09-01', '2026-09-08'])
    expect(scanFor('acme.test')?.collectedAt.slice(0, 10)).toBe('2026-09-08')
  })

  it('oldest first whatever order they were remembered in', () => {
    rememberScan(cycle('acme.test', '2026-09-08', 30))
    rememberScan(cycle('acme.test', '2026-09-01', 20))
    expect(cyclesFor('acme.test').map(cycleDayOf)).toEqual(['2026-09-01', '2026-09-08'])
  })

  it('the same day remembered twice is one cycle — the newer write wins, nothing is appended', () => {
    rememberScan(cycle('acme.test', '2026-09-01', 20))
    rememberScan(cycle('acme.test', '2026-09-01', 25))
    const cycles = cyclesFor('acme.test')
    expect(cycles).toHaveLength(1)
    expect(cycles[0]!.brands[0]!.mentions).toBe(25)
  })

  it('⚠️ a newer session cycle of the bundled domain becomes its latest, and the bundled one stays as history', () => {
    // The reference scan is 2026-08-25. A cycle collected later in this browser
    // is the newer measurement, so the record leads with it — and the bundled
    // cycle is still the first point of the trend, not shadowed.
    const later = cycle(SCAN.domain, '2026-09-20', 40, 85, { category: SCAN.category, categoryName: SCAN.categoryName, comparisonBasis: SCAN.comparisonBasis })
    rememberScan(later)
    expect(scanFor(SCAN.domain)?.collectedAt.slice(0, 10)).toBe('2026-09-20')
    expect(cyclesFor(SCAN.domain).map(cycleDayOf)).toEqual(['2026-08-25', '2026-09-20'])
  })

  it('a session copy of the bundled cycle on the SAME day does not shadow the bundled file', () => {
    rememberScan(cycle(SCAN.domain, '2026-08-25', 1, 85))
    expect(scanFor(SCAN.domain)).toBe(SCAN)
    expect(cyclesFor(SCAN.domain)[0]).toBe(SCAN)
  })

  it('⚠️ a cycle under an earlier category is kept off the trend, and counted', () => {
    // The sigzen shape: collected under general-business-software, recorded
    // since as erp-software, re-collected under the new one. Two real files,
    // one trend — R5 forbids reading the old number under the new name.
    rememberScan(cycle('acme.test', '2026-09-01', 20, 85, { category: 'general-business-software', categoryName: 'General business software' }))
    rememberScan(cycle('acme.test', '2026-09-08', 30, 85, { category: 'erp-software', categoryName: 'ERP software' }))
    const cycles = cyclesFor('acme.test')
    expect(cycles.map((c) => c.category)).toEqual(['erp-software'])
    expect(earlierCategoryCycles('acme.test')).toBe(1)
    expect(latestMovement(cycles)).toBeNull()
    expect(scanFor('acme.test')?.category).toBe('erp-software')
  })

  it('domains do not mix', () => {
    rememberScan(cycle('acme.test', '2026-09-01', 20))
    rememberScan(cycle('other.test', '2026-09-02', 20))
    expect(cyclesFor('acme.test')).toHaveLength(1)
    expect(cyclesFor('other.test')).toHaveLength(1)
  })
})

describe('the trend is the subject metric per cycle, compared by compare()', () => {
  it('one cycle is one point and no movement', () => {
    rememberScan(cycle('acme.test', '2026-09-01', 20))
    const cycles = cyclesFor('acme.test')
    expect(trendOf(cycles)).toHaveLength(1)
    expect(latestMovement(cycles)).toBeNull()
  })

  it('overlapping intervals read as no significant change, never as an arrow', () => {
    rememberScan(cycle('acme.test', '2026-09-01', 20))
    rememberScan(cycle('acme.test', '2026-09-08', 24))
    const m = latestMovement(cyclesFor('acme.test'))!
    expect(m.previous).toBe('2026-09-01')
    expect(m.current).toBe('2026-09-08')
    expect(m.verdict.significance).toBe('no-significant-change')
  })

  it('separated intervals of similar precision read as a real move', () => {
    rememberScan(cycle('acme.test', '2026-09-01', 10))
    rememberScan(cycle('acme.test', '2026-09-08', 50))
    expect(latestMovement(cyclesFor('acme.test'))!.verdict.significance).toBe('higher')
  })

  it('a scoring bump between cycles refuses the comparison (R5), and the trend carries both stamps', () => {
    rememberScan(cycle('acme.test', '2026-09-01', 10))
    const bumped = cycle('acme.test', '2026-09-08', 50)
    rememberScan({ ...bumped, brands: [{ ...bumped.brands[0]!, metric: { ...bumped.brands[0]!.metric, algo_version: 'det-3' } }] })
    const cycles = cyclesFor('acme.test')
    expect(latestMovement(cycles)!.verdict.significance).toBe('not-comparable')
    expect(trendOf(cycles).map((p) => p.metric.algo_version)).toEqual(['det-2', 'det-3'])
  })

  it('a changed basis between cycles refuses the comparison too', () => {
    rememberScan(cycle('acme.test', '2026-09-01', 10))
    rememberScan(cycle('acme.test', '2026-09-08', 50, 85, { comparisonBasis: BASIS + '|x' }))
    // The basis lives on the metric, which is what compare() reads.
    const c = cyclesFor('acme.test')
    const withBasis = { ...c[1]!, brands: [{ ...c[1]!.brands[0]!, metric: { ...c[1]!.brands[0]!.metric, comparison_basis: BASIS + '|x' } }] }
    expect(latestMovement([c[0]!, withBasis])!.verdict.significance).toBe('not-comparable')
  })
})

describe('when the next cycle is possible', () => {
  it('today, when the latest cycle is older than today', () => {
    expect(nextCycleDay([cycle('acme.test', '2026-09-01', 20)], '2026-09-02')).toEqual({ possible: true, from: '2026-09-02' })
    expect(nextCycleDay([], '2026-09-02')).toEqual({ possible: true, from: '2026-09-02' })
  })

  it('tomorrow, when today is already collected — the cache key is per day', () => {
    expect(nextCycleDay([cycle('acme.test', '2026-09-02', 20)], '2026-09-02')).toEqual({ possible: false, from: '2026-09-03' })
    // Month and year roll correctly.
    expect(nextCycleDay([cycle('acme.test', '2026-12-31', 20)], '2026-12-31')).toEqual({ possible: false, from: '2027-01-01' })
  })
})
