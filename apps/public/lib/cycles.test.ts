import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { basisChangeWords, basisDifference, customBasisOf, formatBasis, type Basis } from '@bliprank/contracts/basis'
import { compare, wilson, type Metric } from '@bliprank/stats'
import { cycleDayOf, cyclesFor, dayMarker, earlierCategoryCycles, latestMovement, nextCycleDay, syncCycles, trendOf, whyNotComparable } from './cycles'
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

describe('the server’s cycles reach the browser once, on load', () => {
  const server = (cycles: unknown[], status = 200) =>
    (async () => new Response(JSON.stringify({ domain: 'acme.test', cycles }), { status })) as unknown as typeof fetch

  it('remembers cycles this browser does not hold, and reports how many', async () => {
    rememberScan(cycle('acme.test', '2026-09-01', 20))
    const added = await syncCycles('acme.test', server([cycle('acme.test', '2026-09-01', 40), cycle('acme.test', '2026-09-08', 30), cycle('acme.test', '2026-09-15', 35)]))
    expect(added).toBe(2)
    expect(cyclesFor('acme.test').map(cycleDayOf)).toEqual(['2026-09-01', '2026-09-08', '2026-09-15'])
    // A day this browser already holds is never replaced by the server's copy.
    expect(cyclesFor('acme.test')[0]!.brands[0]!.mentions).toBe(20)
  })

  it('a 404 — a deployment whose store lacks the domain — adds nothing and claims nothing', async () => {
    expect(await syncCycles('acme.test', server([], 404))).toBe(0)
    expect(await syncCycles('acme.test', (async () => { throw new Error('offline') }) as unknown as typeof fetch)).toBe(0)
    expect(cyclesFor('acme.test')).toEqual([])
  })

  it('drops what is not a result file, or is another domain’s', async () => {
    const added = await syncCycles('acme.test', server([{ junk: true }, cycle('other.test', '2026-09-08', 30), cycle('acme.test', '2026-09-08', 30)]))
    expect(added).toBe(1)
    expect(cyclesFor('acme.test').map(cycleDayOf)).toEqual(['2026-09-08'])
    expect(cyclesFor('other.test')).toEqual([])
  })
})

describe('why two cycles are not comparable, in words', () => {
  // The basis as `comparisonBasisFor` writes it today; the fixture's BASIS is
  // an older format and has no `unprompted=` or `@version` segment to differ on.
  const GRADER_BASIS = 'grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|crm-software@1|unprompted=17|runs=1'
  const m = (over: Partial<Metric>): Metric => ({ value: 0.3, ci_low: 0.2, ci_high: 0.4, n: 85, algo_version: 'det-2', collection_path: 'third-party-grounded', comparison_basis: GRADER_BASIS, ...over })

  it('names the prompt count, which is the way it will actually differ', () => {
    const a = m({ comparison_basis: GRADER_BASIS.replace('unprompted=17', 'unprompted=10') })
    expect(whyNotComparable(a, m({}))).toBe('measured on a different basis: the prompt count (17 against 10)')
  })

  it('names the bank version after a competitor promotion', () => {
    const a = m({ comparison_basis: GRADER_BASIS.replace('@1', '@2') })
    expect(whyNotComparable(a, m({}))).toContain('the bank version (')
    expect(whyNotComparable(a, m({}))).toContain('@1 against')
  })

  it('names a scoring version or a collection path before opening the basis', () => {
    expect(whyNotComparable(m({ algo_version: 'det-3' }), m({}))).toBe('scored by different versions (det-2 against det-3)')
    expect(whyNotComparable(m({ collection_path: 'official-api' }), m({}))).toContain('collected by different paths')
  })

  it('is null when nothing differs, and latestMovement carries it only for a refused pair', () => {
    expect(whyNotComparable(m({}), m({}))).toBeNull()
    rememberScan(cycle('acme.test', '2026-09-01', 10))
    rememberScan(cycle('acme.test', '2026-09-08', 50))
    expect(latestMovement(cyclesFor('acme.test'))!.why).toBeNull()
  })
})

describe('dayMarker: every reason compare() refuses for, in plain words (MVP_PLAN C3r item 2; stats review MAJOR 3, MINOR 10)', () => {
  const ENG = ['chatgpt', 'copilot', 'gemini', 'google-ai-mode', 'google-ai-overviews']
  const basisOf = (over: Partial<Basis>): string => formatBasis({ format: 'grader', engines: ENG, locale: 'en-US', geo: 'US', bank: { slug: 'crm-software', version: 1 }, unprompted: 17, runs: 1, ...over })
  const at = (k: number, n: number, basis: string, over: Partial<Metric> = {}): Metric => ({ ...wilson(k, n), algo_version: 'det-3', collection_path: 'third-party-grounded', comparison_basis: basis, ...over })
  const A = ['which crm suits a small team', 'which crm has the best mobile app', 'which crm is cheapest to start', 'which crm do accountants use', 'which crm works offline', 'which crm imports from a spreadsheet']
  const own = (v: number) => basisOf({ unprompted: 0, custom: customBasisOf(A, v) })

  it('THE COMMONEST TRANSITION: the category\u2019s questions one day, the person\u2019s own the next. It used to read "the prompt count (17 against 0), the custom prompt set (absent against 6@1)"', () => {
    const m = dayMarker(at(6, 30, own(1)), at(20, 85, basisOf({})))
    expect(m).toEqual({ kind: 'refused', text: 'not comparable with the day before: the day before was asked the category\u2019s 17 questions, and this day your own 6 questions (version 1)' })
    // Nothing on the line says a day "asked 0", and nothing is in basis notation.
    expect(m!.text).not.toMatch(/against 0|\d@\d|absent/)
  })

  it('a scoring-version boundary, a collection-path boundary and an engine change each say what changed', () => {
    expect(dayMarker(at(30, 100, basisOf({}), { algo_version: 'det-4' }), at(30, 100, basisOf({})))?.text).toBe('not comparable with the day before: the two days were scored by different versions of our scoring rules (det-3, then det-4), so they are not the same measurement')
    expect(dayMarker(at(30, 100, basisOf({}), { collection_path: 'official-api' }), at(30, 100, basisOf({})))?.text).toContain('the answers were collected in a different way')
    expect(dayMarker(at(30, 100, basisOf({ engines: ['chatgpt'] })), at(30, 100, basisOf({})))?.text).toContain('it was asked on a different set of AI engines')
    expect(dayMarker(at(30, 100, basisOf({ bank: { slug: 'crm-software', version: 2 } })), at(30, 100, basisOf({})))?.text).toContain('the category\u2019s question bank moved from version 1 to version 2')
    expect(dayMarker(at(30, 100, basisOf({ set: 1 })), at(30, 100, basisOf({})))?.text).toContain('the list of competitors it is scored against was changed')
  })

  it('THE PRECISION FALLBACK is the one sentence that depends on whyNotComparable finding nothing, and it holds ACROSS A REVERT, where the basis strings differ and the sample does not', () => {
    // Separated intervals, very unlike in width: compare() refuses on precision. Same basis...
    const thin = at(1, 30, basisOf({}))
    const thick = at(900, 3000, basisOf({}))
    expect(compare(thick, thin).label).toContain('differ too much in precision')
    expect(dayMarker(thick, thin)?.text).toBe('not comparable with the day before: one day\u2019s range is far narrower than the other\u2019s, so a gap between them could not be judged fairly')
    // ...and across a revert: version 3 holds version 1's list, so the basis is the SAME and the reason must still be precision, never "a different basis".
    const m = dayMarker(at(900, 3000, own(3)), at(1, 30, own(1)))
    expect(m?.text).toContain('far narrower than the other')
    expect(m?.text).not.toContain('questions')
  })

  it('too few answers is a refusal in its own words; a like-for-like pair is no mark; the first day has no day before it', () => {
    expect(dayMarker(at(3, 15, own(1)), at(4, 15, own(1)))).toEqual({ kind: 'refused', text: 'too few answers to compare with the day before: the smaller of the two days holds 15 answers, and a comparison needs at least 30 on each' })
    expect(dayMarker(at(3, 30, own(1)), at(1, 1, own(1)))?.text).toContain('holds 1 answer,')
    expect(dayMarker(at(10, 30, own(1)), at(11, 30, own(1)))).toBeNull()
  })

  it('the plain reading and the auditor\u2019s reading agree on WHETHER anything changed, over every pairing', () => {
    const forms = [basisOf({}), basisOf({ unprompted: 10 }), own(1), own(3), basisOf({ unprompted: 0, custom: customBasisOf(A.slice(0, 5), 2) }), basisOf({ engines: ['chatgpt'] }), basisOf({ set: 2 }), 'legacy|x|y']
    for (const x of forms) for (const y of forms) expect(basisChangeWords(x, y) === null, `${x} / ${y}`).toBe(basisDifference(x, y) === null)
  })
})
