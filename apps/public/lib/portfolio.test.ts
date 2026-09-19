/**
 * The agency portfolio's rows, as a model (MVP_PLAN D1): drawn from a client's
 * REAL cycles, ordered by what needs attention and never by rate, saying what
 * kind of cycle a number comes from and whose questions it answers. No
 * browser, no fetch, no fixture of invented clients: the inputs are cycle
 * files of the shape the runner writes.
 */
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { customBasisOf, formatBasis } from '@bliprank/contracts/basis'
import { formatInterval, formatMetric, formatValue, wilson, type Metric } from '@bliprank/stats'
import { FALLBACK_NOTE, FIXTURE_NOTE, NOT_A_RANKING, ORDER_NOTE, PORTFOLIO_NOTICE, REFERENCE_NOTE, byAttention, movementWords, portfolioRowOf, statedOf, trackingWords } from './portfolio'
import { BUNDLED_SCANS, type ScanResultFile } from './scan-result'
import type { TrackedStatus } from './tracked'

const ENGINES = ['chatgpt', 'copilot', 'gemini', 'google-ai-mode', 'google-ai-overviews']
const BANK = formatBasis({ format: 'grader', engines: ENGINES, locale: 'en-US', geo: 'US', bank: { slug: 'crm-software', version: 1 }, unprompted: 17, runs: 1 })
const OWN = ['which crm suits a small team', 'which crm has the best mobile app', 'which crm is cheapest to start', 'which crm do accountants use', 'which crm works offline', 'which crm imports from a spreadsheet']
const ownBasis = (version: number) => formatBasis({ format: 'grader', engines: ENGINES, locale: 'en-US', geo: 'US', bank: { slug: 'crm-software', version: 1 }, unprompted: 0, runs: 1, custom: customBasisOf(OWN, version) })

const metric = (k: number, n: number, basis: string): Metric => ({ ...wilson(k, n), algo_version: 'det-3', collection_path: 'third-party-grounded', comparison_basis: basis })
const cycle = (domain: string, day: string, k: number, n: number, basis = BANK, over: Record<string, unknown> = {}): ScanResultFile =>
  ({
    status: 'scanned',
    domain,
    category: 'crm-software',
    categoryName: 'CRM software',
    subjectSource: 'domain-label',
    comparisonBasis: basis,
    algoVersion: 'det-3',
    counts: { cellsRequested: n, cacheHits: 0, collected: n, failed: 0, answersScored: n + 40, providerCalls: n },
    collectedAt: `${day}T06:16:00.000Z`,
    brands: [{ id: `domain:${domain}`, name: domain, isSubject: true, mentions: k, citations: 0, metric: metric(k, n, basis) }],
    promptRows: [],
    run: { mode: 'live', plan: 'payg', day, engines: ENGINES, spentUsd: 0.5, capUsd: 10, at: `${day}T06:17:00.000Z`, source: 'loop' },
    ...over,
  }) as unknown as ScanResultFile

const TODAY = '2026-09-20'
const status = (over: Partial<TrackedStatus>): TrackedStatus => ({ domain: 'x', tracked: true, may: true, trackedInWorkspace: 1, backend: 'file', ...over }) as TrackedStatus
const dayN = (i: number) => new Date(Date.UTC(2026, 8, 7 + i)).toISOString().slice(0, 10)

describe('a row is drawn from the client’s real latest cycle', () => {
  it('states the rate with the noun a percentage needs, its range and the rate’s OWN n, all through packages/stats', () => {
    const row = portfolioRowOf('acme.test', [cycle('acme.test', '2026-09-19', 20, 85), cycle('acme.test', '2026-09-20', 22, 85)], status({ until: '2026-09-25', daysLeft: 5 }), TODAY)!
    const m = metric(22, 85, BANK)
    expect(row.stated).toBe(`${formatValue(m)} of answers (${formatInterval(m)}, n=85)`)
    // The same figures `formatMetric` prints, with "of answers" after the value: 25.9% OF WHAT is on the row (review, MINOR 5).
    expect(row.stated.replace(' of answers', '')).toBe(formatMetric(m))
    expect(statedOf(m)).toMatch(/^25\.9% of answers \(\d+\.\d–\d+\.\d%, n=85\)$/)
    // The fixture's `answersScored` is 125 on purpose: nothing on the row may print it as the sample.
    expect(JSON.stringify(row)).not.toContain('125')
    expect(row).toMatchObject({ domain: 'acme.test', categoryName: 'CRM software', categoryNote: null, day: '2026-09-20', cycles: 2, origin: 'collected', originNote: null, ownSet: null, ownSetWords: null })
  })

  it('no cycle is no row at all: a queued client carries no number, not a dash and not a zero', () => {
    expect(portfolioRowOf('new.test', [], null, TODAY)).toBeNull()
    expect(movementWords([])).toEqual({ words: 'no check yet', lower: null })
  })

  it('THE NOTICE IS TRUE OF EVERY ROW IT STANDS OVER (review, MAJOR 2): the bundled reference scan and a fixture cycle are said to be what they are', () => {
    expect(PORTFOLIO_NOTICE).not.toContain('this machine really collected')
    const reference = portfolioRowOf(BUNDLED_SCANS[0]!.domain, [BUNDLED_SCANS[0]!], null, TODAY)!
    expect(reference).toMatchObject({ origin: 'reference', originNote: REFERENCE_NOTE })
    expect(REFERENCE_NOTE).toContain('not a check this machine collected')
    const fixture = portfolioRowOf('acme.test', [cycle('acme.test', '2026-09-20', 22, 85, BANK, { run: { mode: 'fixture', plan: 'payg', day: '2026-09-20', engines: ENGINES, capUsd: 10, at: 'x' } })], null, TODAY)!
    expect(fixture).toMatchObject({ origin: 'fixture', originNote: FIXTURE_NOTE })
    expect(portfolioRowOf('acme.test', [cycle('acme.test', '2026-09-20', 22, 85)], null, TODAY)).toMatchObject({ origin: 'collected', originNote: null })
  })

  it('A CATEGORY THAT WAS NOT IDENTIFIED IS NOT PRINTED AS IF IT HAD BEEN (review, MAJOR 5)', () => {
    const row = portfolioRowOf('odd.test', [cycle('odd.test', '2026-09-20', 5, 85, BANK, { categoryName: 'General business software', fallback: { reason: 'unclassified', detail: 'no keyword', candidates: [] } })], null, TODAY)!
    expect(row.categoryNote).toBe(FALLBACK_NOTE)
    expect(FALLBACK_NOTE).toContain('not comparable with a check asked a category’s questions')
  })

  it('whose questions: the client’s own set is on the row, in agency words, with the record’s count and version', () => {
    const row = portfolioRowOf('own.test', [cycle('own.test', '2026-09-20', 9, 30, ownBasis(2))], null, TODAY)!
    expect(row.ownSet).toEqual({ count: 6, version: 2 })
    expect(row.ownSetWords).toBe('this client’s own 6 prompts, version 2')
    // A basis that names a set and cannot be read is still LABELLED: unlabelled beside category rows is the unsafe direction here.
    const odd = portfolioRowOf('own.test', [cycle('own.test', '2026-09-20', 9, 30, `${BANK}|custom=six`)], null, TODAY)!
    expect(odd.ownSet).toBeNull()
    expect(odd.ownSetWords).toContain('this page cannot read')
  })
})

describe('the trend is compare()’s verdict in words: no arrow, no delta, no claim about the world', () => {
  const words = (cycles: ScanResultFile[]) => movementWords(cycles)
  it('one cycle, a movement inside the range, a rise, a fall: named as the CHECK before with its date, never "the day before"', () => {
    expect(words([cycle('a.test', '2026-09-20', 20, 85)])).toEqual({ words: 'one check so far, so there is no trend yet', lower: null })
    expect(words([cycle('a.test', '2026-08-25', 20, 85), cycle('a.test', '2026-09-20', 23, 85)])).toEqual({ words: 'no real change since the check before (2026-08-25): the two ranges overlap', lower: null })
    expect(words([cycle('a.test', '2026-09-19', 10, 85), cycle('a.test', '2026-09-20', 60, 85)]).words).toBe('higher than at the check before (2026-09-19): the two ranges do not overlap')
    const fell = words([cycle('a.test', '2026-09-19', 60, 85), cycle('a.test', '2026-09-20', 10, 85)])
    expect(fell.words).toBe('lower than at the check before (2026-09-19): the two ranges do not overlap')
    expect(fell.lower).toBe('it is lower than at the check before (2026-09-19), and the two ranges do not overlap')
    // The verdict's words, not a sentence about the world (review, MINOR 2).
    expect(JSON.stringify(fell)).not.toMatch(/really|fell/)
  })

  it('too few answers says a rise or fall CANNOT show here; a change of questions is said as that', () => {
    expect(words([cycle('a.test', '2026-09-19', 9, 15), cycle('a.test', '2026-09-20', 1, 15)])).toEqual({
      words: 'too few answers to compare with the check before (2026-09-19); with fewer than 30 answers a check, a rise or a fall cannot show here',
      lower: null,
    })
    const changed = words([cycle('a.test', '2026-08-25', 20, 85), cycle('a.test', '2026-09-20', 9, 30, ownBasis(1))])
    expect(changed.words).toBe('not comparable with the check before (2026-08-25): the earlier check was asked the category’s 17 questions, and this one your own 6 questions (version 1)')
    expect(changed.words).not.toContain('the day before')
    expect(changed.lower).toBeNull()
  })

  it('A SUSTAINED FALL IS NOT "NO REAL CHANGE" (review, MAJOR 6): fourteen daily checks drifting 60% to 25%, every neighbouring pair inside the range', () => {
    const drift = Array.from({ length: 14 }, (_, i) => cycle('drift.test', dayN(i), Math.round(85 * (0.6 - (0.353 * i) / 13)), 85))
    // The defect, measured: not one neighbouring pair separates, so the last pair alone reads "no real change" and ranks 3.
    for (let i = 1; i < drift.length; i++) expect(movementWords(drift.slice(i - 1, i + 1)).lower, dayN(i)).toBeNull()
    const m = movementWords(drift)
    expect(m.words).toBe(`no real change since the check before (${dayN(12)}): the two ranges overlap; lower than on ${dayN(0)}, the oldest check comparable with it: those two ranges do not overlap`)
    expect(m.lower).toContain(`lower than on ${dayN(0)}, the oldest check comparable with it`)
    expect(portfolioRowOf('drift.test', drift, status({ until: '2026-09-30', daysLeft: 10 }), TODAY)!.attention).toEqual({ rank: 0, why: m.lower })
  })

  it('the further pair NEVER crosses a boundary: a change of questions mid-window ends the run, and only checks comparable with the latest are looked at', () => {
    const before = Array.from({ length: 5 }, (_, i) => cycle('b.test', dayN(i), 60, 85))
    const after = Array.from({ length: 4 }, (_, i) => cycle('b.test', dayN(5 + i), 9, 30, ownBasis(1)))
    const m = movementWords([...before, ...after])
    // 60 of 85 on the category's questions and 9 of 30 on the client's own are never put side by side.
    expect(m.words).toBe(`no real change since the check before (${dayN(7)}): the two ranges overlap`)
    expect(m.lower).toBeNull()
    // Three checks are the fewest that have a pair beyond the last one.
    expect(movementWords([cycle('c.test', dayN(0), 60, 85), cycle('c.test', dayN(1), 40, 85)]).words).not.toContain('oldest check')
  })
})

describe('the daily re-check is worded as the INSTRUCTION it is (review, MAJOR 1)', () => {
  it('set to be re-checked, the last day, ended, not set, fallen behind, not yet read, and unreadable', () => {
    expect(trackingWords(status({ until: '2026-09-25', daysLeft: 5 }), TODAY, TODAY)).toEqual({ words: 'set to be re-checked daily until 2026-09-25 (5 more days)', needs: null, rank: 3 })
    expect(trackingWords(status({ until: '2026-09-21', daysLeft: 1 }), TODAY, TODAY).words).toBe('set to be re-checked daily until 2026-09-21 (1 more day)')
    expect(trackingWords(status({ until: TODAY, daysLeft: 0 }), TODAY, TODAY)).toEqual({ words: `set to be re-checked daily until ${TODAY} (today is the last day)`, needs: 'its daily re-check ends today', rank: 1 })
    expect(trackingWords(status({ tracked: false, until: '2026-09-18', daysLeft: -2 }), '2026-09-18', TODAY)).toEqual({ words: 'its daily re-check ended on 2026-09-18', needs: 'its daily re-check ended on 2026-09-18', rank: 1 })
    expect(trackingWords(status({ tracked: false }), '2026-09-10', TODAY)).toEqual({ words: 'not set to be re-checked daily', needs: 'it is not set to be re-checked daily', rank: 2 })
    expect(trackingWords(status({ until: '2026-09-30', daysLeft: 10 }), '2026-09-17', TODAY).needs).toBe('it is set to be re-checked daily, and its latest check is from 2026-09-17')
    // No sentence claims a check RAN or WILL run.
    for (const s of [status({ until: '2026-09-25', daysLeft: 5 }), status({ until: TODAY, daysLeft: 0 })]) expect(trackingWords(s, TODAY, TODAY).words).not.toMatch(/^checked daily|is checked|will be checked/)
  })

  it('a status read before midnight UTC does not say "today is the last day" of an entry that ended yesterday (MINOR 4)', () => {
    expect(trackingWords(status({ tracked: true, until: '2026-09-19', daysLeft: 0 }), '2026-09-19', TODAY)).toEqual({ words: 'its daily re-check ended on 2026-09-19', needs: 'its daily re-check ended on 2026-09-19', rank: 1 })
    expect(trackingWords(status({ tracked: true, daysLeft: -2 }), TODAY, TODAY).words).not.toContain('-2')
  })

  it('A STATUS THAT COULD NOT BE READ IS SAID, and is never ranked with the clients that need nothing (MINOR 1); one not yet read claims nothing', () => {
    expect(trackingWords(null, TODAY, TODAY)).toEqual({ words: 'whether it is set to be re-checked daily could not be read here', needs: 'its daily re-check could not be read here', rank: 2 })
    expect(trackingWords(undefined, TODAY, TODAY)).toEqual({ words: 'reading whether it is set to be re-checked daily', needs: null, rank: 3 })
  })
})

describe('ORDERED BY WHAT NEEDS ATTENTION, NEVER BY RATE, and no two rows are compared', () => {
  it('a lower rate against the client’s OWN earlier check first, then re-checks that ended or fell behind, then not set, then the rest by name; the highest rate is nowhere special', () => {
    const fine = status({ until: '2026-09-30', daysLeft: 10 })
    const rows = byAttention(
      [
        portfolioRowOf('zeta-top-rate.test', [cycle('zeta-top-rate.test', '2026-09-19', 80, 85), cycle('zeta-top-rate.test', '2026-09-20', 81, 85)], fine, TODAY),
        portfolioRowOf('alpha-fine.test', [cycle('alpha-fine.test', '2026-09-19', 5, 85), cycle('alpha-fine.test', '2026-09-20', 6, 85)], fine, TODAY),
        portfolioRowOf('unreadable.test', [cycle('unreadable.test', '2026-09-20', 40, 85)], null, TODAY),
        portfolioRowOf('untracked.test', [cycle('untracked.test', '2026-09-20', 40, 85)], status({ tracked: false }), TODAY),
        portfolioRowOf('ended.test', [cycle('ended.test', '2026-09-18', 40, 85)], status({ tracked: false, until: '2026-09-18', daysLeft: -2 }), TODAY),
        portfolioRowOf('lower.test', [cycle('lower.test', '2026-09-19', 60, 85), cycle('lower.test', '2026-09-20', 10, 85)], fine, TODAY),
      ].filter((r) => r !== null),
    )
    expect(rows.map((r) => [r.domain, r.attention.rank])).toEqual([
      ['lower.test', 0],
      ['ended.test', 1],
      ['unreadable.test', 2],
      ['untracked.test', 2],
      ['alpha-fine.test', 3],
      ['zeta-top-rate.test', 3],
    ])
    expect(rows[4]!.attention.why).toBeNull()
  })

  it('the page’s two standing sentences: never by rate, and NO two rows are compared, overlapping or not (review, MAJOR 3)', () => {
    expect(ORDER_NOTE).toContain('never by rate')
    // The first draft ended "two clients whose ranges overlap are not first and second", which invites the inverse.
    expect(ORDER_NOTE).not.toContain('first and second')
    expect(NOT_A_RANKING).toContain('No two rows on this page are compared with each other, whether their ranges overlap or not')
  })
})

describe('the invented clients are gone', () => {
  const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url))
  it('the fixture file does not exist, and none of its six names is anywhere in the app’s source', () => {
    expect(existsSync(root('apps/public/lib/agency-fixture.ts'))).toBe(false)
    const files = execFileSync('git', ['ls-files', '--', 'apps/public'], { cwd: root(''), encoding: 'utf8' })
      .split('\n')
      .filter((p) => /\.(ts|tsx|css|json)$/.test(p) && !p.endsWith('lib/portfolio.test.ts') && !p.endsWith('components/portfolio-row.render.test.tsx') && existsSync(root(p)))
    const names = ['northwind.io', 'ledgerwise.com', 'shiptide.co', 'harborhr.com', 'quillbase.app', 'vaultline.dev', 'agency-fixture']
    const hits = files.flatMap((p) => names.filter((n) => readFileSync(root(p), 'utf8').includes(n)).map((n) => `${p}: ${n}`))
    expect(hits).toEqual([])
  })
})
