import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BUNDLED_SCANS, normaliseTyped } from '@/lib/scan-result'
import { ProductBar, THEME_BOOT, withTheme, workspaceGroups } from './chrome'

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
    expect(html).not.toContain('href="/dashboard/workspace"')
  })

  it('the dashboard paints the brand chrome, never the agency one', () => {
    const html = renderToStaticMarkup(<ProductBar current="dashboard" />)
    expect(html).toContain('href="/dashboard/workspace"')
    expect(html).toContain('href="/pricing"')
    expect(html).not.toContain('href="/agency')
  })

  it('the workspace route lights its own nav link, not Overview', () => {
    const html = renderToStaticMarkup(<ProductBar current="workspace" />)
    expect(html).toContain('navbar__link--on" href="/dashboard/workspace"')
    expect(html).not.toContain('navbar__link--on" href="/dashboard"')
  })

  it('neutral surfaces paint neither workspace: two doors, no switcher', () => {
    // / and both pricing pages are neutral ground. The fork is two labelled
    // doors, present in the prerender; no role navigation and no switcher
    // widget may appear, because there is no workspace here to state.
    for (const surface of ['pricing', 'grader'] as const) {
      const html = renderToStaticMarkup(<ProductBar current={surface} />)
      expect([surface, html.includes('>For brands<')]).toEqual([surface, true])
      expect([surface, html.includes('>For agencies<')]).toEqual([surface, true])
      expect([surface, html.includes('href="/dashboard/workspace"')]).toEqual([surface, false])
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
    expect(src).toMatch(/href="\/" onClick=\{\(\) => writeRole\('brand'\)\}/)
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
    expect(src).toMatch(/function readStored\(\)[\s\S]{0,160}workspaceGroups/)
    expect(src).toMatch(/function readStored\(\)[\s\S]{0,160}readAgencyDomains/)
    expect((src.match(/onOpen=\{readStored\}/g) ?? []).length).toBe(2)
  })

  it('the panel separates the visitor’s work from the bundled reference scans', () => {
    // Source assertions, same reason as above: the panel only exists after a
    // click this suite cannot fire. Both group caps are present, in order, and
    // the reference group carries the serif gloss saying whose data it is not.
    expect(src).toMatch(/>Your workspaces</)
    expect(src).toMatch(/>Reference scans</)
    expect(src.indexOf('Your workspaces')).toBeLessThan(src.indexOf('Reference scans'))
    expect(src).toContain('Demo reference records bundled with this build, not your data.')
  })
})

describe('the depth switch is on every chrome, before any effect runs', () => {
  const SURFACES = ['grader', 'pricing', 'dashboard', 'workspace', 'agency'] as const

  it('every surface paints it — the plain view must never hide that a full one exists', () => {
    for (const surface of SURFACES) {
      const html = renderToStaticMarkup(<ProductBar current={surface} />)
      expect([surface, html.includes('role="switch"')]).toEqual([surface, true])
      expect([surface, html.includes('Full detail')]).toEqual([surface, true])
    }
  })

  it('GUARD 5: it is labelled by the thing it switches, not by the state it is in', () => {
    /*
     * A control reading "Simple" over a simple view advertises nothing. The
     * evaluator most likely to screenshot this page and file the product as
     * another vibes tool is the one who never learns the depth exists — so the
     * words "Full detail" are on screen at BOTH depths, and aria-checked, not
     * the label, carries which one is showing.
     */
    const html = renderToStaticMarkup(<ProductBar current="grader" />)
    expect(html).toContain('Full detail')
    expect(html).not.toContain('>Simple<')
  })

  it('paints unchecked before hydration, whatever the route default turns out to be', () => {
    // useDepth' server snapshot is null by design: the prerender cannot read an
    // attribute the boot script has not written yet. The VIEW does not flash —
    // the boot stamped data-depth before first paint — only this label corrects
    // itself, exactly as the theme toggle's does.
    for (const surface of SURFACES) {
      const html = renderToStaticMarkup(<ProductBar current={surface} />)
      expect([surface, html.includes('aria-checked="false"')]).toEqual([surface, true])
    }
  })

  it('sits beside the theme toggle in the slot that already existed', () => {
    // One slot, two controls, no new grid column and no new breakpoint.
    const html = renderToStaticMarkup(<ProductBar current="dashboard" />)
    const slot = html.match(/<div class="navbar__theme">(.*?)<\/div><div/s)?.[1]
    // Asserted, not defaulted: falling back to the whole document here would
    // make every line below pass without the slot existing at all.
    expect(slot).toBeDefined()
    expect(slot).toContain('role="switch"')
    expect(slot).toContain('themetoggle')
    // Depth first in the DOM, so it is the first of the two a keyboard or
    // screen-reader user reaches. It is the one that changes what is on screen.
    expect(slot!.indexOf('role="switch"')).toBeLessThan(slot!.lastIndexOf('themetoggle'))
  })
})

describe('workspaceGroups', () => {
  it('with no session scans, every bundled domain is reference and none is yours', () => {
    // Node has no localStorage, which is exactly the fresh-browser case.
    const { yours, reference } = workspaceGroups()
    expect(yours).toEqual([])
    expect(reference).toEqual([...new Set(BUNDLED_SCANS.map((s) => normaliseTyped(s.domain)))])
  })

  it('a session scan is yours, and shadows the matching reference row', () => {
    const bundled = normaliseTyped(BUNDLED_SCANS[0]!.domain)
    // Full valid scans: the storage guard now checks what render dereferences,
    // so a stub with brands:[{}] is (rightly) dropped as corrupt.
    const stash = JSON.stringify([
      { ...BUNDLED_SCANS[0]!, domain: 'example.com' },
      { ...BUNDLED_SCANS[0]!, domain: bundled },
    ])
    const g = globalThis as { localStorage?: Storage }
    g.localStorage = { getItem: () => stash } as unknown as Storage
    try {
      const { yours, reference } = workspaceGroups()
      expect(yours).toContain('example.com')
      // A domain the visitor re-scanned this session is their work now, and
      // must not also appear as a reference record.
      expect(yours).toContain(bundled)
      expect(reference).not.toContain(bundled)
    } finally {
      delete g.localStorage
    }
  })
})

describe('withTheme', () => {
  it('returns the url unchanged on the server: no window, no crash', () => {
    expect(withTheme('http://localhost:3000/dashboard')).toBe('http://localhost:3000/dashboard')
  })

  it('appends the stored choice, with ? or & as the url requires', () => {
    const g = globalThis as { window?: unknown }
    g.window = { localStorage: { getItem: () => 'dark' } }
    try {
      expect(withTheme('http://localhost:3000/')).toBe('http://localhost:3000/?theme=dark')
      expect(withTheme('http://localhost:3000/?x=1')).toBe('http://localhost:3000/?x=1&theme=dark')
    } finally {
      delete g.window
    }
  })

  it('appends nothing when the choice is system (nothing stored)', () => {
    const g = globalThis as { window?: unknown }
    g.window = { localStorage: { getItem: () => null } }
    try {
      expect(withTheme('http://localhost:3000/')).toBe('http://localhost:3000/')
    } finally {
      delete g.window
    }
  })
})

describe('THEME_BOOT', () => {
  /** Run the boot script against stubbed globals; report what it did. */
  function runBoot(search: string, stored?: string) {
    const store = new Map<string, string>()
    if (stored) store.set('bliprank-theme', stored)
    const attrs = new Map<string, string>()
    const g = globalThis as Record<string, unknown>
    g.location = { search }
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
    g.document = { documentElement: { setAttribute: (k: string, v: string) => void attrs.set(k, v) } }
    try {
      // Indirect eval, so the script resolves the stubs through globalThis —
      // the same way the real inline script resolves the real globals.
      ;(0, eval)(THEME_BOOT)
    } finally {
      delete g.location
      delete g.localStorage
      delete g.document
    }
    return { attr: attrs.get('data-theme'), stored: store.get('bliprank-theme') }
  }

  it('a theme param wins over the stored choice, is applied, and is persisted', () => {
    expect(runBoot('?theme=dark', 'light')).toEqual({ attr: 'dark', stored: 'dark' })
  })

  it('no param falls back to the stored choice', () => {
    expect(runBoot('', 'light')).toEqual({ attr: 'light', stored: 'light' })
  })

  it('nothing stored and nothing in the url: the media query decides', () => {
    expect(runBoot('')).toEqual({ attr: undefined, stored: undefined })
  })

  it('junk in the param is ignored, not applied and not persisted', () => {
    expect(runBoot('?theme=hotpink')).toEqual({ attr: undefined, stored: undefined })
  })
})
