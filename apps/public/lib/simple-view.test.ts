import { describe, expect, it } from 'vitest'
import { sentence, simpleView, words } from './simple-view'

/**
 * The stripper's own checks. Every render test in both apps builds its idea of
 * "the simple reading" on this function, so a bug here does not fail — it
 * quietly makes every one of those assertions vacuous while reporting green.
 * That is exactly what the first implementation did.
 */
describe('simpleView models [data-depth="simple"] .detail { display: none }', () => {
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

  it('handles several marked subtrees in one document', () => {
    const sample = '<p>a</p><span class="detail">x</span><p>b</p><span class="detail">y</span><p>c</p>'
    const out = simpleView(sample)
    expect(words(out).join(' ')).toBe('a b c')
  })

  it('matches the class as a whole word, not as a substring', () => {
    // `.detailed` and `.no-detail` are not `.detail`, and CSS would not match
    // them either. A substring test here would hide content the page shows.
    const sample = '<p class="detailed">keep</p><p class="no-detail-here">keep</p><p class="detail">drop</p>'
    const out = simpleView(sample)
    expect(words(out).join(' ')).toBe('keep keep')
  })

  it('keeps a marked INLINE element out without eating the text around it', () => {
    const sample = '<p>Cycle 2026-08-15<span class="detail"> · 30 prompts</span> · compared with 2026-08-01</p>'
    expect(words(simpleView(sample)).join(' ')).toBe('Cycle 2026-08-15 · compared with 2026-08-01')
  })

  it('leaves an unmarked document byte-identical', () => {
    const sample = '<section><p>a</p><p>b</p></section>'
    expect(simpleView(sample)).toBe(sample)
  })

  it('does not run off the end when a marked tag is unclosed', () => {
    // Malformed input must not throw; it may only lose the tail it cannot close.
    expect(() => simpleView('<p>a</p><div class="detail"><span>b')).not.toThrow()
  })
})

describe('words()', () => {
  it('drops tags, scripts, styles and entities', () => {
    expect(words('<p>a &amp; b</p><script>var x = 1</script><style>.a{}</style>')).toEqual(['a', 'b'])
  })
})

describe('sentence()', () => {
  it('does not put a space before punctuation a tag boundary created', () => {
    // `<span>1 in 6</span>,` is "1 in 6," to a reader and "1 in 6 ," to a naive
    // tag-stripper. A whole-sentence assertion built on the latter is asserting
    // the markup, not the copy.
    expect(sentence('<p>as few as <span>1 in 6</span>, or <span>1 in 3</span>.</p>')).toBe('as few as 1 in 6, or 1 in 3.')
  })

  it('leaves ordinary spacing alone', () => {
    expect(sentence('<p>a  b</p><p>c</p>')).toBe('a b c')
  })
})
