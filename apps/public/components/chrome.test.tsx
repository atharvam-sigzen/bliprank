import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProductBar } from './chrome'

/**
 * THE FIRST PAINT IS THE ONE UNDER TEST.
 *
 * `renderToStaticMarkup` runs no effects, which is exactly the point: it is the
 * prerendered HTML, the first client render before hydration, the crawler's
 * view and the JS-disabled reader's only view. The route decides the chrome, so
 * every one of these must be exactly right with no storage at all — a bar that
 * needs an effect to show the correct links has already shipped the wrong ones.
 */

const src = readFileSync(new URL('./chrome.tsx', import.meta.url), 'utf8')

/** The switcher's visible label in the prerendered markup. */
function switcherLabel(html: string): string {
  return html.match(/class="navbar__wsfig">([^<]*)</)?.[1] ?? ''
}

describe('ProductBar, before any effect runs', () => {
  it('agency surfaces paint the agency chrome, never the brand one', () => {
    const html = renderToStaticMarkup(<ProductBar current="agency" />)
    expect(html).toContain('href="/agency"')
    expect(html).toContain('href="/agency/add"')
    expect(html).toContain('href="/agency/pricing"')
    // The brand nav must not be on screen over a portfolio, even for one frame.
    expect(html).not.toContain('href="/dashboard"')
    expect(html).not.toContain('href="/dashboard#settings"')
  })

  it('the dashboard paints the brand chrome, never the agency one', () => {
    const html = renderToStaticMarkup(<ProductBar current="dashboard" />)
    expect(html).toContain('href="/dashboard#settings"')
    expect(html).toContain('href="/pricing"')
    expect(html).not.toContain('href="/agency')
  })

  it('neutral surfaces paint neither workspace: two doors, no switcher', () => {
    // / and both pricing pages are neutral ground. The fork is two labelled
    // doors, present in the prerender; no role navigation and no switcher
    // widget may appear, because there is no workspace here to state.
    for (const surface of ['pricing', 'grader'] as const) {
      const html = renderToStaticMarkup(<ProductBar current={surface} />)
      expect([surface, html.includes('>For brands<')]).toEqual([surface, true])
      expect([surface, html.includes('>For agencies<')]).toEqual([surface, true])
      expect([surface, html.includes('href="/dashboard#settings"')]).toEqual([surface, false])
      expect([surface, html.includes('href="/agency/add"')]).toEqual([surface, false])
      expect([surface, html.includes('navbar__wsbtn')]).toEqual([surface, false])
      // The neutral links belong to no role and are present.
      expect([surface, html.includes('href="/pricing"')]).toEqual([surface, true])
    }
  })

  it('the chrome never reads the stored role: the route decided', () => {
    // Mechanical guard on the architecture itself. A readRole call anywhere in
    // this file would make the prerender depend on storage the server does not
    // have, which is the flash-of-wrong-workspace defect all over again.
    expect(src).not.toMatch(/readRole/)
  })

  it('the doors write the role on the way through', () => {
    // Entering a door is what sets the mode — the Grader handoff and the
    // dashboard both read it back out of storage.
    expect(src).toMatch(/href="\/dashboard" onClick=\{\(\) => writeRole\('brand'\)\}/)
    expect(src).toMatch(/href="\/agency" onClick=\{\(\) => writeRole\('agency'\)\}/)
  })

  it('the switcher states the control, never a workspace it has not read', () => {
    // Storage is only readable after mount. The bar must not assert a
    // workspace, and must not assert the ABSENCE of one either: "no workspace"
    // in the prerender is a false statement about the reader's own account.
    for (const surface of ['dashboard', 'agency'] as const) {
      const html = renderToStaticMarkup(<ProductBar current={surface} />)
      expect([surface, switcherLabel(html)]).toEqual([surface, 'workspace'])
      expect([surface, html.includes('no workspace')]).toEqual([surface, false])
    }
  })

  it('the panel is closed and announced as closed at first paint', () => {
    for (const surface of ['dashboard', 'agency'] as const) {
      const html = renderToStaticMarkup(<ProductBar current={surface} />)
      expect([surface, html.includes('aria-expanded="false"')]).toEqual([surface, true])
      expect([surface, html.includes('navbar__panel')]).toEqual([surface, false])
    }
  })

  it('the panels hold records only: the role section is gone', () => {
    // The brand panel lists workspaces, the agency panel lists clients. A role
    // section in either would be a role toggle inside a role, which the
    // approved architecture forbids: leaving a role goes through the mark.
    expect(src).not.toMatch(/ROLE_LABEL|ROLE_GLOSS/)
    expect(src).not.toMatch(/>Role</)
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
    expect(src).toMatch(/if \(!open\) onOpen\(\)/)
    expect(src).toMatch(/function readStored\(\)[\s\S]{0,160}resolvable/)
    expect(src).toMatch(/function readStored\(\)[\s\S]{0,160}readAgencyDomains/)
    expect((src.match(/onOpen=\{readStored\}/g) ?? []).length).toBe(2)
  })
})
