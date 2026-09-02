/**
 * The per-question table, actually rendered.
 *
 * Two states, and the second is the one that ships today: every result file
 * collected before 2026-09-02 carries no rows, so the component has to say so in
 * words rather than draw an empty grid. A test that only exercised the happy
 * path would leave the sentence every existing scan actually renders unchecked.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SCAN, type ScanResultFile } from '../lib/scan-result'
import { NO_RUN_BLOCK_SCAN } from '../lib/__fixtures__/no-run-block-scan'
import { PromptBreakdown } from './prompt-breakdown'

const html = (scan: ScanResultFile) => renderToStaticMarkup(<PromptBreakdown scan={scan} />)

const withRows = (): ScanResultFile =>
  ({
    ...SCAN,
    brands: [{ ...SCAN.brands.find((b) => b.isSubject)!, mentions: 1, metric: { ...SCAN.brands.find((b) => b.isSubject)!.metric, n: 2 } }],
    promptRows: [
      {
        prompt: 'best crm for a two person team',
        engine: 'chatgpt',
        mentioned: true,
        mentionCount: 2,
        position: 2,
        brandsDetected: 6,
        cited: true,
        competitorsMentioned: ['HubSpot'],
      },
      {
        prompt: 'best crm for a two person team',
        engine: 'gemini',
        mentioned: false,
        mentionCount: 0,
        position: null,
        brandsDetected: 4,
        cited: false,
        competitorsMentioned: ['HubSpot'],
      },
    ],
  }) as ScanResultFile

describe('a cycle that carries its rows', () => {
  it('the committed reference scan is now one of them', () => {
    // It was re-derived over its own already-bought answers (`grader:rescore`),
    // so the demo shows the real table rather than the honest apology.
    const out = html(SCAN)
    expect(out).toContain('<table')
    expect(out).toContain('Which questions you appear in')
  })

  it('prints the prompt verbatim and the position as a fraction of what was detected', () => {
    const out = html(withRows())
    expect(out).toContain('best crm for a two person team')
    expect(out).toContain('2/6')
    // The row and the footer both say one of two, which is the headline.
    expect(out).toContain('1/2')
  })

  it('names the competitor the engines actually said, with its own denominator', () => {
    const out = html(withRows())
    expect(out).toContain('HubSpot')
    expect(out).toContain('2/2')
  })

  it('states the sentiment absence rather than showing an empty column', () => {
    const out = html(withRows())
    expect(out).toContain('There is no sentiment column')
    expect(out.toLowerCase()).not.toContain('<th scope="col">sentiment')
  })

  it('says the engine columns are counts and carry no interval', () => {
    // The refusal the by-engine table was originally barred for is still made,
    // in the one place a reader might mistake a column for a rate.
    expect(html(withRows())).toContain('counts, not rates')
  })
})

describe('a cycle that does not', () => {
  it('renders the absence in words, and draws no table', () => {
    /*
     * A file with no rows — the state every result written before 2026-09-02 is
     * in, and the one this component must never render as a grid of misses.
     *
     * This used to point at the committed reference scan, which was such a file
     * until it was re-derived over its own answers on 2026-09-02. Rather than
     * weaken the assertion, it now points at a fixture that genuinely carries no
     * rows: the case still exists in the wild and still has to be handled.
     */
    const out = html(NO_RUN_BLOCK_SCAN)
    expect(out).toContain('There is no per-question breakdown for this cycle')
    expect(out).not.toContain('<table')
    // And it must not imply a finding: the sentence says the payload lacks the
    // split, not that the questions went unanswered.
    expect(out).toContain('does not mean the questions went unanswered')
  })

  it('refuses a file whose rows disagree with its headline', () => {
    // Rows say one mention; the metric says none. Two measurements, one
    // heading — so neither is drawn.
    const lying = { ...withRows(), brands: [{ ...withRows().brands[0]!, mentions: 0 }] } as ScanResultFile
    expect(html(lying)).toContain('There is no per-question breakdown for this cycle')
  })
})
