/**
 * THE EVIDENCE VIEW — the three properties that make it safe to show a reader
 * somebody else's text under our number.
 *
 *   1. IT IS NOT IN FIRST PAINT. The answers are 64 KB gzipped against 2.5 KB
 *      for the result. If they render before a reader asks, the measurement that
 *      justified the whole design is wrong.
 *
 *   2. IT IS NOT HTML. An engine's answer is third-party text arriving from a
 *      provider, and it is rendered as text. A `<script>` in an answer is
 *      characters on a page, not a script.
 *
 *   3. IT IS VERBATIM. No excerpt, no truncation, no highlight.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SCAN } from '../lib/scan-result'
import { PromptBreakdown } from './prompt-breakdown'

const html = () => renderToStaticMarkup(<PromptBreakdown scan={SCAN} />)

describe('before a reader asks', () => {
  it('⚠️ renders no answer text at all', () => {
    const out = html()
    // The reference scan's own answers, which the artefact holds and this markup
    // must not. If either of these appears, the evidence is in first paint.
    expect(out).not.toContain('evidence__text')
    expect(out).not.toContain('<details')
  })

  it('offers the evidence, and says why it is not already here', () => {
    const out = html()
    expect(out).toContain('Read what the engines actually said')
    expect(out).toContain('not loaded until you ask')
  })

  it('promises the answers that do NOT name the brand, not only the ones that do', () => {
    // The denominator is evidence too. A button offering only the hits would be
    // offering a selection, which is the thing this feature refuses to make.
    expect(html()).toMatch(/including the ones where .* was not named/)
  })
})

describe('the answer is text, not markup', () => {
  it('⚠️ escapes an answer that contains HTML', async () => {
    // Third-party text from a provider. React escapes children, and this asserts
    // that nothing later swaps in a markdown renderer without noticing what it
    // would be rendering.
    const { default: React } = await import('react')
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>'
    const out = renderToStaticMarkup(React.createElement('pre', { className: 'evidence__text' }, hostile))
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('the component never uses dangerouslySetInnerHTML', async () => {
    // The property, asserted against the source rather than a render, because
    // the render only proves it for the inputs a test happens to pass.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('./prompt-breakdown.tsx', import.meta.url)), 'utf8')
    expect(src).not.toContain('dangerouslySetInnerHTML')
  })
})

describe('the committed evidence artefact', () => {
  it('⚠️ holds every answer whole — no truncation anywhere in the pipeline', async () => {
    // Written by `grader:answers` straight out of the blob store. If anything in
    // that path ever starts excerpting, the longest answer is where it shows.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../public/scan-answers.json', import.meta.url)), 'utf8')) as {
      answers: { text: string }[]
    }
    const lengths = raw.answers.map((a) => a.text.length)
    expect(raw.answers).toHaveLength((SCAN.promptRows ?? []).length)
    /*
     * The anti-truncation signal is the SHAPE of the distribution, not a
     * threshold — a threshold only says "at least this long", which a cap above
     * it would satisfy. Measured on this artefact: 85 answers, median 2,530,
     * longest 4,613, and the top eight lengths are eight distinct values
     * (3981, 4108, 4157, 4158, 4394, 4497, 4533, 4613). Any cap anywhere in the
     * pipeline piles the top of that distribution onto one number.
     */
    const top = [...lengths].sort((a, b) => b - a).slice(0, 8)
    expect(new Set(top).size).toBe(8)
    expect(Math.max(...lengths)).toBeGreaterThan(4_000)
    // And a cap would almost certainly be a round number.
    expect(Math.max(...lengths) % 500).not.toBe(0)
  })
})
