/**
 * The agency portfolio, RENDERED (MVP_PLAN D1): a row prints value, range and
 * n through the stats formatter; a zero is said in words; a row that is not a
 * check this machine collected says what it is; the client's own set is
 * labelled on the row; no invented client reaches markup; and the page,
 * before it has read the browser, claims nothing.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { customBasisOf, formatBasis } from '@bliprank/contracts/basis'
import { formatBounds, formatInterval, formatValue, wilson, type Metric } from '@bliprank/stats'
import AgencyPortfolio from '../app/agency/page'
import { portfolioRowOf } from '../lib/portfolio'
import { BUNDLED_SCANS, type ScanResultFile } from '../lib/scan-result'
import { sentence, simpleView } from '../lib/simple-view'
import type { TrackedStatus } from '../lib/tracked'
import { PortfolioClientRow } from './portfolio-row'

const ENGINES = ['chatgpt', 'copilot', 'gemini', 'google-ai-mode', 'google-ai-overviews']
const basis = (own?: number) =>
  formatBasis({ format: 'grader', engines: ENGINES, locale: 'en-US', geo: 'US', bank: { slug: 'crm-software', version: 1 }, unprompted: own ? 0 : 17, runs: 1, ...(own ? { custom: customBasisOf(['which crm suits a small team', 'which crm works offline', 'which crm is cheapest'], own) } : {}) })
const metric = (k: number, n: number, b: string): Metric => ({ ...wilson(k, n), algo_version: 'det-3', collection_path: 'third-party-grounded', comparison_basis: b })
const cycle = (day: string, k: number, n: number, b = basis(), over: Record<string, unknown> = {}): ScanResultFile =>
  ({
    status: 'scanned',
    domain: 'acme.test',
    category: 'crm-software',
    categoryName: 'CRM software',
    subjectSource: 'domain-label',
    comparisonBasis: b,
    algoVersion: 'det-3',
    counts: { cellsRequested: n, cacheHits: 0, collected: n, failed: 0, answersScored: n, providerCalls: n },
    collectedAt: `${day}T06:16:00.000Z`,
    brands: [{ id: 'domain:acme.test', name: 'Acme', isSubject: true, mentions: k, citations: 0, metric: metric(k, n, b) }],
    promptRows: [],
    run: { mode: 'live', plan: 'payg', day, engines: ENGINES, spentUsd: 0.5, capUsd: 10, at: `${day}T06:17:00.000Z`, source: 'loop' },
    ...over,
  }) as unknown as ScanResultFile
const tracked = (over: Partial<TrackedStatus>): TrackedStatus => ({ domain: 'acme.test', tracked: true, may: true, trackedInWorkspace: 1, backend: 'file', ...over }) as TrackedStatus
const TODAY = '2026-09-20'
const render = (row: NonNullable<ReturnType<typeof portfolioRowOf>>) => renderToStaticMarkup(<PortfolioClientRow row={row} />)

describe('a portfolio row', () => {
  it('PRINTS VALUE, RANGE AND n THROUGH THE STATS FORMATTER, at simple depth, with the trend in words and the re-check as an instruction', () => {
    const row = portfolioRowOf('acme.test', [cycle('2026-09-19', 20, 85), cycle('2026-09-20', 22, 85)], tracked({ until: '2026-09-25', daysLeft: 5 }), TODAY)!
    const html = simpleView(render(row))
    const m = metric(22, 85, basis())
    const text = sentence(html)
    // The value and the range are packages/stats' own strings, with the noun a percentage needs and the rate's own n.
    expect(text).toContain(`mentioned in ${formatValue(m)} of answers (${formatInterval(m)}, n=85)`)
    // The rail beside it draws the same bound the formatter prints.
    expect(html).toContain(formatBounds(m).high)
    expect(text).toContain('latest check 2026-09-20 · 2 checks so far')
    expect(text).toContain('Trend: no real change since the check before (2026-09-19): the two ranges overlap.')
    // An instruction, never "checked daily": nothing on this page knows that a check ran (review, MAJOR 1).
    expect(text).toContain('Daily re-check: set to be re-checked daily until 2026-09-25 (5 more days).')
    expect(text).not.toMatch(/Daily checks: checked daily/)
    // Nothing needs a look, so nothing says so; and no arrow is drawn for a movement inside the range (R8).
    expect(html).not.toContain('data-attention-why')
    expect(html).not.toMatch(/[▲▼↑↓]/)
    expect(html).toContain('href="/agency/client/acme.test"')
    expect(html).toContain('data-origin="collected"')
    expect(html).not.toContain('data-origin-note')
  })

  it('A ZERO IS SAID IN WORDS WITH ITS RANGE, at simple depth: a bare 0.0% rail is the defect C3r item 3 fixed on the record (review, MAJOR 4)', () => {
    const row = portfolioRowOf('acme.test', [cycle('2026-09-20', 0, 15)], tracked({ tracked: false }), TODAY)!
    const html = simpleView(render(row))
    expect(html).toContain('data-zero-mentions')
    const text = sentence(html)
    expect(text).toContain('Not named in any of the 15 answers.')
    expect(text).toContain(`could be anywhere from none at all up to ${formatBounds(metric(0, 15, basis())).high} of answers`)
    // Above zero the row says no such thing.
    expect(render(portfolioRowOf('acme.test', [cycle('2026-09-20', 1, 15)], null, TODAY)!)).not.toContain('data-zero-mentions')
  })

  it('A ROW THAT IS NOT A CHECK THIS MACHINE COLLECTED SAYS WHAT IT IS (review, MAJOR 2): the bundled reference scan, and a fixture cycle', () => {
    const reference = simpleView(render(portfolioRowOf(BUNDLED_SCANS[0]!.domain, [BUNDLED_SCANS[0]!], null, TODAY)!))
    expect(reference).toContain('data-origin="reference"')
    expect(sentence(reference)).toContain('Reference scan: a demonstration record bundled with this build and shown to every visitor.')
    const fixture = simpleView(render(portfolioRowOf('acme.test', [cycle('2026-09-20', 22, 85, basis(), { run: { mode: 'fixture', plan: 'payg', day: '2026-09-20', engines: ENGINES, capUsd: 10, at: 'x' } })], null, TODAY)!))
    expect(sentence(fixture)).toContain('Fixture answers: this cycle ran the real pipeline over fixture answers, offline.')
  })

  it('A CATEGORY THAT WAS NOT IDENTIFIED IS MARKED ON THE ROW, as the queued row and the record mark it (review, MAJOR 5)', () => {
    const row = portfolioRowOf('acme.test', [cycle('2026-09-20', 5, 85, basis(), { categoryName: 'General business software', fallback: { reason: 'unclassified', detail: 'no keyword', candidates: [] } })], null, TODAY)!
    const html = simpleView(render(row))
    expect(sentence(html)).toContain('General business software · category not confirmed · latest check')
    expect(html).toContain('data-category-note')
    expect(sentence(html)).toContain('Its category was not identified, so it was asked the general business-software questions.')
  })

  it('WHOSE QUESTIONS is on the row at simple depth, in agency words, because no two rows answer one question', () => {
    const row = portfolioRowOf('acme.test', [cycle('2026-09-20', 9, 30, basis(2))], tracked({ tracked: false }), TODAY)!
    const html = simpleView(render(row))
    expect(html).toContain('data-prompt-set')
    expect(sentence(html)).toMatch(/measured over this client.{1,8}s own 3 prompts, version 2, not the category.{1,8}s questions/)
    expect(sentence(html)).toContain('Needs a look: it is not set to be re-checked daily.')
    expect(html).toContain('data-attention="2"')
    // Over the category's questions the row says nothing about a set.
    expect(render(portfolioRowOf('acme.test', [cycle('2026-09-20', 9, 30)], null, TODAY)!)).not.toContain('data-prompt-set')
  })

  it('a lower rate against the client’s own earlier check is said as compare() says it, with the reason the row is first', () => {
    const row = portfolioRowOf('acme.test', [cycle('2026-09-19', 60, 85), cycle('2026-09-20', 10, 85)], tracked({ until: '2026-09-25', daysLeft: 5 }), TODAY)!
    const text = sentence(render(row))
    expect(text).toContain('Trend: lower than at the check before (2026-09-19): the two ranges do not overlap.')
    expect(text).toContain('Needs a look: it is lower than at the check before (2026-09-19), and the two ranges do not overlap.')
    expect(text).not.toMatch(/really fell/)
  })

  it('a re-check that could not be read is SAID on the row; provenance is there for the technical reader and marked as detail', () => {
    const row = portfolioRowOf('acme.test', [cycle('2026-09-20', 22, 85)], null, TODAY)!
    const html = render(row)
    expect(sentence(html)).toContain('Daily re-check: whether it is set to be re-checked daily could not be read here.')
    expect(html).toContain('algo det-3')
    expect(simpleView(html)).not.toContain('algo det-3')
  })
})

describe('the page', () => {
  it('NO INVENTED CLIENT REACHES MARKUP, and before the browser has been read the page claims nothing', () => {
    const html = renderToStaticMarkup(<AgencyPortfolio />)
    for (const name of ['northwind', 'ledgerwise', 'shiptide', 'harborhr', 'quillbase', 'vaultline', 'illustrative', 'Worked example', 'invented']) expect(html, name).not.toContain(name)
    expect(html).not.toContain('data-portfolio-row')
    // The notice claims only what is true of every row it can stand over.
    expect(sentence(html)).toContain('Every rate on this page comes from a cycle a budgeted runner filed')
    expect(sentence(html)).not.toContain('this machine really collected')
    expect(sentence(html)).toContain('reading this browser')
  })
})
