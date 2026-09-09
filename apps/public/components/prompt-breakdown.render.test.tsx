import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SCAN } from '../lib/scan-result'
import { wilson } from '@bliprank/stats'
import { byEngine, byIntent, promptBreakdown } from '../lib/prompt-breakdown'
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
    /*
     * SCOPED TO THE SENTENCE, not raised to fit.
     *
     * This guarded "the plain reading is one sentence" when the one-liner was
     * the only thing at simple depth. `IntentSplit` was then added there
     * deliberately — approved, and the most actionable block on the page after
     * the headline — which took the section's simple reading to 139 words and
     * failed this. Raising the number to 140 would have quietly retired the
     * guard: the next paragraph would fit under it too.
     *
     * So the budget still applies to the sentence it was written for, and the
     * new block carries its own below. Two small budgets keep meaning; one big
     * one does not.
     */
    const opener = /<h2 id="breakdown-heading">[\s\S]*?<\/p>/.exec(simple)?.[0] ?? ''
    expect(opener.length).toBeGreaterThan(50)
    expect(words(opener).length).toBeLessThanOrEqual(45)
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

  /*
   * SCOPED TO THE ENGINE SECTION. `IntentSplit` reuses the same `.estrip`
   * instrument on purpose — one vocabulary for the fourth interval on the page —
   * so a sweep over the whole document counts both strips' bands and reports
   * seven where five were meant. Every assertion below reads this slice.
   */
  const section = /<section class="estrip" aria-labelledby="estrip-heading">[\s\S]*?<\/section>/.exec(html)?.[0] ?? ''
  expect(section.length).toBeGreaterThan(200)

  it('draws one bar per engine, and the shipped scan has several', () => {
    const bars = [...section.matchAll(/class="estrip__band"/g)]
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
    const bands = [...section.matchAll(/class="estrip__band" style="left:([\d.]+)%;width:([\d.]+)%"/g)]
    expect(bands.length).toBe(rows.length)
    bands.forEach((m, i) => {
      const w = wilson(rows[i]!.mentionedIn, rows[i]!.answers)
      expect(Number(m[1])).toBeCloseTo(w.ci_low * 100, 4)
      expect(Number(m[2])).toBeCloseTo((w.ci_high - w.ci_low) * 100, 4)
    })
  })

  it('the reference sits at the cycle rate, identically on every row', () => {
    const refs = [...section.matchAll(/class="estrip__ref" style="left:([\d.]+)%"/g)].map((m) => Number(m[1]))
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
    for (const r of rows) expect(section).toContain(`${r.mentionedIn} of ${r.answers}`)
  })

  it('and the sentence it replaced is gone, not left beside it', () => {
    // Two statements of one fact is how they come to disagree.
    expect(html).not.toContain('The engine columns are counts, not rates')
  })
})

describe('the question-type split', () => {
  const html = renderToStaticMarkup(<PromptBreakdown scan={SCAN} />)
  const b = promptBreakdown(SCAN)!
  const { groups, unclassified } = byIntent(b)
  const section = /<section class="estrip" aria-labelledby="intent-heading">[\s\S]*?<\/section>/.exec(html)?.[0] ?? ''

  it('the shipped scan carries intent, or none of this asserts anything', () => {
    expect(groups.length).toBe(2)
    expect(groups.map((g) => g.intent).sort()).toEqual(['discovery', 'problem-led'])
    expect(section.length).toBeGreaterThan(200)
  })

  it('draws one bar per type, on the same instrument as the engine strip', () => {
    // One vocabulary for the fourth interval on the page, not a third.
    const bands = [...section.matchAll(/class="estrip__band" style="left:([\d.]+)%;width:([\d.]+)%"/g)]
    expect(bands.length).toBe(groups.length)
    bands.forEach((m, i) => {
      const w = wilson(groups[i]!.mentionedIn, groups[i]!.answers)
      expect(Number(m[1])).toBeCloseTo(w.ci_low * 100, 4)
      expect(Number(m[2])).toBeCloseTo((w.ci_high - w.ci_low) * 100, 4)
    })
  })

  it('SURVIVES AT SIMPLE DEPTH — it is about the reader content, not our instruments', () => {
    const simpleHtml = simpleView(html)
    expect(simpleHtml).toContain('intent-heading')
    expect(simpleHtml).toContain('Choosing a tool')
    expect(simpleHtml).toContain('Solving a problem')
  })

  it('states BOTH denominators, because they say different things', () => {
    /*
     * On the shipped scan the question counts are nearly level (8 of 10 against
     * 5 of 7) while the answer rates are not (58% against 26%). Showing only the
     * questions would hide that the gap is in how OFTEN the brand is named, not
     * in whether the type reaches it at all.
     */
    for (const g of groups) {
      expect(section).toContain(`named in ${g.questionsNamedIn} of ${g.questions} questions`)
      expect(section).toContain(`${g.mentionedIn} of the ${g.answers} answers`)
    }
  })

  it('⚠️ NEVER CLAIMS SIGNIFICANCE — it states what the marks show', () => {
    /*
     * compare() would work on these two: discovery and problem-led are disjoint
     * prompt sets, so unlike two engines they are independent samples. What
     * blocks it is bookkeeping — comparison_basis is a CYCLE-level string
     * carrying `unprompted=17`, so a group metric either claims prompts the
     * group did not use or gets a subset basis that makes compare() refuse a
     * valid comparison. Recorded in PROGRESS.md, not solved here.
     */
    for (const word of ['significant', 'significantly', 'p-value', 'confidence that']) {
      expect([word, section.toLowerCase().includes(word)]).toEqual([word, false])
    }
    // What it does say is a fact about the drawn ranges.
    expect(section).toMatch(/ranges (do not overlap|overlap)/)
  })

  it('the overlap statement is DERIVED, not assumed of two bars', () => {
    /*
     * The separation on the shipped scan is 44.2 against 42.1 — two points wide.
     * One answer flipping would close it, so the sentence has to be computed
     * from the intervals every time rather than written once as a fact.
     */
    const iv = groups.map((g) => wilson(g.mentionedIn, g.answers))
    const separated = iv.every((a, i) => iv.every((c, j) => i === j || a.ci_high < c.ci_low || c.ci_high < a.ci_low))
    expect(section).toContain(separated ? 'ranges do not overlap' : 'ranges overlap')
    // ...and this scan really is the separated case, so the branch is exercised.
    expect(separated).toBe(true)
  })

  it('UNCLASSIFIED IS NEVER A THIRD BAR', () => {
    // Absent is not a category: a custom prompt nobody classified, or a cycle
    // written before the field existed. An "other" group would draw the age of
    // a file as though it were a property of the market.
    const bands = [...section.matchAll(/class="estrip__band"/g)]
    expect(bands.length).toBe(groups.length)
    expect(section).not.toContain('>Other<')
    expect(section).not.toContain('Unclassified')
    // The shipped scan classifies everything, so there is nothing to report...
    expect(unclassified).toBeNull()
    expect(section).not.toContain('carries no type')
  })

  it('ITS OWN BUDGET: two bars and a sentence, not a third essay', () => {
    // The one-liner above keeps its 45-word budget. This block gets its own, so
    // neither can grow into the other's headroom unnoticed.
    expect(words(section).length).toBeLessThanOrEqual(150)
  })
})
