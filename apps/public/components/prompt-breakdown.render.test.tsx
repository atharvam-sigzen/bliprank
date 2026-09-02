import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SCAN } from '../lib/scan-result'
import { promptBreakdown } from '../lib/prompt-breakdown'
import { PromptBreakdown } from './prompt-breakdown'

/**
 * THE PLAIN READING OF THE BREAKDOWN, RENDERED.
 *
 * `.detail` is a CSS mechanism and there is no browser in this toolchain, so
 * "what a simple reader sees" is modelled the way the stylesheet models it:
 * drop every subtree whose opening tag carries `detail`, and read what is left.
 * That is exactly what `[data-depth='simple'] .detail { display: none }` does.
 */

/**
 * Strip every element marked `.detail`, honouring nesting of the same tag.
 *
 * Written as a tag tokeniser rather than a regex sweep because the first
 * attempt was a regex sweep, it silently dropped everything after the marked
 * subtree, and the three self-checks at the bottom of this file are the only
 * reason that did not quietly become the model of "what a simple reader sees"
 * for every assertion above.
 */
function simpleView(html: string): string {
  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*)>/g
  let out = ''
  let last = 0
  let skipTag: string | null = null
  let depth = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const [full, slash, tag, attrs] = m as unknown as [string, string, string, string]
    if (skipTag === null) {
      out += html.slice(last, m.index)
      if (!slash && /class="[^"]*\bdetail\b[^"]*"/.test(attrs)) {
        skipTag = tag
        depth = 1
      } else {
        out += full
      }
      last = re.lastIndex
    } else if (tag === skipTag) {
      if (slash) {
        depth--
        if (depth === 0) {
          skipTag = null
          last = re.lastIndex
        }
      } else if (!attrs.endsWith('/')) depth++
    }
  }
  return skipTag === null ? out + html.slice(last) : out
}

const html = renderToStaticMarkup(<PromptBreakdown scan={SCAN} />)
const simple = simpleView(html)
const words = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').split(/\s+/).filter(Boolean)

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
    // The four-symbol legend and the two flagged caveats travel with the table.
    expect(simple).not.toContain('no answer was collected for that cell')
    expect(simple).not.toContain('The engine columns are counts, not rates')
    expect(simple).not.toContain('There is no sentiment column')
  })

  it('THE BUDGET: the plain reading is one sentence, not an essay', () => {
    // The full section runs to several hundred words. What survives at simple
    // depth has to stay a sentence, and a number is the only thing that keeps
    // it one as the component grows.
    const body = words(simple).length
    expect(body).toBeLessThanOrEqual(45)
    expect(words(html).length).toBeGreaterThan(200)
  })

  it('STATES BOTH COUNTS, so the questions figure cannot overstate', () => {
    /*
     * "named in 4 of 6 questions" is consistent with being named by one engine
     * of five each time — 4 of 30 answers, a rate of 13%. The answers pair is
     * what stops the questions pair from reading as "I am in two thirds of
     * conversations", so its presence is the honesty property, not a detail.
     */
    const b = promptBreakdown(SCAN)!
    expect(simple).toContain(String(b.answers))
    expect(simple).toContain(String(b.mentionedIn))
  })

  it('the answers pair IS the headline pair, so the two readings reconcile', () => {
    // promptBreakdown refuses to return anything whose totals disagree with the
    // subject metric, so this is a statement about what the sentence prints.
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

describe('the stripper is not lying to the tests above', () => {
  it('removes a marked subtree and keeps its siblings', () => {
    const sample = '<div><p>keep</p><div class="x detail"><p>drop</p><table>drop</table></div><p>keep2</p></div>'
    const out = simpleView(sample)
    expect(out).toContain('keep')
    expect(out).toContain('keep2')
    expect(out).not.toContain('drop')
    expect(out).not.toContain('<table')
  })

  it('handles a marked subtree that nests the same tag', () => {
    const sample = '<div><div class="detail"><div>inner</div></div><span>after</span></div>'
    const out = simpleView(sample)
    expect(out).not.toContain('inner')
    expect(out).toContain('after')
  })

  it('leaves an unmarked document untouched', () => {
    const sample = '<section><p>a</p><p>b</p></section>'
    expect(simpleView(sample)).toBe(sample)
  })
})
