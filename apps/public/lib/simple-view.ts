/**
 * THE EXECUTABLE MODEL OF ONE CSS RULE.
 *
 * `[data-depth='simple'] .detail { display: none }` is the whole of the depth
 * mechanism (ADR-0010), and there is no browser in this toolchain, so "what a
 * simple reader actually sees" cannot be observed — only modelled. This is the
 * model: drop every subtree whose opening tag carries `detail`, keep the rest.
 *
 * It lives here rather than inside one test file because BOTH apps render-test
 * against it, and a second copy of a subtle tokeniser is a second copy that can
 * be wrong on its own. Nothing in the shipped apps imports it; it is the spec
 * of the rule, kept next to the code the rule governs.
 *
 * ⚠️ WRITTEN AS A TOKENISER BECAUSE THE FIRST VERSION WAS A REGEX SWEEP, and
 * that version silently dropped everything after the first marked subtree —
 * which would have made every assertion built on it vacuous while reporting
 * green. `simple-view.test.ts` is the reason that was caught; it stays.
 */
/**
 * ⚠️ WHOLE-TOKEN, NOT `\bdetail\b`. A regex word boundary treats `-` as a
 * boundary, so `\bdetail\b` matches `class="no-detail-here"` and `class="foo
 * detail-panel"` — neither of which a CSS `.detail` selector matches. Getting
 * this wrong makes the model strip MORE than the stylesheet does, which means
 * a render test would assert a simple view stricter than the one that ships.
 */
export function hasClass(attrs: string, name: string): boolean {
  const value = /\sclass="([^"]*)"/.exec(attrs)?.[1]
  return value !== undefined && value.split(/\s+/).includes(name)
}

export function simpleView(html: string): string {
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
      if (!slash && hasClass(attrs, 'detail')) {
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

/**
 * The visible text of a fragment, as a reader sees it.
 *
 * Distinct from `words()` because tag boundaries are NOT word boundaries: a
 * browser renders `<span>1 in 6</span>,` as "1 in 6," while naive tag-stripping
 * gives "1 in 6 ,". Any test asserting a whole sentence needs the reader's
 * version, or it is asserting the markup rather than the copy.
 */
export function sentence(html: string): string {
  return words(html)
    .join(' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
}

/** Visible words, with tags, scripts, styles and entities stripped. */
export function words(html: string): string[] {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}
