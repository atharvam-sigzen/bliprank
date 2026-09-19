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

  it('MINOR b: states the mean as an average of PER-QUESTION shares, not a share of pooled words', () => {
    const meanPct = Math.round(r.meanCoverage * 100)
    // "of the words across the N questions" reads as a pooled share of every
    // word on every question — but meanCoverage is the unweighted mean of
    // each question's OWN ratio (aeo-audit.ts), which is a different
    // quantity whenever term counts differ per question, exactly as they do
    // here (2 terms, 2 terms, 2 terms is not the real spread — this fixture
    // uses 2/2/2 by coincidence, so the wording itself is what is checked).
    expect(html).toContain(`On average across the <span class="num">3</span> questions, the page uses about <span class="num">${meanPct}%</span> of each question&#x27;s main words.`)
    // Two of the three fall under half: 1/3 and 0/2.
    expect(html).toContain('<span class="num">2</span> of the 3 questions are missing more than half their terms')
  })

  it('names the worst question by its real ratio, not by array order', () => {
    expect(html).toContain('The least covered is “How do I migrate from a spreadsheet?”, using <span class="num">0</span> of its <span class="num">2</span> terms.')
  })

  it('MINOR d: the worst-first order is a visible clause, not only the aria-label', () => {
    expect(html).toContain('Least-covered questions first.')
    expect(simple).toContain('Least-covered questions first.')
  })

  it('MINOR i: the comparison basis sits beside the day and prompt count, at detail depth', () => {
    // A distinctive basis of its own — 'b', the shared fixture's default, is
    // one character and would make `not.toContain` meaningless (it is a
    // substring of dozens of ordinary words on the page).
    const basis = 'grader|engines=chatgpt|en-US|US|crm-software@1|unprompted=3'
    const withBasis = report({ comparisonBasis: basis, coverage })
    const withBasisHtml = renderToStaticMarkup(<GapReportBody report={withBasis} />)
    const withBasisSimple = simpleView(withBasisHtml)
    const noteLine = /<span class="note__line detail">([^<]*)<\/span>/.exec(withBasisHtml)?.[1] ?? ''
    expect(noteLine).toContain(withBasis.day)
    expect(noteLine).toContain(String(withBasis.promptCount))
    expect(noteLine).toContain(basis)
    expect(withBasisSimple).not.toContain(basis)
  })

  it('draws one .covladder__row per question, least covered first', () => {
    const order = [...html.matchAll(/class="covladder__q">([^<]*)</g)].map((m) => m[1])
    expect(order).toEqual(['How do I migrate from a spreadsheet?', 'Which CRM is easiest?', 'Best CRM in the UK'])
  })

  it('survives at simple depth: the ladder and its sentence are not marked .detail', () => {
    expect(simple).toContain('covladder__row')
    expect(simple).toContain('On average across the')
  })

  it('the exact table with the missing terms is real .detail', () => {
    expect(html).toContain('table-wrap')
    expect(html).toContain('easiest, cheap')
    expect(simple).not.toContain('table-wrap')
    expect(simple).not.toContain('easiest, cheap')
  })
})

describe('MINOR c: "the least covered" is not said when it would mislead', () => {
  it('is suppressed outright when the worst ratio is 1 — every question is fully covered', () => {
    const html = renderToStaticMarkup(
      <GapReportBody
        report={report({
          meanCoverage: 1,
          coverage: [
            { prompt: 'Question A', covered: ['a', 'b'], missing: [], ratio: 1 },
            { prompt: 'Question B', covered: ['c'], missing: [], ratio: 1 },
          ],
        })}
      />,
    )
    // "least covered first" is the ladder's own standing aria-label and stays
    // whatever the data; only "least covered IS" — the sentence naming one
    // question — must be gone.
    expect(html).not.toContain('least covered is')
  })

  it('says "one of the least covered" rather than "the least covered" on a genuine tie', () => {
    const html = renderToStaticMarkup(
      <GapReportBody
        report={report({
          meanCoverage: 0.5,
          coverage: [
            { prompt: 'Question A', covered: [], missing: ['x', 'y'], ratio: 0 },
            { prompt: 'Question B', covered: [], missing: ['z', 'w'], ratio: 0 },
            { prompt: 'Question C', covered: ['v'], missing: [], ratio: 1 },
          ],
        })}
      />,
    )
    expect(html).toContain('One of the least covered is')
    expect(html).not.toContain('The least covered is')
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
    expect(html).toContain('across the <span class="num">1</span> question, the page uses about')
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
