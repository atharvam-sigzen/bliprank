import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProductBar } from './chrome'

/**
 * THE FIRST PAINT IS THE ONE UNDER TEST.
 *
 * `renderToStaticMarkup` runs no effects, which is exactly the point: it is the
 * prerendered HTML, the first client render before hydration, the crawler's
 * view and the JS-disabled reader's only view. The role used to be corrected in
 * an effect, so all four of those got the brand navigation over the agency
 * portfolio — and a click landing in that frame navigated to /dashboard from
 * /agency.
 */

/** The switcher's visible label in the prerendered markup. */
function switcherLabel(html: string): string {
  return html.match(/class="navbar__wsfig">([^<]*)</)?.[1] ?? ''
}

describe('ProductBar, before any effect runs', () => {
  it('agency surfaces paint the agency navigation, not the brand one', () => {
    const html = renderToStaticMarkup(<ProductBar current="agency" />)
    expect(html).toContain('href="/agency/add"')
    expect(html).toContain('href="/agency#pool-heading"')
    // The brand nav must not be on screen over a portfolio, even for one frame.
    expect(html).not.toContain('href="/dashboard#settings"')
  })

  it('the dashboard paints the brand navigation', () => {
    const html = renderToStaticMarkup(<ProductBar current="dashboard" />)
    expect(html).toContain('href="/dashboard#settings"')
    expect(html).not.toContain('href="/agency/add"')
  })

  it('the switcher states the control, never a workspace it has not read', () => {
    // /pricing and / belong to neither mode, so the stored role decides — and
    // that is only readable after mount. The bar must not assert a workspace,
    // and must not assert the ABSENCE of one either: "no workspace" in the
    // prerender is a false statement about the reader's own account.
    const html = renderToStaticMarkup(<ProductBar current="pricing" />)
    expect(switcherLabel(html)).toBe('workspace')
    expect(html).not.toContain('no workspace')
  })

  it('the panel is closed and announced as closed at first paint', () => {
    const html = renderToStaticMarkup(<ProductBar current="dashboard" />)
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('navbar__panel')
  })

  it('a surface that implies no role paints no workspace navigation at all', () => {
    // THE FINDING. `IMPLIED` covers /dashboard and /agency only. On /pricing and
    // / the role fell back to `brand` for the prerender and was replaced by the
    // stored role one paint later - so an agency reader clicking "Pricing" got
    // "Overview / Workspace", watched the strip shift to "Portfolio / Add client
    // / Prompt pool", and a click landing in that frame went to /dashboard from
    // a portfolio. The same flash-of-wrong-workspace the role fix removed from
    // the two surfaces IMPLIED does cover.
    for (const surface of ['pricing', 'grader'] as const) {
      const html = renderToStaticMarkup(<ProductBar current={surface} />)
      expect([surface, html.includes('href="/dashboard#settings"')]).toEqual([surface, false])
      expect([surface, html.includes('href="/agency/add"')]).toEqual([surface, false])
      expect([surface, html.includes('href="/agency#pool-heading"')]).toEqual([surface, false])
      // The util group belongs to no role and is unaffected.
      expect([surface, html.includes('href="/pricing"')]).toEqual([surface, true])
    }
  })

  it('the switcher re-reads storage when the panel opens', () => {
    // Asserted on the source, not on a click: this suite has no DOM, and adding
    // jsdom to fire one pointer event is a dependency for a two-line handler.
    //
    // The defect was a mount-only snapshot. /agency/add confirms a client
    // without navigating, so the bar went on saying "2 clients" above a margin
    // note on the same screen reading "3 in this portfolio"; /agency's Remove
    // did the reverse, and a Grader scan never appeared in the Workspace list
    // until a full navigation. Every stale value is only read while the panel is
    // open, so opening it is the thing that reads storage.
    const src = readFileSync(new URL('./chrome.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/onOpen=\{readStored\}/)
    expect(src).toMatch(/if \(!open\) onOpen\(\)/)
    expect(src).toMatch(/function readStored\(\)[\s\S]{0,240}readAgencyDomains/)
  })
})
