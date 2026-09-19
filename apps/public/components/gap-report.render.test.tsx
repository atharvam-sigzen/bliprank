import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GapReport } from '../lib/gaps'
import { simpleView } from '../lib/simple-view'
import { GapReportBody } from './gap-report'

/**
 * THE COVERAGE LADDER, RENDERED — D4 item 3.
 *
 * Synthetic reports throughout, built to the `GapReport` shape directly
 * (`parseGapReport` is exercised in `lib/gaps.test.ts`; this file only checks
 * what the component does with an already-valid report). Numbers asserted
 * below are derived from the fixture's own `coverage` array, never hand-typed
 * against what the shipped bundled report happens to hold.
 */

const report = (over: Partial<GapReport> = {}): GapReport => ({
  domain: 'acme.test',
  category: 'crm-software',
  day: '2026-09-01',
  comparisonBasis: 'b',
  finalUrl: 'https://acme.test/',
  fetchedAt: '2026-09-01T00:00:00.000Z',
  bytes: 1000,
  truncated: false,
  words: 500,
  schemaTypes: [],
  promptCount: 3,
  meanCoverage: 0.5,
  findings: [],
  coverage: [],
  ...over,
})

describe('a real spread of coverage: the ladder, and the plain reading built from it', () => {
  const coverage: GapReport['coverage'] = [
    { prompt: 'Which CRM is easiest?', covered: ['crm'], missing: ['easiest', 'cheap'], ratio: 1 / 3 },
    { prompt: 'Best CRM in the UK', covered: ['crm', 'uk'], missing: [], ratio: 1 },
    { prompt: 'How do I migrate from a spreadsheet?', covered: [], missing: ['migrate', 'spreadsheet'], ratio: 0 },
  ]
  const r = report({ meanCoverage: (1 / 3 + 1 + 0) / 3, coverage })
  const html = renderToStaticMarkup(<GapReportBody report={r} />)
  const simple = simpleView(html)

  it('states the mean and the count of badly-covered questions, both real numbers', () => {
    const meanPct = Math.round(r.meanCoverage * 100)
    expect(html).toContain(`On average the page uses about <span class="num">${meanPct}%</span> of the words across the <span class="num">3</span> questions`)
    // Two of the three fall under half: 1/3 and 0/2.
    expect(html).toContain('<span class="num">2</span> of the 3 questions are missing more than half their terms')
  })

  it('names the worst question by its real ratio, not by array order', () => {
    expect(html).toContain('The least covered is “How do I migrate from a spreadsheet?”, using <span class="num">0</span> of its <span class="num">2</span> terms.')
  })

  it('draws one .covladder__row per question, least covered first', () => {
    const order = [...html.matchAll(/class="covladder__q">([^<]*)</g)].map((m) => m[1])
    expect(order).toEqual(['How do I migrate from a spreadsheet?', 'Which CRM is easiest?', 'Best CRM in the UK'])
  })

  it('survives at simple depth: the ladder and its sentence are not marked .detail', () => {
    expect(simple).toContain('covladder__row')
    expect(simple).toContain('On average the page uses about')
  })

  it('the exact table with the missing terms is real .detail', () => {
    expect(html).toContain('table-wrap')
    expect(html).toContain('easiest, cheap')
    expect(simple).not.toContain('table-wrap')
    expect(simple).not.toContain('easiest, cheap')
  })
})

describe('the zero case: no questions were checked against the page', () => {
  const html = renderToStaticMarkup(<GapReportBody report={report({ coverage: [], meanCoverage: 0 })} />)

  it('says so in one sentence and draws no ladder', () => {
    expect(html).toContain("There were no questions to check this page&#x27;s coverage against.")
    expect(html).not.toContain('covladder')
  })
})

describe('the small-n case: exactly one tracked question', () => {
  it('singular grammar, and the "every one" branch when it is well covered', () => {
    const html = renderToStaticMarkup(<GapReportBody report={report({ meanCoverage: 0.8, coverage: [{ prompt: 'Only one?', covered: ['a', 'b'], missing: [], ratio: 1 }] })} />)
    expect(html).toContain('across the <span class="num">1</span> question we checked it against')
    expect(html).toContain('Every one of them reaches at least half.')
    expect(html).not.toContain('1 questions')
  })

  it('the "none reach half" branch when the one question is badly covered', () => {
    const html = renderToStaticMarkup(<GapReportBody report={report({ meanCoverage: 0.1, coverage: [{ prompt: 'Only one?', covered: [], missing: ['a', 'b', 'c'], ratio: 0 }] })} />)
    expect(html).toContain('None of them reach half.')
    expect(html).toContain('The least covered is “Only one?”')
  })
})

describe('a question with no content terms at all is never named as "the least covered"', () => {
  it('skips the empty row and names the worst question that actually has terms', () => {
    const html = renderToStaticMarkup(
      <GapReportBody
        report={report({
          meanCoverage: 0.4,
          coverage: [
            { prompt: 'A prompt with nothing to check', covered: [], missing: [], ratio: 0 },
            { prompt: 'A real question', covered: ['a'], missing: ['b', 'c'], ratio: 1 / 3 },
          ],
        })}
      />,
    )
    expect(html).toContain('The least covered is “A real question”')
    expect(html).not.toContain('A prompt with nothing to check”')
  })

  it('CoverageStrip states "no terms" for the empty row rather than an empty bar', () => {
    const html = renderToStaticMarkup(
      <GapReportBody report={report({ coverage: [{ prompt: 'Nothing to check', covered: [], missing: [], ratio: 0 }] })} />,
    )
    expect(html).toContain('no terms')
  })
})
