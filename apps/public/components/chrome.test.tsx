import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProductBar } from './chrome'

/**
 * THE FIRST PAINT IS THE ONE UNDER TEST.
 *
 * `renderToStaticMarkup` runs no effects, which is exactly the point: it is the
 * prerendered HTML, the first client render before hydration, the crawler's
 * view and the JS-disabled reader's only view. The role used to be corrected in
 * an effect, so all four of those got the brand navigation and a pressed
 * "Brand" switch over the agency portfolio — and a click landing in that frame
 * navigated to /dashboard from /agency.
 */

/** The label of every role button the markup reports as pressed. */
function pressed(html: string): readonly string[] {
  return [...html.matchAll(/<button[^>]*aria-pressed="true"[^>]*>([^<]*)</g)].map((m) => m[1]!)
}

describe('ProductBar, before any effect runs', () => {
  it('agency surfaces paint the agency role, not the brand one', () => {
    const html = renderToStaticMarkup(<ProductBar current="agency" />)
    expect(pressed(html)).toEqual(['Agency'])
    expect(html).toContain('href="/agency/add"')
    expect(html).toContain('href="/agency#pool-heading"')
    // The brand nav must not be on screen over a portfolio, even for one frame.
    expect(html).not.toContain('href="/dashboard#settings"')
  })

  it('the dashboard paints the brand role', () => {
    const html = renderToStaticMarkup(<ProductBar current="dashboard" />)
    expect(pressed(html)).toEqual(['Brand'])
    expect(html).toContain('href="/dashboard#settings"')
    expect(html).not.toContain('href="/agency/add"')
  })

  it('a surface with no implied role falls back to brand and states no context', () => {
    // /pricing and / belong to neither mode, so the stored role decides — and
    // that is only readable after mount. The bar must not assert a workspace it
    // has not read yet.
    const html = renderToStaticMarkup(<ProductBar current="pricing" />)
    expect(pressed(html)).toEqual(['Brand'])
    expect(html).toContain('navbar__active')
    expect(html).not.toContain('no workspace')
  })
})
