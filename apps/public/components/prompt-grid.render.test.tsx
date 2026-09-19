import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { promptBreakdown, type BreakdownLine } from '../lib/prompt-breakdown'
import { SCAN } from '../lib/scan-result'
import { simpleView } from '../lib/simple-view'
import { PromptGrid } from './prompt-grid'

/**
 * THE MATRIX, RENDERED — D4 item 1, and the review that followed it
 * (2026-09-19): MAJORs 1, 2 and 3, and MINORs d, e and f, fixed here
 * alongside their tests.
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

  it('MAJOR 1: the plain sentence is past tense, and never claims "any engine"', () => {
    const zero = rows.filter((r) => r.mentionedIn === 0).length
    const total = rows.length
    expect(zero).toBeGreaterThan(0)
    expect(zero).toBeLessThan(total)
    const sentence = `Pipedrive was never named in a collected answer for ${zero} of the ${total} tracked questions.`
    expect(html).toContain(sentence)
    expect(simple).toContain(sentence)
    expect(html).not.toMatch(/never name(s)? Pipedrive on any engine/)
  })

  it('the accessible name on the svg carries the same sentence, as plain text', () => {
    const label = /aria-label="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(label).toContain('least covered first')
    expect(label).toMatch(/Pipedrive was never named in a collected answer for \d+ of the \d+ tracked questions\./)
  })

  it('MINOR d: worst-first is said in a visible clause, not only in the aria-label', () => {
    expect(html).toContain('Least-covered questions first.')
    expect(simple).toContain('Least-covered questions first.')
  })

  it('MINOR f: the engine abbreviations have a visible key', () => {
    for (const e of b.engines) {
      const full = e === 'chatgpt' ? 'ChatGPT' : e === 'gemini' ? 'Gemini' : e === 'copilot' ? 'Copilot' : e === 'google-ai-mode' ? 'Google AI Mode' : 'Google AI Overviews'
      expect(html).toContain(full)
    }
    expect(html).toMatch(/GPT = ChatGPT/)
  })

  it('MAJOR 3: the fraction column has a visible head, not only a `.detail` explanation', () => {
    expect(chart).toContain('>Named in<')
  })

  it('every rank tier the shipped scan actually reaches is drawn as a distinct class', () => {
    for (const tier of ['rank1', 'rank2', 'rank3', 'miss']) {
      expect(html).toContain(`pgrid__cell--${tier}`)
    }
  })

  it('MINOR e: every named cell carries a rank numeral, not fill alone', () => {
    const namedCells = [...chart.matchAll(/pgrid__cell--rank[123]/g)].length
    const numerals = [...chart.matchAll(/class="pgrid__rank"[^>]*>([^<]+)</g)]
    expect(numerals.length).toBe(namedCells)
    for (const [, n] of numerals) expect(n === '•' || /^\d+$/.test(n!)).toBe(true)
  })

  it('a hidden table backs the picture for a screen reader, with every question named as a row header', () => {
    expect(html).toContain('class="visually-hidden"')
    for (const r of rows) expect(html).toContain(`<th scope="row">${r.prompt}</th>`)
  })

  it('MINOR f: every row has a keyboard- and touch-reachable hit target naming the full question', () => {
    const hits = [...chart.matchAll(/class="pgrid__row-hit"[^>]*role="button"[^>]*aria-label="([^"]*)"/g)]
    expect(hits.length).toBe(rows.length)
    for (const [i, [, label]] of hits.entries()) expect(label).toContain(rows[i]!.prompt)
    expect(chart).toContain('tabindex="0"')
  })

  it('the idle tip panel invites hover, tap or tab — the same device the other charts use', () => {
    expect(html).toContain('Hover, tap or tab to a question to read it in full')
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

  it('says so in one past-tense sentence, not two counts either side of the same fact', () => {
    expect(html).toContain('acme.test was never named in a collected answer for any of the 2 tracked questions.')
  })

  it('every cell is drawn as a plain miss, never as a rank tier, and carries no numeral', () => {
    // Scoped to the chart: the legend below always draws all five states as a
    // key, whatever this scan's own cells are.
    expect(chart).not.toMatch(/pgrid__cell--rank/)
    expect((chart.match(/pgrid__cell--miss/g) ?? []).length).toBe(2)
    expect(chart).not.toContain('pgrid__rank')
  })
})

describe('the small-n case: a single tracked question', () => {
  const oneRow: readonly BreakdownLine[] = [
    { prompt: 'q1', cells: [{ prompt: 'q1', engine: 'chatgpt', mentioned: true, mentionCount: 1, position: 1, brandsDetected: 3, cited: true, competitorsMentioned: [] }], answers: 1, mentionedIn: 1 },
  ]

  it('grammar: "the one tracked question", never "1 of the 1 questions"', () => {
    const html = renderToStaticMarkup(<PromptGrid rows={oneRow} engines={['chatgpt']} subjectName="acme.test" />)
    expect(html).toContain('acme.test was named in at least one collected answer to the one tracked question.')
    expect(html).not.toContain('1 questions')
  })

  it('a single missed question reads the same way in the negative', () => {
    const missed: readonly BreakdownLine[] = [
      { prompt: 'q1', cells: [{ prompt: 'q1', engine: 'chatgpt', mentioned: false, mentionCount: 0, position: null, brandsDetected: 0, cited: false, competitorsMentioned: [] }], answers: 1, mentionedIn: 0 },
    ]
    const html = renderToStaticMarkup(<PromptGrid rows={missed} engines={['chatgpt']} subjectName="acme.test" />)
    expect(html).toContain('acme.test was never named in a collected answer to the one tracked question.')
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
  const rowsWithGap: readonly BreakdownLine[] = [
    { prompt: 'q1', cells: [{ prompt: 'q1', engine: 'chatgpt', mentioned: false, mentionCount: 0, position: null, brandsDetected: 1, cited: false, competitorsMentioned: [] }], answers: 1, mentionedIn: 0 },
  ]
  const html = renderToStaticMarkup(<PromptGrid rows={rowsWithGap} engines={['chatgpt', 'gemini']} subjectName="acme.test" />)

  it('renders the none tier, distinct from a miss', () => {
    expect(html).toContain('pgrid__cell--none')
    expect(html).toContain('Gemini: no answer was collected for this question')
  })

  it('MAJOR 1: the summary sentence never claims "on any engine" for an engine that was never collected', () => {
    // A single question, and gemini never answered it: the OLD wording (never
    // name X "on any engine") would be a false claim about gemini specifically
    // — there is no gemini answer to have named or missed anything in.
    expect(html).not.toMatch(/on any engine/)
    expect(html).toContain('acme.test was never named in a collected answer to the one tracked question.')
  })

  it('MAJOR 1: an engine that returned no answer anywhere this cycle gets its own clause', () => {
    expect(html).toContain('Gemini returned no answer in this cycle, which is a fact about that engine, not about acme.test.')
  })
})

describe('MAJOR 2: more than one run can share a prompt and an engine', () => {
  it('the tier is decided by the BEST rank among the runs that named the subject', () => {
    const row: BreakdownLine = {
      prompt: 'q1',
      cells: [
        { prompt: 'q1', engine: 'chatgpt', mentioned: true, mentionCount: 1, position: 3, brandsDetected: 4, cited: false, competitorsMentioned: [] },
        { prompt: 'q1', engine: 'chatgpt', mentioned: true, mentionCount: 1, position: 1, brandsDetected: 5, cited: true, competitorsMentioned: [] },
      ],
      answers: 2,
      mentionedIn: 1,
    }
    const html = renderToStaticMarkup(<PromptGrid rows={[row]} engines={['chatgpt']} subjectName="acme.test" />)
    const chart = html.split('</svg>')[0] ?? ''
    // The better run (rank 1) decides the tier and the printed numeral, not
    // whichever run happened to be found first.
    expect(chart).toContain('pgrid__cell--rank1')
    expect(chart).not.toMatch(/pgrid__cell--rank[23]/)
    expect(chart).toContain('class="pgrid__rank"')
    const numeral = /class="pgrid__rank"[^>]*>([^<]+)</.exec(chart)?.[1]
    expect(numeral).toBe('1')
  })

  it('the tooltip states "k of r runs" rather than describing only one answer', () => {
    const row: BreakdownLine = {
      prompt: 'q1',
      cells: [
        { prompt: 'q1', engine: 'chatgpt', mentioned: true, mentionCount: 1, position: 2, brandsDetected: 3, cited: false, competitorsMentioned: [] },
        { prompt: 'q1', engine: 'chatgpt', mentioned: false, mentionCount: 0, position: null, brandsDetected: 2, cited: false, competitorsMentioned: [] },
      ],
      answers: 2,
      mentionedIn: 1,
    }
    const html = renderToStaticMarkup(<PromptGrid rows={[row]} engines={['chatgpt']} subjectName="acme.test" />)
    expect(html).toContain('ChatGPT: acme.test named in 1 of 2 runs, best #2 of 3')
  })

  it('a cell where NO run named the subject, across several runs, states the run count', () => {
    const row: BreakdownLine = {
      prompt: 'q1',
      cells: [
        { prompt: 'q1', engine: 'chatgpt', mentioned: false, mentionCount: 0, position: null, brandsDetected: 2, cited: false, competitorsMentioned: [] },
        { prompt: 'q1', engine: 'chatgpt', mentioned: false, mentionCount: 0, position: null, brandsDetected: 3, cited: false, competitorsMentioned: [] },
      ],
      answers: 2,
      mentionedIn: 0,
    }
    const html = renderToStaticMarkup(<PromptGrid rows={[row]} engines={['chatgpt']} subjectName="acme.test" />)
    expect(html).toContain('ChatGPT: acme.test not named in any of 2 runs')
  })

  it('a single run per cell (the common case) reads exactly as before', () => {
    const row: BreakdownLine = {
      prompt: 'q1',
      cells: [{ prompt: 'q1', engine: 'chatgpt', mentioned: true, mentionCount: 1, position: 1, brandsDetected: 5, cited: true, competitorsMentioned: [] }],
      answers: 1,
      mentionedIn: 1,
    }
    const html = renderToStaticMarkup(<PromptGrid rows={[row]} engines={['chatgpt']} subjectName="acme.test" />)
    expect(html).toContain('ChatGPT: acme.test named, #1 of 5, and cited')
    expect(html).not.toContain('runs')
  })
})
