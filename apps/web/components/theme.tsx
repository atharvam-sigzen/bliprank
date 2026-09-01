'use client'

import { useSyncExternalStore } from 'react'

/**
 * THE THEME IS ONE GLOBAL TRI-STATE. Everything about it lives in this file,
 * and this file is byte-identical in apps/public and apps/web — pinned by
 * theme.test.ts the way planned.tsx is pinned, because the two apps cannot
 * share an import across their deploy boundary (ADR-0002). Edit both copies or
 * the test fails the build. Upgrade path: a shared package when a third
 * consumer appears.
 *
 * WHY THIS FILE EXISTS. The first implementation scattered the theme across
 * two drifted copies of three pieces — a toggle holding component state, a
 * boot script, and href helpers that snapshotted storage at render time. That
 * produced a reproducible loss of the reader's choice: choose Dark on one
 * origin, cross to the other, choose System there, come back — and the return
 * link, themed when the bar last rendered, still carried `?theme=dark`, which
 * the boot script then treated as authoritative and wrote back over the fresh
 * choice. The reader chose System and got Dark, with the toggle agreeing to
 * the wrong answer.
 *
 * Three rules close that class:
 *
 *   1. `system` IS A CHOICE AND IS STORED AS ONE. Removing the key cannot
 *      cross an origin, so "back to the OS default" could never propagate and
 *      any stale explicit value resurrected. Absent key = never chose.
 *   2. HREFS FOLLOW THE STORE. `useTheme()` subscribes; anything that themes
 *      a URL derives it from the hook's value, so a toggle re-renders every
 *      themed link in the same paint. No snapshot can go stale.
 *   3. THE PARAM IS SPENT ON ARRIVAL. The boot script persists a `?theme=`
 *      param and then strips it from the address bar, so a reload, a
 *      bookmark or a back-navigation cannot replay an old choice.
 */

export type ThemeChoice = 'light' | 'dark' | 'system'

const KEY = 'bliprank-theme'

/** The stored choice, or null when the reader has never chosen. */
export function readTheme(): ThemeChoice | null {
  // A private window throws on the `localStorage` property itself, not on the
  // call, and on the server there is no window at all — both land in the catch.
  try {
    const t = window.localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' || t === 'system' ? t : null
  } catch {
    return null
  }
}

const listeners = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  // Another tab's toggle reaches this one: same store, same subscribers.
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) fn()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(fn)
    window.removeEventListener('storage', onStorage)
  }
}

/**
 * The choice as live state. Server snapshot is null — the prerender must not
 * guess a choice it cannot read — so themed hrefs and the toggle label render
 * neutral once and correct themselves in the first client paint after
 * hydration. The visible THEME never flashes: the boot script set the
 * attribute before first paint; this hook only governs labels and hrefs.
 */
export function useTheme(): ThemeChoice | null {
  return useSyncExternalStore(subscribe, readTheme, () => null)
}

/** Write the choice everywhere it lives: attribute, store, subscribers. */
export function applyTheme(next: ThemeChoice): void {
  const root = document.documentElement
  // The attribute is what actually changes the theme, so it is set first and
  // outside the try: the toggle must work in a window that cannot persist.
  if (next === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', next)
  try {
    window.localStorage.setItem(KEY, next)
  } catch {
    // The choice holds for this page and does not survive a reload.
  }
  for (const fn of listeners) fn()
}

/**
 * A cross-origin URL carrying the given choice. Pure on purpose: callers pass
 * `useTheme()`'s value so the href re-renders when the choice changes —
 * reading storage here instead is how a stale snapshot overwrote a fresher
 * choice. null (never chose) appends nothing.
 */
export function themedUrl(url: string, choice: ThemeChoice | null): string {
  if (!choice) return url
  const hash = url.indexOf('#')
  const [base, fragment] = hash === -1 ? [url, ''] : [url.slice(0, hash), url.slice(hash)]
  return `${base}${base.includes('?') ? '&' : '?'}theme=${choice}${fragment}`
}

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' }
const LABEL: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' }

/**
 * Inline SVG, not `☀`/`☾`/`◐`.
 *
 * Those are Unicode symbols pressed into service as icons, and they render at
 * whatever size, weight and colour the platform's emoji or symbol font decides —
 * on some Windows builds `☀` arrives as a full-colour emoji. An icon in a
 * control has to inherit `currentColor` and the surrounding type size, which
 * only a real vector does. 1.5px strokes to match the interface weight.
 */
const ICON: Record<ThemeChoice, React.ReactNode> = {
  system: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none" />
    </svg>
  ),
  light: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
    </svg>
  ),
  dark: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z" />
    </svg>
  ),
}

/**
 * Three states, not two. A binary toggle cannot express "I chose light on a
 * dark-mode machine", and that is the one a reader notices.
 *
 * The label comes from the same store every themed href reads, so the toggle
 * can never say Dark over a link about to carry light — they re-render off
 * one subscription or not at all.
 */
export function ThemeToggle() {
  const choice = useTheme() ?? 'system'

  return (
    <button
      type="button"
      className="themetoggle"
      onClick={() => applyTheme(NEXT[choice])}
      // The label carries the current state, not the next one: a control that
      // announces its own action rather than its value leaves a screen-reader
      // user unable to tell what the theme currently is.
      aria-label={`Theme: ${LABEL[choice]}. Activate for ${LABEL[NEXT[choice]]}.`}
    >
      {ICON[choice]}
      {LABEL[choice]}
    </button>
  )
}

/**
 * Applied before first paint, so a dark-mode reader never sees a white flash.
 * Inline and synchronous on purpose — a `useEffect` runs after paint, which is
 * exactly too late.
 *
 * A `?theme=` param wins over the stored choice, is persisted, and is then
 * STRIPPED from the address bar: a param that lingered was replayed by every
 * reload and back-navigation, overwriting choices made after it was minted.
 * `system` is accepted and persisted like the other two but sets no attribute —
 * the media query decides. The inner trys keep a persist or rewrite failure
 * from also losing the visible application of the theme.
 */
export const THEME_BOOT = `(function(){try{var m=location.search.match(/[?&]theme=(dark|light|system)\\b/);var t=m?m[1]:localStorage.getItem('bliprank-theme');if(m){try{localStorage.setItem('bliprank-theme',t)}catch(e){}try{var s=location.search.replace(/[?&]theme=(dark|light|system)\\b/,'').replace(/^&/,'?');history.replaceState(null,'',location.pathname+s+location.hash)}catch(e){}}if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})()`
