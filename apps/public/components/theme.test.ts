import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  THEME_BOOT,
  applyDepth,
  applyTheme,
  defaultDepthFor,
  readDepth,
  readTheme,
  themedUrl,
  type ThemeChoice,
} from './theme'

const publicSrc = readFileSync(new URL('./theme.tsx', import.meta.url), 'utf8')
const webSrc = readFileSync(new URL('../../web/components/theme.tsx', import.meta.url), 'utf8')

describe('Theme single source of truth across deploy boundary', () => {
  it('apps/public and apps/web theme.tsx files are byte-identical', () => {
    expect(publicSrc).toBe(webSrc)
  })
})

describe('every component duplicated across the boundary is pinned', () => {
  /*
   * ⚠️ THE DRIFT THIS EXISTS TO STOP ALREADY HAPPENED, AND SHIPPED.
   *
   * ADR-0002 puts the two apps on separate deploys, so a shared component is a
   * copy rather than an import, and only theme.tsx was ever pinned. range-rail
   * drifted: apps/public fixed its bounds row — each bound printed under the
   * band edge it describes, because on a fixed 0-100 track a bound sitting at
   * the corner reads as the SCALE'S endpoint, a mislabelled axis rather than a
   * measurement — and the fix never crossed. apps/web kept drawing the old row
   * on all three metric cards of the paid product for as long as both existed.
   *
   * Nothing caught it because nothing looked. A copy with no pin is a copy that
   * will differ; the only question is when somebody notices.
   */
  const PINNED = ['theme.tsx', 'headline.tsx', 'range-rail.tsx']

  /**
   * Same basename on both sides, DIFFERENT ON PURPOSE — so the rule below
   * forces a decision rather than forcing identity.
   *
   * `chrome.tsx` is the only one: apps/public carries three chromes (neutral,
   * brand, agency) and a workspace switcher because it owns the role fork,
   * while apps/web is one bar with a static slot and nothing to switch between.
   * Making those byte-identical would mean shipping the agency navigation to a
   * deploy that has no agency routes.
   */
  const INTENTIONALLY_DIFFERENT = ['chrome.tsx']

  it.each(PINNED)('%s is byte-identical in apps/public and apps/web', (file) => {
    const a = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    const b = readFileSync(new URL(`../../web/components/${file}`, import.meta.url), 'utf8')
    expect(a).toBe(b)
  })

  it('the pinned list is not stale — every named file exists on both sides', () => {
    for (const file of PINNED) {
      expect([file, existsSync(new URL(`./${file}`, import.meta.url))]).toEqual([file, true])
      expect([file, existsSync(new URL(`../../web/components/${file}`, import.meta.url))]).toEqual([file, true])
    }
  })

  it('THE CHECK BITES: a component in both trees and on NEITHER list is flagged', () => {
    /*
     * The lists are the thing that rots — someone adds a fourth shared component
     * and does not think to classify it, which is exactly how range-rail
     * drifted for as long as it did. So they are derived-checked rather than
     * trusted: every basename present in BOTH components/ directories must be
     * declared either pinned or deliberately divergent. Neither is a default.
     */
    const inBoth = readdirSync(new URL('.', import.meta.url))
      .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
      .filter((f) => existsSync(new URL(`../../web/components/${f}`, import.meta.url)))
    expect([...inBoth].sort()).toEqual([...PINNED, ...INTENTIONALLY_DIFFERENT].sort())
  })

  it('and a file declared divergent really does diverge', () => {
    // Otherwise the escape hatch becomes the place things go to stop being
    // checked: a file that is actually identical belongs on PINNED.
    for (const file of INTENTIONALLY_DIFFERENT) {
      const a = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      const b = readFileSync(new URL(`../../web/components/${file}`, import.meta.url), 'utf8')
      expect([file, a === b]).toEqual([file, false])
    }
  })
})

describe('readTheme', () => {
  const ORIGINAL = Object.getOwnPropertyDescriptor(globalThis, 'window')

  afterEach(() => {
    if (ORIGINAL) Object.defineProperty(globalThis, 'window', ORIGINAL)
    else delete (globalThis as { window?: unknown }).window
  })

  it('returns null on the server (no window)', () => {
    delete (globalThis as { window?: unknown }).window
    expect(readTheme()).toBeNull()
  })

  it('returns valid choices from localStorage', () => {
    for (const choice of ['light', 'dark', 'system'] as const) {
      Object.defineProperty(globalThis, 'window', {
        value: { localStorage: { getItem: () => choice } },
        configurable: true,
        writable: true,
      })
      expect(readTheme()).toBe(choice)
    }
  })

  it('returns null for invalid strings or missing key', () => {
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: { getItem: () => 'neon-pink' } },
      configurable: true,
      writable: true,
    })
    expect(readTheme()).toBeNull()

    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: { getItem: () => null } },
      configurable: true,
      writable: true,
    })
    expect(readTheme()).toBeNull()
  })

  it('returns null when localStorage access throws (private window)', () => {
    Object.defineProperty(globalThis, 'window', {
      get() {
        throw new Error('Access denied')
      },
      configurable: true,
    })
    expect(readTheme()).toBeNull()
  })
})

describe('applyTheme', () => {
  let attrs: Map<string, string>
  let storage: Map<string, string>

  beforeEach(() => {
    attrs = new Map()
    storage = new Map()
    const doc = {
      documentElement: {
        setAttribute: (k: string, v: string) => void attrs.set(k, v),
        removeAttribute: (k: string) => void attrs.delete(k),
      },
    }
    const win = {
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
      },
    }
    Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true })
    Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true })
  })

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document
    delete (globalThis as { window?: unknown }).window
  })

  it('applies dark theme by setting attribute and saving to storage', () => {
    applyTheme('dark')
    expect(attrs.get('data-theme')).toBe('dark')
    expect(storage.get('bliprank-theme')).toBe('dark')
  })

  it('applies light theme by setting attribute and saving to storage', () => {
    applyTheme('light')
    expect(attrs.get('data-theme')).toBe('light')
    expect(storage.get('bliprank-theme')).toBe('light')
  })

  it('applies system theme by removing attribute and saving system to storage', () => {
    applyTheme('dark')
    expect(attrs.get('data-theme')).toBe('dark')

    applyTheme('system')
    expect(attrs.has('data-theme')).toBe(false)
    expect(storage.get('bliprank-theme')).toBe('system')
  })
})

describe('themedUrl', () => {
  it('returns url unchanged when choice is null (never chose)', () => {
    expect(themedUrl('http://localhost:3000', null)).toBe('http://localhost:3000')
    expect(themedUrl('http://localhost:3000/?foo=bar', null)).toBe('http://localhost:3000/?foo=bar')
  })

  it('appends theme choice to url with ? or & as appropriate', () => {
    expect(themedUrl('http://localhost:3000', 'dark')).toBe('http://localhost:3000?theme=dark')
    expect(themedUrl('http://localhost:3000/', 'light')).toBe('http://localhost:3000/?theme=light')
    expect(themedUrl('http://localhost:3000/?x=1', 'system')).toBe('http://localhost:3000/?x=1&theme=system')
  })

  it('preserves hash fragments after the query param', () => {
    expect(themedUrl('http://localhost:3000/#section', 'dark')).toBe('http://localhost:3000/?theme=dark#section')
    expect(themedUrl('http://localhost:3000/?x=1#section', 'light')).toBe('http://localhost:3000/?x=1&theme=light#section')
  })
})

describe('THEME_BOOT execution', () => {
  function runBoot(search: string, pathname = '/', hash = '', stored?: string | null, storedDepth?: string | null) {
    const store = new Map<string, string>()
    if (stored) store.set('bliprank-theme', stored)
    if (storedDepth) store.set('bliprank-depth', storedDepth)
    const attrs = new Map<string, string>()
    let replacedUrl: string | null = null

    const g = globalThis as Record<string, unknown>
    g.location = { search, pathname, hash }
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    g.history = {
      replaceState: (_data: unknown, _title: string, url: string) => {
        replacedUrl = url
      },
    }
    g.document = {
      documentElement: {
        setAttribute: (k: string, v: string) => void attrs.set(k, v),
        removeAttribute: (k: string) => void attrs.delete(k),
      },
    }

    try {
      ;(0, eval)(THEME_BOOT)
    } finally {
      delete g.location
      delete g.localStorage
      delete g.history
      delete g.document
    }

    return {
      attr: attrs.get('data-theme'),
      stored: store.get('bliprank-theme'),
      depthAttr: attrs.get('data-depth'),
      storedDepth: store.get('bliprank-depth'),
      replacedUrl,
    }
  }

  it('reads theme from param, applies attribute, persists, and strips param from address bar', () => {
    const res = runBoot('?theme=dark', '/dashboard', '#view')
    expect(res.attr).toBe('dark')
    expect(res.stored).toBe('dark')
    expect(res.replacedUrl).toBe('/dashboard#view')
  })

  it('handles ?theme=system by persisting system, leaving attribute unset, and stripping param', () => {
    const res = runBoot('?theme=system', '/', '', 'dark')
    expect(res.attr).toBeUndefined()
    expect(res.stored).toBe('system')
    expect(res.replacedUrl).toBe('/')
  })

  it('falls back to stored choice when no url param is present', () => {
    const res = runBoot('', '/', '', 'light')
    expect(res.attr).toBe('light')
    expect(res.stored).toBe('light')
    expect(res.replacedUrl).toBeNull()
  })

  it('leaves media query in charge when nothing is stored and no param is present', () => {
    const res = runBoot('', '/', '', null)
    expect(res.attr).toBeUndefined()
    expect(res.stored).toBeUndefined()
    expect(res.replacedUrl).toBeNull()
  })
})

/* ==========================================================================
   DEPTH — the dual-audience instrument
   ========================================================================== */

describe('defaultDepthFor — the role default lives in the route, not in storage', () => {
  it('an agency surface opens on the full record', () => {
    // The agency user is the technical audience by definition: they are reading
    // someone else's numbers and have to defend them.
    for (const p of ['/agency', '/agency/', '/agency/add', '/agency/client/acme.com', '/agency/pricing']) {
      expect([p, defaultDepthFor(p)]).toEqual([p, 'detailed'])
    }
  })

  it('every other surface opens on the plain reading', () => {
    for (const p of ['/', '/pricing', '/dashboard', '/dashboard/prompts', '/dashboard/workspace']) {
      expect([p, defaultDepthFor(p)]).toEqual([p, 'simple'])
    }
  })

  it('THE FINDING: a path merely CONTAINING /agency is not an agency surface', () => {
    // startsWith, not includes. A domain named in a route segment must never
    // decide the reading level for the whole page.
    expect(defaultDepthFor('/dashboard/client/myagency.com')).toBe('simple')
  })
})

describe('readDepth', () => {
  const ORIGINAL = Object.getOwnPropertyDescriptor(globalThis, 'window')

  afterEach(() => {
    if (ORIGINAL) Object.defineProperty(globalThis, 'window', ORIGINAL)
    else delete (globalThis as { window?: unknown }).window
  })

  const withStorage = (getItem: () => string | null) =>
    Object.defineProperty(globalThis, 'window', { value: { localStorage: { getItem } }, configurable: true, writable: true })

  it('returns null on the server (no window)', () => {
    delete (globalThis as { window?: unknown }).window
    expect(readDepth()).toBeNull()
  })

  it('returns valid choices from localStorage', () => {
    for (const d of ['simple', 'detailed'] as const) {
      withStorage(() => d)
      expect(readDepth()).toBe(d)
    }
  })

  it('returns null for an invalid string or a missing key', () => {
    withStorage(() => 'expert-mode')
    expect(readDepth()).toBeNull()
    withStorage(() => null)
    expect(readDepth()).toBeNull()
  })

  it('returns null when localStorage access throws (private window)', () => {
    Object.defineProperty(globalThis, 'window', {
      get() {
        throw new Error('blocked')
      },
      configurable: true,
    })
    expect(readDepth()).toBeNull()
  })
})

describe('applyDepth', () => {
  let attrs: Map<string, string>
  let storage: Map<string, string>

  beforeEach(() => {
    attrs = new Map()
    storage = new Map()
    Object.defineProperty(globalThis, 'document', {
      value: { documentElement: { setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k) } },
      configurable: true,
      writable: true,
    })
    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage: {
          getItem: (k: string) => storage.get(k) ?? null,
          setItem: (k: string, v: string) => void storage.set(k, v),
          removeItem: (k: string) => void storage.delete(k),
        },
      },
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document
    delete (globalThis as { window?: unknown }).window
  })

  it('writes both depths to the attribute and to storage', () => {
    applyDepth('detailed')
    expect(attrs.get('data-depth')).toBe('detailed')
    expect(storage.get('bliprank-depth')).toBe('detailed')

    applyDepth('simple')
    expect(attrs.get('data-depth')).toBe('simple')
    expect(storage.get('bliprank-depth')).toBe('simple')
  })

  it('NEVER removes the attribute — unlike the theme, depth has no third state', () => {
    // An absent data-depth means "full record" to the stylesheet, which is the
    // right fallback for a reader with no JavaScript and the wrong one for a
    // reader who just chose the simple view.
    applyDepth('simple')
    expect(attrs.has('data-depth')).toBe(true)
  })

  it('still applies the attribute when storage refuses (private window)', () => {
    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage: {
          getItem: () => null,
          setItem: () => {
            throw new Error('quota')
          },
        },
      },
      configurable: true,
      writable: true,
    })
    applyDepth('detailed')
    expect(attrs.get('data-depth')).toBe('detailed')
  })
})

describe('themedUrl carries depth across the deploy boundary', () => {
  it('appends depth alone, theme alone, and both in a stable order', () => {
    expect(themedUrl('https://x.test', null, 'detailed')).toBe('https://x.test?depth=detailed')
    expect(themedUrl('https://x.test', 'dark')).toBe('https://x.test?theme=dark')
    expect(themedUrl('https://x.test', 'dark', 'detailed')).toBe('https://x.test?theme=dark&depth=detailed')
  })

  it('respects an existing query string and preserves the fragment', () => {
    expect(themedUrl('https://x.test/?a=1', 'light', 'simple')).toBe('https://x.test/?a=1&theme=light&depth=simple')
    expect(themedUrl('https://x.test/#s', null, 'detailed')).toBe('https://x.test/?depth=detailed#s')
    expect(themedUrl('https://x.test/?a=1#s', 'dark', 'simple')).toBe('https://x.test/?a=1&theme=dark&depth=simple#s')
  })

  it('is unchanged when the reader has chosen neither', () => {
    expect(themedUrl('https://x.test/?a=1', null)).toBe('https://x.test/?a=1')
    expect(themedUrl('https://x.test/?a=1', null, null)).toBe('https://x.test/?a=1')
  })
})

describe('THEME_BOOT resolves depth before first paint', () => {
  function runBoot(search: string, pathname = '/', hash = '', stored?: string | null, storedDepth?: string | null) {
    const store = new Map<string, string>()
    if (stored) store.set('bliprank-theme', stored)
    if (storedDepth) store.set('bliprank-depth', storedDepth)
    const attrs = new Map<string, string>()
    let replacedUrl: string | null = null

    const g = globalThis as Record<string, unknown>
    g.location = { search, pathname, hash }
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    g.history = {
      replaceState: (_d: unknown, _t: string, url: string) => {
        replacedUrl = url
      },
    }
    g.document = {
      documentElement: {
        setAttribute: (k: string, v: string) => void attrs.set(k, v),
        removeAttribute: (k: string) => void attrs.delete(k),
      },
    }
    try {
      ;(0, eval)(THEME_BOOT)
    } finally {
      delete g.location
      delete g.localStorage
      delete g.history
      delete g.document
    }
    return { attr: attrs.get('data-theme'), depthAttr: attrs.get('data-depth'), storedDepth: store.get('bliprank-depth'), replacedUrl }
  }

  it('THE GUARANTEE: data-depth is stamped on every load, whatever the inputs', () => {
    // The stylesheet reads [data-depth='simple'] and nothing else, so an
    // unstamped page silently becomes the full record. That is the correct
    // no-JS fallback and an unacceptable outcome for a reader who chose simple.
    for (const args of [
      ['', '/'],
      ['', '/agency'],
      ['?theme=dark', '/dashboard'],
      ['?depth=simple', '/agency'],
      ['?x=1', '/pricing'],
    ] as const) {
      const res = runBoot(args[0], args[1])
      expect([args, res.depthAttr]).toEqual([args, expect.stringMatching(/^(simple|detailed)$/)])
    }
  })

  it('falls back to the route default when nothing is stored', () => {
    expect(runBoot('', '/').depthAttr).toBe('simple')
    expect(runBoot('', '/dashboard').depthAttr).toBe('simple')
    expect(runBoot('', '/agency').depthAttr).toBe('detailed')
    expect(runBoot('', '/agency/client/acme.com').depthAttr).toBe('detailed')
  })

  it('a stored choice beats the route default, in both directions', () => {
    // The route decides the FIRST view only. An agency user who wants the plain
    // reading keeps it, and a brand owner who opened the record keeps that.
    expect(runBoot('', '/agency', '', null, 'simple').depthAttr).toBe('simple')
    expect(runBoot('', '/dashboard', '', null, 'detailed').depthAttr).toBe('detailed')
  })

  it('an invalid stored value falls back to the route default rather than being stamped', () => {
    expect(runBoot('', '/agency', '', null, 'expert').depthAttr).toBe('detailed')
    expect(runBoot('', '/', '', null, 'expert').depthAttr).toBe('simple')
  })

  it('?depth= wins over both, is persisted, and is stripped from the address bar', () => {
    const res = runBoot('?depth=detailed', '/dashboard', '#top', null, 'simple')
    expect(res.depthAttr).toBe('detailed')
    expect(res.storedDepth).toBe('detailed')
    expect(res.replacedUrl).toBe('/dashboard#top')
  })

  it('THE CROSS-ORIGIN CASE: both params arrive together and both are spent', () => {
    // This is the shape of a click from the dashboard bar to the Grader, which
    // is a different origin and therefore a different localStorage.
    const res = runBoot('?theme=dark&depth=detailed', '/', '')
    expect(res.attr).toBe('dark')
    expect(res.depthAttr).toBe('detailed')
    expect(res.storedDepth).toBe('detailed')
    expect(res.replacedUrl).toBe('/')
  })

  it('strips only its own params and leaves the rest of the query intact', () => {
    expect(runBoot('?a=1&theme=dark&depth=simple&b=2', '/x').replacedUrl).toBe('/x?a=1&b=2')
    expect(runBoot('?depth=simple&a=1', '/x').replacedUrl).toBe('/x?a=1')
    expect(runBoot('?a=1&depth=detailed', '/x').replacedUrl).toBe('/x?a=1')
  })

  it('leaves the address bar alone when neither param is present', () => {
    expect(runBoot('?a=1', '/x').replacedUrl).toBeNull()
  })

  it('junk in the param is ignored, not applied and not persisted', () => {
    /*
     * THE WORD BOUNDARY IS LOAD-BEARING, and it is the kind of thing that
     * silently stops being one. `\b` written into a template literal needs the
     * doubled backslash to survive into the emitted string; a single one makes
     * it the backspace character U+0008, the regex matches a prefix, and
     * `?depth=simplex` starts persisting `simple`. That exact slip was found
     * elsewhere in this repo, so it is asserted here rather than assumed.
     */
    for (const q of ['?depth=simplex', '?depth=detailedly', '?depth=expert', '?theme=darkness']) {
      const res = runBoot(q, '/x')
      expect([q, res.storedDepth]).toEqual([q, undefined])
      expect([q, res.attr]).toEqual([q, undefined])
      // Nothing matched, so nothing is spent and the address bar is untouched.
      expect([q, res.replacedUrl]).toEqual([q, null])
      // The route default still applies, so the page is never left unstamped.
      expect([q, res.depthAttr]).toEqual([q, 'simple'])
    }
  })

  it('and the valid params really do persist, so the rule above is not vacuous', () => {
    expect(runBoot('?depth=simple', '/agency').storedDepth).toBe('simple')
    expect(runBoot('?depth=detailed', '/').storedDepth).toBe('detailed')
  })

  it('THE DRIFT GUARD: the boot script and defaultDepthFor agree on every path', () => {
    /*
     * The route rule is stated twice and it has to be: once as a readable,
     * exported function, and once inlined into a minified string that runs
     * before React exists and cannot import anything. Two statements of one
     * rule is how they drift — someone adds an agency sub-route to the function
     * and the boot script keeps stamping the old answer, which nothing would
     * catch because the boot is only ever exercised through its own tests.
     *
     * So they are compared against each other rather than each against a
     * hardcoded expectation. Add a path here and both must satisfy it.
     */
    const PATHS = [
      '/',
      '/pricing',
      '/dashboard',
      '/dashboard/prompts',
      '/dashboard/workspace',
      '/dashboard/client/myagency.com',
      '/agency',
      '/agency/',
      '/agency/add',
      '/agency/pricing',
      '/agency/lifecycle',
      '/agency/client/acme.com',
    ]
    for (const p of PATHS) {
      expect([p, runBoot('', p).depthAttr]).toEqual([p, defaultDepthFor(p)])
    }
  })
})
