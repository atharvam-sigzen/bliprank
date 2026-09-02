import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SCAN } from '../lib/scan-result'
import { promptBreakdown } from '../lib/prompt-breakdown'
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
