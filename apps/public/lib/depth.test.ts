import { readFileSync, readdirSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * THE SIMPLE VIEW, ENFORCED.
 *
 * A depth split is one commit of discipline and then a slow slide back: the
 * simple view acquires a paragraph, then a second headline number, then a
 * provenance line "because it is only small", and eighteen months later it is
 * the essay again with a switch on top. Nothing in a review catches that,
 * because each addition is individually reasonable.
 *
 * So the four properties that make the split honest are asserted here rather
 * than remembered. They are deliberately mechanical — they read the stylesheet
 * and the source, not a screenshot — because there is no browser in this
 * toolchain and a rule nothing can check is a rule that is already broken.
 *
 *   1. The stylesheet only ever selects [data-depth='simple'], so a page with
 *      no attribute (no JavaScript) gets the FULL record, never a subset.
 *   2. No disclosure is ever marked .detail.
 *   3. The sample size survives at simple depth on every surface that prints a
 *      number.
 *   4. The simple view has a prose budget, and it is small.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

const SHEETS = [
  { name: 'apps/public', css: read('../app/globals.css') },
  { name: 'apps/web', css: read('../../web/app/globals.css') },
]

/** Every .tsx under both apps, so a new surface cannot opt out by being new. */
function sources(): { path: string; src: string }[] {
  const out: { path: string; src: string }[] = []
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue
      const child = new URL(`${entry}${entry.includes('.') ? '' : '/'}`, dir)
      if (statSync(child).isDirectory()) walk(new URL(`${entry}/`, dir))
      else if (entry.endsWith('.tsx') && !entry.includes('.test.')) out.push({ path: `${dir.pathname}${entry}`, src: readFileSync(child, 'utf8') })
    }
  }
  walk(new URL('../../public/', import.meta.url))
  walk(new URL('../../web/', import.meta.url))
  return out
}

const SOURCES = sources()

/** Every className string in either app that carries `detail`. */
const MARKED = SOURCES.flatMap(({ path, src }) =>
  [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
    .map((m) => ({ path, cls: m[1] ?? m[2] ?? '' }))
    .filter((x) => /\bdetail\b/.test(x.cls)),
)

describe('the scan is not vacuous', () => {
  /*
   * EVERY RULE BELOW IS A LOOP OVER FILES, AND A LOOP OVER NOTHING PASSES.
   *
   * The walker resolves paths itself, so a rename, a moved test directory or a
   * bad URL join would empty it silently and turn this whole suite green while
   * checking nothing at all. That failure mode is worse than no suite, because
   * it reports safety.
   */
  it('finds both apps and a realistic number of components', () => {
    // A floor near the real count, not a token one: at 20 the walker could have
    // dropped half the tree — including every bracket route, which is where the
    // agency surfaces live — and still passed.
    expect(SOURCES.length).toBeGreaterThanOrEqual(38)
    expect(SOURCES.some((s) => s.path.includes('[domain]'))).toBe(true)
    expect(SOURCES.some((s) => s.path.includes('/public/app/page.tsx'))).toBe(true)
    expect(SOURCES.some((s) => s.path.includes('/web/app/page.tsx'))).toBe(true)
    expect(SOURCES.some((s) => s.path.includes('head-to-head-section'))).toBe(true)
  })

  it('finds real .detail markings on both surfaces', () => {
    expect(MARKED.length).toBeGreaterThanOrEqual(5)
    expect(MARKED.some((m) => m.path.includes('/public/'))).toBe(true)
    expect(MARKED.some((m) => m.path.includes('/web/'))).toBe(true)
  })
})

describe('the fallback fails open: absent data-depth is the FULL record', () => {
  it('no rule selects the absence of the attribute, or the detailed value', () => {
    /*
     * THE WHOLE SAFETY PROPERTY IN ONE ASSERTION.
     *
     * `[data-depth='simple'] .detail { display: none }` hides nothing when the
     * attribute is missing. `:root:not([data-depth='simple']) .simple-only`, or
     * any rule keyed on 'detailed', would invert that: a reader whose JavaScript
     * never ran — so the boot script never stamped anything — would be served a
     * page with two thirds of it hidden and no control able to reveal it, since
     * the control is the JavaScript that did not run.
     *
     * The theme has a legitimate three-state cascade and does use :not(). Depth
     * has two states and one fail-open direction, and must never grow a third.
     */
    for (const { name, css } of SHEETS) {
      const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
      const selectors = [...stripped.matchAll(/([^{}]*)\{/g)].map((m) => m[1]!.trim()).filter((s) => s.includes('data-depth'))
      expect([name, selectors.length > 0]).toEqual([name, true])
      for (const sel of selectors) {
        expect([name, sel, /\[data-depth\s*=\s*'simple'\]/.test(sel)]).toEqual([name, sel, true])
        expect([name, sel, sel.includes('detailed')]).toEqual([name, sel, false])
        expect([name, sel, /not\s*\(\s*\[data-depth/.test(sel)]).toEqual([name, sel, false])
      }
    }
  })

  it('.detail is hidden by exactly one rule, and only under simple', () => {
    for (const { name, css } of SHEETS) {
      const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
      const hits = [...stripped.matchAll(/([^{}]*\.detail[^{}]*)\{([^}]*)\}/g)]
      expect([name, hits.length]).toEqual([name, 1])
      expect([name, hits[0]![1]!.trim()]).toEqual([name, "[data-depth='simple'] .detail"])
      expect([name, /display\s*:\s*none/.test(hits[0]![2]!)]).toEqual([name, true])
    }
  })
})

describe('a disclosure is never .detail', () => {
  /*
   * THE ONE MOVE THIS PRODUCT CANNOT MAKE. Everything on the .detail list is
   * something a reader may choose not to read. A disclosure is not: the fixture
   * stamp says the numbers were not collected from a provider, the planned
   * notice says nothing ran on a timer, and .prose--flag carries the
   * short-sample and fallback-bank caveats that change how a visible number
   * must be read. Hiding any of them to make the simple view calmer would make
   * it calmer by making it untrue.
   */
  const DISCLOSURES = ['stamp', 'notice', 'prose--flag', 'gradebadge__cap']

  it('no disclosure class shares an element with detail', () => {
    for (const { path, src } of SOURCES) {
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const cls = m[1] ?? m[2] ?? ''
        if (!/\bdetail\b/.test(cls)) continue
        for (const d of DISCLOSURES) {
          expect([path, cls, cls.includes(d)]).toEqual([path, cls, false])
        }
      }
    }
  })

  it('the check bites — it would score a disclosure marked detail as a failure', () => {
    // Without this the rule above passes vacuously the day nothing is marked.
    const cls = 'prose prose--flag detail'
    expect(/\bdetail\b/.test(cls) && DISCLOSURES.some((d) => cls.includes(d))).toBe(true)
  })
})

describe('the sample size survives at simple depth', () => {
  it('the rail prints its own n, so no surface depends on the margin for it', () => {
    /*
     * INVARIANT 2. The margin note beside a rail loses its provenance line at
     * simple depth, and that is safe only because `n` is not in it — the rail
     * prints "n = N" itself, in a node nothing marks .detail. If the rail ever
     * stopped doing that, hiding the margin would take the sample size off the
     * page and leave a bare percentage, which is the exact artefact every
     * competitor ships and this product exists not to.
     */
    const rail = read('../components/range-rail.tsx')
    expect(rail).toContain('rail__n')
    expect(rail).toContain('n = {metric.n}')
    // and it is not inside anything that carries .detail
    expect(/className="[^"]*detail[^"]*"[^>]*>\s*n = /.test(rail)).toBe(false)
  })

  it('nothing in either app marks a rail, a value or a bound as detail', () => {
    const PROTECTED = ['rail__n', 'rail__value', 'rail__bound', 'rail__track', 'record__domain']
    for (const { path, src } of SOURCES) {
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const cls = m[1] ?? m[2] ?? ''
        if (!/\bdetail\b/.test(cls)) continue
        for (const p of PROTECTED) expect([path, cls, cls.includes(p)]).toEqual([path, cls, false])
      }
    }
  })
})

describe('provenance is detail on EVERY surface, not just the one under review', () => {
  /*
   * FOUND ON REVIEW, AFTER THE FIRST PASS SHIPPED.
   *
   * The Grader marked its provenance line `.detail`; workspace-record.tsx
   * rendered the same field, from the same metric, on the same record, on two
   * notes — and neither was marked. So the simple view showed the algorithm
   * version and collection path on the dashboard and hid them on the Grader,
   * for one scan.
   *
   * Nothing caught it because the first pass tested the RULE (no disclosure is
   * detail) and not its COMPLEMENT (everything that should be detail, is). One
   * of those is checkable for a field with a single formatter, so it is checked:
   * formatProvenance has exactly one job and every call site wants the same
   * answer.
   */
  it('every rendered formatProvenance call sits on an element marked detail', () => {
    const offenders: string[] = []
    for (const { path, src } of SOURCES) {
      for (const line of src.split('\n')) {
        if (!line.includes('formatProvenance(')) continue
        // The render sites are JSX; a bare import or a helper definition is not.
        if (!line.includes('className=')) continue
        if (!/className="[^"]*\bdetail\b[^"]*"/.test(line)) offenders.push(`${path}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the check bites — it finds the call sites at all', () => {
    const sites = SOURCES.flatMap(({ path, src }) =>
      src.split('\n').filter((l) => l.includes('formatProvenance(') && l.includes('className=')).map(() => path),
    )
    expect(sites.length).toBeGreaterThanOrEqual(3)
  })
})

describe('the simple view is typeset as an interface, not as a column', () => {
  it('body prose leaves the display face at simple depth', () => {
    /*
     * THE ESSAY FIX, ASSERTED. The complaint that started this work was that the
     * product "reads like an essay or a blog", and the mechanical cause is that
     * .prose is set in the display serif at a 62ch measure. Shortening the copy
     * does not change what that signals; changing the face does.
     */
    const css = SHEETS[0]!.css.replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = /\[data-depth='simple'\]\s+\.prose\s*\{([^}]*)\}/.exec(css)?.[1]
    expect(rule).toBeDefined()
    expect(rule).toContain('var(--font-sans)')
    const measure = /max-width\s*:\s*(\d+)ch/.exec(rule!)?.[1]
    expect(Number(measure)).toBeLessThanOrEqual(50)
  })

  it('the default .prose is still the serif — the record keeps its voice', () => {
    // The simple view overrides; it does not replace. A detailed reader still
    // gets the record, and that is the point of one dataset at two depths.
    const css = SHEETS[0]!.css.replace(/\/\*[\s\S]*?\*\//g, '')
    const base = /(?:^|\})\s*\.prose\s*\{([^}]*)\}/.exec(css)?.[1]
    expect(base).toContain('var(--font-display)')
  })
})
