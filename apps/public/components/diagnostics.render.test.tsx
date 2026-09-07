import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { citationMix } from '../lib/citations'
import type { ScanAnswers } from '../lib/answers'
import { parseGapReport } from '../lib/gaps'
import { SCAN } from '../lib/scan-result'
import { CitedSources, CitedSourcesBody } from './cited-sources'
import { GapReport, GapReportBody } from './gap-report'

/**
 * THE TWO DIAGNOSTICS, RENDERED. Synthetic evidence and a synthetic report,
 * because what is under test is the surface's honesty: no figure before the
 * reader asks, an interval beside every share, the hedges printed, the
 * truncation wording, and the sentence that says none of it is a cause.
 */

const evidence: ScanAnswers = {
  domain: 'pipedrive.com',
  category: 'crm-software',
  day: '2026-08-25',
  comparisonBasis: SCAN.comparisonBasis,
  algoVersion: 'det-2',
  answers: [
    { prompt: 'q1', engine: 'chatgpt', text: 'a', empty: false, collectedAt: '', citations: [{ url: 'https://www.pipedrive.com/features', position: 0, sourceClass: 'owned', domain: 'pipedrive.com' }, { url: 'https://www.g2.com/x', position: 1, sourceClass: 'review', domain: 'g2.com' }] },
    { prompt: 'q1', engine: 'copilot', text: 'b', empty: false, collectedAt: '', citations: [{ url: 'https://www.hubspot.com/', position: 0, sourceClass: 'competitor', domain: 'hubspot.com' }] },
    { prompt: 'q1', engine: 'gemini', text: 'c', empty: false, collectedAt: '', citations: [] },
  ],
}

describe('cited sources', () => {
  it('shows no figure until the reader asks', () => {
    const idle = renderToStaticMarkup(<CitedSources scan={SCAN} />)
    expect(idle).toContain('Show the cited sources')
    expect(idle).not.toMatch(/\d+(\.\d+)?%/)
  })

  it('every share carries its interval and its n, the subject’s own site is flagged, and the caveat is printed', () => {
    const html = renderToStaticMarkup(<CitedSourcesBody mix={citationMix(evidence)} answers={evidence} subjectName="Pipedrive" scan={SCAN} />)
    expect(html).toContain('gemini returned no sources on any answer')
    expect(html).toContain('Your own site')
    expect(html).toContain('A competitor’s site')
    expect(html).toContain('95% interval')
    expect(html).toContain('Shares of <span class="num">3</span> citations, not of answers')
    expect(html).toContain('<span class="flag">yours</span>')
    expect(html).toContain('made <span class="num">3</span> citations')
    expect(html).toContain('not a measured cause of being named')
    expect(html).toContain('algo det-2')
  })

  it('a redirect link naming no site is counted, named, and never linked or listed', () => {
    const withRedirect: ScanAnswers = {
      ...evidence,
      answers: [...evidence.answers, { prompt: 'q2', engine: 'google-ai-mode', text: 'd', empty: false, collectedAt: '', citations: [{ url: '/goto?url=abc', position: 0, sourceClass: 'other', domain: '' }] }],
    }
    const html = renderToStaticMarkup(<CitedSourcesBody mix={citationMix(withRedirect)} answers={withRedirect} subjectName="Pipedrive" scan={SCAN} />)
    expect(html).toContain('redirect link')
    expect(html).not.toContain('<th scope="row" style="font-weight:400"></th>')
    expect(html).not.toContain('href="/goto')
  })

  it('with no citations at all it says so instead of drawing a table', () => {
    const none: ScanAnswers = { ...evidence, answers: evidence.answers.map((a) => ({ ...a, citations: [] })) }
    const html = renderToStaticMarkup(<CitedSourcesBody mix={citationMix(none)} answers={none} subjectName="Pipedrive" scan={SCAN} />)
    expect(html).toContain('No answer in this cycle cited a source')
    expect(html).not.toContain('<table')
  })
})

describe('the gap report', () => {
  const base = {
    domain: 'pipedrive.com',
    category: 'crm-software',
    day: '2026-08-25',
    comparisonBasis: SCAN.comparisonBasis,
    finalUrl: 'https://www.pipedrive.com/',
    fetchedAt: '2026-09-02T12:00:00.000Z',
    bytes: 406194,
    truncated: false,
    words: 2341,
    schemaTypes: ['Organization'],
    promptCount: 2,
    meanCoverage: 0.71,
    findings: [
      { id: 'json-ld', status: 'present', what: '2 JSON-LD block(s), all parsing.', why: 'should not print for present', evidence: 'Organization' },
      { id: 'meta-description', status: 'weak', what: 'Description is 505 characters.', why: 'The band is a convention, not a measurement.', evidence: 'Sales CRM…' },
      { id: 'faq', status: 'missing', what: 'No FAQ schema and no question-shaped headings.', why: 'Whether it changes how often an answer engine cites you is not something we have measured.', evidence: '' },
    ],
    coverage: [
      { prompt: 'Which CRM is easiest?', covered: ['crm'], missing: ['easiest'], ratio: 0.5 },
      { prompt: 'Best CRM in the UK', covered: ['crm', 'uk'], missing: [], ratio: 1 },
    ],
  }

  it('shows nothing about the page until the reader asks', () => {
    const idle = renderToStaticMarkup(<GapReport scan={SCAN} />)
    expect(idle).toContain('Read the gap report')
    expect(idle).toContain('no claim that changing one changes a number')
    expect(idle).not.toMatch(/\d+%/)
  })

  it('prints every hedge, marks missing in words, orders coverage worst first, and ends on the one sentence that matters', () => {
    const html = renderToStaticMarkup(<GapReportBody report={parseGapReport(base)!} />)
    expect(html).toContain('<span class="num">1</span> missing')
    expect(html).toContain('The band is a convention, not a measurement.')
    expect(html).toContain('not something we have measured')
    expect(html).not.toContain('should not print for present')
    expect(html.indexOf('Which CRM is easiest?')).toBeLessThan(html.indexOf('Best CRM in the UK'))
    expect(html).toContain('never on the page')
    expect(html).not.toContain('not in the part of the page we read')
    expect(html).toContain('None of this is a measured cause of anything')
    expect(html).toContain('Nothing here writes or publishes anything')
    expect(html).toContain('read 2026-09-02')
    expect(html).toContain('cycle of 2026-08-25')
  })

  /* ────────────────────────────────────────────────────────────────────────
     THE COVERAGE STRIP — a count drawn as a count.
     ──────────────────────────────────────────────────────────────────────── */

  it('draws one division per term and fills the covered ones', () => {
    const html = renderToStaticMarkup(<GapReportBody report={parseGapReport(base)!} />)
    const strips = [...html.matchAll(/<span class="cov__strip"[^>]*>([\s\S]*?)<\/span><span class="cov__count/g)]
    expect(strips.length).toBe(parseGapReport(base)!.coverage.length)
    // Worst first: 1 of 2, then 2 of 2.
    const counts = strips.map((m) => ({
      total: (m[1]!.match(/class="cov__seg/g) ?? []).length,
      filled: (m[1]!.match(/cov__seg cov__seg--on/g) ?? []).length,
    }))
    expect(counts).toEqual([
      { total: 2, filled: 1 },
      { total: 2, filled: 2 },
    ])
  })

  it('prints the count in words, so nothing rests on seeing the empty divisions', () => {
    /*
     * WCAG 1.4.11 in the shape this component needs it. The filled ink and the
     * mean rule clear 3:1 and carry meaning; the EMPTY divisions are allowed to
     * be quiet only because the denominator is also stated as text. Remove the
     * count and the granularity would live in a mark at 1.1:1, which is the
     * same defect as a bar nobody can see.
     */
    const html = renderToStaticMarkup(<GapReportBody report={parseGapReport(base)!} />)
    expect(html).toContain('1 of 2')
    expect(html).toContain('2 of 2')
  })

  it('puts the mean rule at the mean, on every row', () => {
    const html = renderToStaticMarkup(<GapReportBody report={parseGapReport(base)!} />)
    const means = [...html.matchAll(/class="cov__mean" style="left:([^"]+)"/g)].map((m) => m[1]!.trim())
    expect(means.length).toBe(parseGapReport(base)!.coverage.length)
    // One position, every row: read down the column it is a single upright.
    expect(new Set(means).size).toBe(1)
    expect(means[0]).toContain(String(Math.round(parseGapReport(base)!.meanCoverage * 100)))
  })

  it('THE HONESTY CONSTRAINT: coverage never borrows the measurement rail language', () => {
    /*
     * Coverage is a word check over ONE document. It has no sample, so it has no
     * interval, and R8 does not apply because there is no estimate to carry one.
     * The rail means the opposite — "a measurement, and here is how much it does
     * not know" — so the two must not share a vocabulary. Asserted rather than
     * remembered, because the cheapest way to make this look richer later is to
     * reach for the component that is already there.
     */
    const html = renderToStaticMarkup(<GapReportBody report={parseGapReport(base)!} />)
    const cells = [...html.matchAll(/<span class="cov">([\s\S]*?)<\/span><\/td>/g)].map((m) => m[1]!)
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of cells) {
      for (const borrowed of ['rail__', 'range__', 'ci_low', '95%']) {
        expect([borrowed, cell.includes(borrowed)]).toEqual([borrowed, false])
      }
    }
    // ...and no interval is printed anywhere in the coverage section.
    expect(html).not.toMatch(/coverage[\s\S]{0,400}95% interval/i)
  })

  it('a question with no content terms says so rather than drawing an empty box', () => {
    // aeo-audit gives a prompt with no scoreable terms ratio 0. A single empty
    // division would read as "none of one term", which is a different claim.
    const empty = { ...parseGapReport(base)!, coverage: [{ prompt: 'CRM?', covered: [], missing: [], ratio: 0 }] }
    const html = renderToStaticMarkup(<GapReportBody report={empty} />)
    expect(html).toContain('no terms')
    expect(html).not.toContain('cov__strip')
  })

  it('a truncated page changes what a gap means, in the words', () => {
    const html = renderToStaticMarkup(<GapReportBody report={parseGapReport({ ...base, truncated: true })!} />)
    expect(html).toContain('not in the part of the page we read')
    expect(html).toContain('truncated at the fetch ceiling')
    expect(html).toContain('was cut off')
  })
})
