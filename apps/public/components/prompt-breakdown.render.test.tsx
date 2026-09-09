import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SCAN } from '../lib/scan-result'
import { wilson } from '@bliprank/stats'
import { byEngine, promptBreakdown } from '../lib/prompt-breakdown'
import { simpleView, words } from '../lib/simple-view'
import { PromptBreakdown } from './prompt-breakdown'

/**
 * THE PLAIN READING OF THE BREAKDOWN, RENDERED.
 *
 * `.detail` is a CSS mechanism and there is no browser here, so the simple view
 * is modelled by `simpleView` — the executable spec of the one rule the depth
 * mechanism is made of. Its own checks live beside it in simple-view.test.ts.
 */

const html = renderToStaticMarkup(<PromptBreakdown scan={SCAN} />)
const simple = simpleView(html)

describe('the simple reading is a sentence, not a table', () => {
  it('the shipped scan actually has a breakdown, or these assert nothing', () => {
    expect(promptBreakdown(SCAN)).not.toBeNull()
    expect(html).toContain('Which questions you appear in')
  })

  it('keeps the heading and the plain sentence', () => {
    expect(simple).toContain('Which questions you appear in')
    expect(simple).toMatch(/was named in|was not named in any/)
    expect(simple).toContain('we asked')
  })

  it('drops the table, the glyph legend and every technical caveat', () => {
    expect(simple).not.toContain('<table')
    expect(simple).not.toContain('table-wrap')
    expect(simple).not.toContain('no answer was collected for that cell')
    expect(simple).not.toContain('The engine columns are counts, not rates')
    expect(simple).not.toContain('There is no sentiment column')
  })

  it('THE BUDGET: the plain reading is one sentence, not an essay', () => {
    // The full section runs to several hundred words. What survives at simple
    // depth has to stay a sentence, and a number is the only thing that keeps
    // it one as the component grows.
    expect(words(simple).length).toBeLessThanOrEqual(45)
    expect(words(html).length).toBeGreaterThan(200)
  })

  it('STATES BOTH COUNTS, so the questions figure cannot overstate', () => {
    /*
     * "named in 13 of 17 questions" is consistent with being named by one engine
     * of five each time — 13 of 85 answers, a rate of 15%. The answers pair is
     * what stops the questions pair from reading as "I am in three quarters of
     * conversations", so its presence is the honesty property, not a detail.
     */
    const b = promptBreakdown(SCAN)!
    expect(simple).toContain(String(b.answers))
    expect(simple).toContain(String(b.mentionedIn))
  })

  it('the answers pair IS the headline pair, so the two readings reconcile', () => {
    const b = promptBreakdown(SCAN)!
    const subject = SCAN.brands.find((x) => x.isSubject)!
    expect(b.mentionedIn).toBe(subject.mentions)
    expect(b.answers).toBe(subject.metric.n)
  })

  it('the question count never exceeds the questions asked', () => {
    const b = promptBreakdown(SCAN)!
    const named = b.prompts.filter((p) => p.mentionedIn > 0).length
    expect(named).toBeLessThanOrEqual(b.prompts.length)
    expect(simple).toContain(String(b.prompts.length))
  })
})

describe('a rank is not a fraction — the defect this guards', () => {
  /*
   * ⚠️ THIS SHIPPED. The cell printed `position/brandsDetected`, so "4/4" meant
   * FOURTH OF FOUR, the worst available result, and "1/5" meant first of five,
   * the best. Every reader convention says 4/4 is full marks. A reader scanning
   * the grid for strong cells found exactly the weak ones, and `.mark--hit` set
   * them all in one bold ink so the typography agreed with the misreading.
   *
   * Invisible in review because the code and the arithmetic were both right.
   * Only the rendered grid says what a reader takes from it.
   */
  const html = renderToStaticMarkup(<PromptBreakdown scan={SCAN} />)

  it('no engine cell renders a bare n/m, the shape that read backwards', () => {
    const cells = [...html.matchAll(/<span class="mark[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]!.trim())
    expect(cells.length).toBeGreaterThan(20)
    for (const c of cells) {
      expect([c, /^\d+\/\d+$/.test(c)]).toEqual([c, false])
    }
  })

  it('a named cell states the rank as a rank', () => {
    const named = [...html.matchAll(/<span class="mark mark--hit[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]!.trim())
    expect(named.length).toBeGreaterThan(0)
    for (const c of named) {
      expect([c, /^(#\d+ of \d+|named)$/.test(c)]).toEqual([c, true])
    }
  })

  it('the mark weight tracks the rank, so the pattern reads before the number', () => {
    // #1 heaviest, #2 next, #3-and-worse lightest. Three steps, not a gradient:
    // grading every rank apart would imply the sample can tell #4 from #5.
    const pairs = [...html.matchAll(/<span class="mark mark--hit (mark--rank\d)"[^>]*>(#(\d+) of \d+|named)</g)]
    expect(pairs.length).toBeGreaterThan(0)
    for (const [, cls, , pos] of pairs) {
      const rank = pos === undefined ? null : Number(pos)
      const expected = rank === 1 ? 'mark--rank1' : rank === 2 ? 'mark--rank2' : 'mark--rank3'
      expect([rank, cls]).toEqual([rank, expected])
    }
    // ...and the sweep is not vacuous: the shipped scan has a best-rank cell.
    expect(html).toContain('mark--rank1')
  })

  it('the weight is carried by ink and weight, never by colour alone', () => {
    const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
    const block = /\.mark--rank1 \{([^}]*)\}[\s\S]*?\.mark--rank2 \{([^}]*)\}[\s\S]*?\.mark--rank3 \{([^}]*)\}/.exec(css)
    expect(block).not.toBeNull()
    const [, r1, r2, r3] = block!
    // Every step differs in weight; only the last also changes ink.
    for (const rule of [r1!, r2!, r3!]) expect(rule).toMatch(/font-weight/)
    expect(r1).not.toMatch(/color/)
    expect(r2).not.toMatch(/color/)
  })

  it('rows run least covered first, so the absences are not scattered', () => {
    // They came out of a Map in insertion order before this: on the shipped scan
    // the "Named in" column ran 4,5,3,4,5,2,0,0,4,2,0,1,0,1,3,1,3.
    const tail = [...html.matchAll(/<td class="num">(\d+)\/(\d+)<\/td>\s*<\/tr>/g)].map((m) => Number(m[1]))
    expect(tail.length).toBeGreaterThan(5)
    expect([...tail]).toEqual([...tail].sort((a, b) => a - b))
  })

  it('the legend says which direction is better, in words', () => {
    // The glyph carries it and the weight carries it; neither is load-bearing
    // alone, and a reader who parses the number still needs telling.
    expect(html).toContain('Lower is better')
    expect(html).toContain('#2 of 6')
    // ...and it distinguishes the one column that IS a plain fraction.
    expect(html).toMatch(/not a rank/)
  })
})

describe('per-engine intervals — the caveat drawn instead of asserted', () => {
  const html = renderToStaticMarkup(<PromptBreakdown scan={SCAN} />)
  const b = promptBreakdown(SCAN)!
  const rows = byEngine(b)

  it('draws one bar per engine, and the shipped scan has several', () => {
    const bars = [...html.matchAll(/class="estrip__band"/g)]
    expect(rows.length).toBeGreaterThan(1)
    expect(bars.length).toBe(rows.length)
  })

  it('every band is that engine own Wilson interval, on a FIXED 0-100 track', () => {
    /*
     * Fitting the axis to five engines that all sit in a narrow band would draw
     * near-identical rates as dramatically separated bars — the chart lying by
     * omission, and the same rule the rail and the head-to-head already follow.
     * So the geometry is asserted against the interval directly.
     */
    const bands = [...html.matchAll(/class="estrip__band" style="left:([\d.]+)%;width:([\d.]+)%"/g)]
    expect(bands.length).toBe(rows.length)
    bands.forEach((m, i) => {
      const w = wilson(rows[i]!.mentionedIn, rows[i]!.answers)
      expect(Number(m[1])).toBeCloseTo(w.ci_low * 100, 4)
      expect(Number(m[2])).toBeCloseTo((w.ci_high - w.ci_low) * 100, 4)
    })
  })

  it('the reference sits at the cycle rate, identically on every row', () => {
    const refs = [...html.matchAll(/class="estrip__ref" style="left:([\d.]+)%"/g)].map((m) => Number(m[1]))
    expect(refs.length).toBe(rows.length)
    expect(new Set(refs).size).toBe(1)
    expect(refs[0]).toBeCloseTo((b.mentionedIn / b.answers) * 100, 4)
  })

  it('THE POINT OF THE SECTION: on this scan the intervals overlap, and the strip shows it', () => {
    // If every pair overlaps, no engine is separable from another — which is
    // exactly what the prose used to assert and a reader had to take on trust.
    const iv = rows.map((r) => wilson(r.mentionedIn, r.answers))
    const overlaps = iv.every((a, i) => iv.every((c, j) => i === j || (a.ci_low <= c.ci_high && c.ci_low <= a.ci_high)))
    expect(overlaps).toBe(true)
    expect(html).toContain('Where these bars overlap each other')
  })

  it('NO VERDICT is rendered, on any engine', () => {
    /*
     * Engine against engine would be a legitimate comparison — disjoint answers,
     * independent samples — but compare() keys on comparison_basis and two
     * engines differ there BY DESIGN, so it would refuse a valid comparison.
     * Resolving that is methodology (CLAUDE.md §4), not rendering. Engine
     * against the cycle rate is not legitimate at all: the overall contains this
     * engine's own answers. So nothing here ranks anything.
     */
    const section = /<section class="estrip"[\s\S]*?<\/section>/.exec(html)?.[0] ?? ''
    expect(section.length).toBeGreaterThan(200)

    /*
     * SCOPED TO THE ENGINE NAMES, not a blanket word ban. The first version of
     * this test banned the words outright and failed twice on the component's
     * own copy — once on "the answers behind the headline" and once on "none is
     * called better", the sentence that exists to DENY the verdict. A guard that
     * cannot tell a claim from its denial is a guard that gets weakened until it
     * says nothing.
     */
    const text = section.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
    for (const r of rows) {
      const claim = new RegExp(`${r.engine}[^.]{0,60}\\b(ahead|behind|better|worse|beats|leads|outperform)`, 'i')
      expect([r.engine, claim.test(text)]).toEqual([r.engine, false])
    }
    // ...and no comparison verdict markup is rendered here at all.
    expect(section).not.toContain('delta')
    expect(section).not.toContain('h2h__')
  })

  it('prints each count, so nothing depends on reading a bar', () => {
    for (const r of rows) expect(html).toContain(`${r.mentionedIn} of ${r.answers}`)
  })

  it('and the sentence it replaced is gone, not left beside it', () => {
    // Two statements of one fact is how they come to disagree.
    expect(html).not.toContain('The engine columns are counts, not rates')
  })
})
