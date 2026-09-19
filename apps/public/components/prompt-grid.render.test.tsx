import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { promptBreakdown, type BreakdownLine } from '../lib/prompt-breakdown'
import { SCAN } from '../lib/scan-result'
import { simpleView } from '../lib/simple-view'
import { PromptGrid } from './prompt-grid'

/**
 * THE MATRIX, RENDERED — D4 item 1.
 *
 * Same discipline as prompt-breakdown.render.test.tsx: no browser, so the
 * simple reading is modelled with `simpleView`, and every number asserted is
 * re-derived from the input rather than hand-typed, so a future change to the
 * shipped scan cannot make this suite pass by accident.
 */

const b = promptBreakdown(SCAN)!
const rows = [...b.prompts].sort((a, c) => a.mentionedIn - c.mentionedIn)

describe('the real scan: at a glance, and correct at both depths', () => {
  const html = renderToStaticMarkup(<PromptGrid rows={rows} engines={b.engines} subjectName="Pipedrive" />)
  const simple = simpleView(html)
  // Scoped to the main chart, before the first `</svg>` — the legend below it
  // is five more `<svg>` swatches, one per possible state, that would
  // otherwise pad any count of `.pgrid__cell` taken over the whole markup.
  const chart = html.split('</svg>')[0] ?? ''

  it('draws one cell per question per engine', () => {
    const cells = [...chart.matchAll(/class="pgrid__cell pgrid__cell--\w+"/g)]
    expect(cells.length).toBe(rows.length * b.engines.length)
  })

  it('renders least-covered-first, matching the order it is handed', () => {
    const counts = [...html.matchAll(/class="pgrid__count num"[^>]*>(\d+)\/(\d+)</g)].map((m) => Number(m[1]))
    expect(counts).toEqual(rows.map((r) => r.mentionedIn))
    expect(counts).toEqual([...counts].sort((x, y) => x - y))
  })

  it('the plain sentence states the real complement, and survives at simple depth', () => {
    const zero = rows.filter((r) => r.mentionedIn === 0).length
    const total = rows.length
    expect(zero).toBeGreaterThan(0)
    expect(zero).toBeLessThan(total)
    const sentence = `${zero} of the ${total} questions never name Pipedrive on any engine.`
    expect(html).toContain(sentence)
    expect(simple).toContain(sentence)
  })

  it('the accessible name on the svg carries the same sentence, as plain text', () => {
    const label = /aria-label="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(label).toContain('least covered first')
    expect(label).toMatch(/\d+ of the \d+ questions never name Pipedrive on any engine\./)
  })

  it('every rank tier the shipped scan actually reaches is drawn as a distinct class', () => {
    for (const tier of ['rank1', 'rank2', 'rank3', 'miss']) {
      expect(html).toContain(`pgrid__cell--${tier}`)
    }
  })

  it('a hidden table backs the picture for a screen reader, with every question named as a row header', () => {
    expect(html).toContain('class="visually-hidden"')
    for (const r of rows) expect(html).toContain(`<th scope="row">${r.prompt}</th>`)
  })

  it('the legend explains all five states in words, never colour alone', () => {
    for (const words of ['Named, ranked first', 'Named, ranked second', 'Named, lower rank', 'Not named', 'No answer collected']) {
      expect(html).toContain(words)
    }
  })

  it('survives at simple depth — nothing here is marked .detail', () => {
    expect(simple).toContain('pgrid__cell')
    expect(simple).toContain('Every question, every engine')
  })
})

describe('the zero case: no question ever names the subject', () => {
  const zeroRows: readonly BreakdownLine[] = [
    { prompt: 'q1', cells: [{ prompt: 'q1', engine: 'chatgpt', mentioned: false, mentionCount: 0, position: null, brandsDetected: 2, cited: false, competitorsMentioned: [] }], answers: 1, mentionedIn: 0 },
    { prompt: 'q2', cells: [{ prompt: 'q2', engine: 'chatgpt', mentioned: false, mentionCount: 0, position: null, brandsDetected: 1, cited: false, competitorsMentioned: [] }], answers: 1, mentionedIn: 0 },
  ]
  const html = renderToStaticMarkup(<PromptGrid rows={zeroRows} engines={['chatgpt']} subjectName="acme.test" />)
  const chart = html.split('</svg>')[0] ?? ''

  it('says so in one sentence, not two counts either side of the same fact', () => {
    expect(html).toContain('None of the 2 tracked questions name acme.test on any engine.')
  })

  it('every cell is drawn as a plain miss, never as a rank tier', () => {
    // Scoped to the chart: the legend below always draws all five states as a
    // key, whatever this scan's own cells are.
    expect(chart).not.toMatch(/pgrid__cell--rank/)
    expect((chart.match(/pgrid__cell--miss/g) ?? []).length).toBe(2)
  })
})

describe('the small-n case: a single tracked question', () => {
  const oneRow: readonly BreakdownLine[] = [
    { prompt: 'q1', cells: [{ prompt: 'q1', engine: 'chatgpt', mentioned: true, mentionCount: 1, position: 1, brandsDetected: 3, cited: true, competitorsMentioned: [] }], answers: 1, mentionedIn: 1 },
  ]

  it('grammar: "the one tracked question", never "1 of the 1 questions"', () => {
    const html = renderToStaticMarkup(<PromptGrid rows={oneRow} engines={['chatgpt']} subjectName="acme.test" />)
    expect(html).toContain('The one tracked question names acme.test on at least one engine.')
    expect(html).not.toContain('1 questions')
  })

  it('a single missed question reads the same way in the negative', () => {
    const missed: readonly BreakdownLine[] = [
      { prompt: 'q1', cells: [{ prompt: 'q1', engine: 'chatgpt', mentioned: false, mentionCount: 0, position: null, brandsDetected: 0, cited: false, competitorsMentioned: [] }], answers: 1, mentionedIn: 0 },
    ]
    const html = renderToStaticMarkup(<PromptGrid rows={missed} engines={['chatgpt']} subjectName="acme.test" />)
    expect(html).toContain('The one tracked question never names acme.test on any engine.')
  })
})

describe('what it refuses to draw', () => {
  it('renders nothing at all with no rows or no engines', () => {
    expect(renderToStaticMarkup(<PromptGrid rows={[]} engines={['chatgpt']} subjectName="acme.test" />)).toBe('')
    expect(
      renderToStaticMarkup(
        <PromptGrid
          rows={[{ prompt: 'q', cells: [], answers: 0, mentionedIn: 0 }]}
          engines={[]}
          subjectName="acme.test"
        />,
      ),
    ).toBe('')
  })
})

describe('an uncollected cell reads as "no answer", never as "not named"', () => {
  it('renders the none tier, distinct from a miss', () => {
    const rowsWithGap: readonly BreakdownLine[] = [
      { prompt: 'q1', cells: [{ prompt: 'q1', engine: 'chatgpt', mentioned: false, mentionCount: 0, position: null, brandsDetected: 1, cited: false, competitorsMentioned: [] }], answers: 1, mentionedIn: 0 },
    ]
    const html = renderToStaticMarkup(<PromptGrid rows={rowsWithGap} engines={['chatgpt', 'gemini']} subjectName="acme.test" />)
    expect(html).toContain('pgrid__cell--none')
    expect(html).toContain('Gemini: no answer was collected for this question')
  })
})
