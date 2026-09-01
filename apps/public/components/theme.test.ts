import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  THEME_BOOT,
  applyTheme,
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
  function runBoot(search: string, pathname = '/', hash = '', stored?: string | null) {
    const store = new Map<string, string>()
    if (stored) store.set('bliprank-theme', stored)
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
