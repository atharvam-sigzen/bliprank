'use client'

import { useSyncExternalStore } from 'react'

/**
 * THE TWO GLOBAL DISPLAY CHOICES — theme and depth — live in this one file.
 *
 * They are the same mechanism twice: a value stamped on <html> before first
 * paint, stored per origin, mirrored across tabs, and carried over the deploy
 * boundary by a URL param that is spent on arrival. Writing depth as a second
 * module would have duplicated the boot script, the storage listener and the
 * param-stripping regex — three places for the same class of bug to reappear.
 *
 * THEME is a tri-state (light / dark / system). Everything about it lives here,
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
const DEPTH_KEY = 'bliprank-depth'

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

/**
 * One subscription for both choices. A depth change wakes the theme hook too,
 * which costs nothing: `useSyncExternalStore` compares the snapshot and skips
 * the render when the value has not moved.
 *
 * THE DEPTH BRANCH RE-STAMPS THE ATTRIBUTE, and the theme branch deliberately
 * does not. `useDepth` reads the live attribute rather than storage — it is
 * the value CSS is actually obeying, so the toggle can never disagree with the
 * page — which means another tab's write has to be applied here or this tab
 * would show a stale view under a fresh label. `readTheme` reads storage, so
 * the theme hook needs no such repair and none is added: changing what the
 * theme does across tabs is not this change's business.
 */
function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  // Another tab's toggle reaches this one: same store, same subscribers.
  const onStorage = (e: StorageEvent) => {
    if (e.key === DEPTH_KEY || e.key === null) {
      const d = readDepth()
      if (d) document.documentElement.setAttribute('data-depth', d)
    }
    if (e.key === KEY || e.key === DEPTH_KEY || e.key === null) fn()
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
 * A cross-origin URL carrying the reader's display choices. Pure on purpose:
 * callers pass `useTheme()`'s and `useDepth()`'s values so the href re-renders
 * when a choice changes — reading storage here instead is how a stale snapshot
 * overwrote a fresher choice. null (never chose) appends nothing.
 *
 * DEPTH TRAVELS TOO, and the third parameter is optional so no existing call
 * site had to change. The two apps are separate origins (ADR-0002), so
 * localStorage does not cross: without this, a reader who opened Full detail on
 * the dashboard and clicked through to the Grader would land back on the simple
 * view, which is precisely the silent loss of a choice this file exists to stop.
 */
export function themedUrl(url: string, choice: ThemeChoice | null, depth?: Depth | null): string {
  if (!choice && !depth) return url
  const hash = url.indexOf('#')
  const [base, fragment] = hash === -1 ? [url, ''] : [url.slice(0, hash), url.slice(hash)]
  const params = [choice ? `theme=${choice}` : '', depth ? `depth=${depth}` : ''].filter(Boolean).join('&')
  return `${base}${base.includes('?') ? '&' : '?'}${params}${fragment}`
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

/* ==========================================================================
   DEPTH — the dual-audience instrument
   ==========================================================================

   One dataset, two reading levels. `simple` is the plain-language default a
   brand owner lands on; `detailed` is the full record — intervals, precision
   grade, provenance, methodology — that an agency user and a sceptic want.

   IT IS A STRICT SUBSET, NOT A SECOND PRODUCT. Both depths render the same
   components from the same scan; the simple view shows fewer of them. Nothing
   exists in one view and not the other, and nothing is recomputed. A number
   that appears at both depths is the same number with the same interval.

   THREE THINGS THAT ARE NOT NEGOTIABLE, because they are what makes a simple
   view honest rather than merely shorter:

     1. The interval is NEVER dropped, only re-typeset. At depth `simple` it is
        rendered as language ("about 1 in 4, and it could be as few as 1 in 6")
        instead of as a figure and a rail. R8 holds at both depths — value,
        bounds, n and provenance are all still on the page, and a screen reader
        gets them in the same sentence a sighted reader does.
     2. `n` and the engine count stay visible at BOTH depths. A reader must
        never be able to screenshot a number without the size of the sample it
        came from.
     3. The control says "Full detail" in both states, so the depth that is not
        currently shown is always advertised. A simple view that hides the fact
        that a detailed one exists reads as a shallow product rather than as a
        considered default.

   ABSENT ATTRIBUTE MEANS DETAILED, and that is the fail-open direction. The
   boot script always stamps one, so the absent case is a reader with no
   JavaScript — and showing that reader everything is strictly better than
   hiding two thirds of the page behind a class they can never toggle. Every
   rule in the stylesheet is therefore written as `[data-depth='simple']`, never
   as its negation.
   ========================================================================== */

export type Depth = 'simple' | 'detailed'

/**
 * THE DEFAULT FOLLOWS THE ROLE, and the role is already in the route.
 *
 * `chrome.tsx` forks on surface: / and pricing are neutral, /dashboard is the
 * brand workspace, /agency is the agency workspace. An agency user is the
 * technical audience by definition — they are reading someone else's numbers
 * and have to defend them — so they land on the full record, and everyone else
 * lands on the plain one. No new mechanism, no role read from storage (which is
 * what makes chrome prerender the wrong bar), just the path the reader is on.
 *
 * A stored choice always wins over this. The route decides only the first view.
 */
export function defaultDepthFor(pathname: string): Depth {
  return pathname.startsWith('/agency') ? 'detailed' : 'simple'
}

/** The stored choice, or null when the reader has never chosen. */
export function readDepth(): Depth | null {
  try {
    const d = window.localStorage.getItem(DEPTH_KEY)
    return d === 'simple' || d === 'detailed' ? d : null
  } catch {
    return null
  }
}

function readEffectiveDepth(): Depth | null {
  try {
    const d = document.documentElement.getAttribute('data-depth')
    return d === 'simple' || d === 'detailed' ? d : null
  } catch {
    return null
  }
}

/**
 * The EFFECTIVE depth, read off the attribute rather than out of storage.
 *
 * That is the difference from `useTheme`, and it is deliberate. The attribute
 * is what CSS is obeying, and it already folds in the route default the boot
 * script resolved — so the toggle cannot get out of step with the page, and
 * nothing here has to re-derive `defaultDepthFor` or reach for `usePathname`.
 * Server snapshot is null: the prerender cannot read an attribute the boot
 * script has not written yet.
 */
export function useDepth(): Depth | null {
  return useSyncExternalStore(subscribe, readEffectiveDepth, () => null)
}

/** Write the choice everywhere it lives: attribute, store, subscribers. */
export function applyDepth(next: Depth): void {
  // Attribute first and outside the try, for the same reason applyTheme does
  // it: the control has to work in a window that cannot persist.
  document.documentElement.setAttribute('data-depth', next)
  try {
    window.localStorage.setItem(DEPTH_KEY, next)
  } catch {
    // The choice holds for this page and does not survive a reload.
  }
  for (const fn of listeners) fn()
}

/**
 * Stacked rules, and the number of them IS the metaphor: two for the plain
 * reading, four for the full record. Same 14px box, same 1.5px stroke and the
 * same `currentColor` discipline as the theme icons — for the reason written
 * above them, which applies to every icon on this bar.
 */
const DEPTH_ICON: Record<Depth, React.ReactNode> = {
  simple: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M4 9h16M4 15h9" />
    </svg>
  ),
  detailed: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M4 5h16M4 9.5h16M4 14h16M4 18.5h9" />
    </svg>
  ),
}

/**
 * A SWITCH, NOT A TRI-STATE AND NOT A DISCLOSURE.
 *
 * `role="switch"` is the exact semantic: one named thing, on or off. It also
 * settles the labelling problem the theme toggle solves the other way. That one
 * names its current STATE ("Dark") because a reader has to be able to tell what
 * the theme is; this one names the THING BEING SWITCHED ("Full detail") in both
 * states, with `aria-checked` carrying on/off. Labelling it by state would mean
 * the simple view showed a control reading "Simple" — which tells a reader
 * nothing about there being anything more, and makes a considered default look
 * like the whole product.
 *
 * Before hydration `useDepth()` is null and the switch renders unchecked with
 * its label. It corrects itself in the first client paint, exactly as the theme
 * toggle's label does; the VIEW never flashes, because the attribute was
 * stamped by the boot script before first paint.
 */
export function DepthToggle() {
  const depth = useDepth()
  const detailed = depth === 'detailed'

  return (
    <button
      type="button"
      role="switch"
      aria-checked={detailed}
      className="themetoggle depthtoggle"
      onClick={() => applyDepth(detailed ? 'simple' : 'detailed')}
    >
      {DEPTH_ICON[detailed ? 'detailed' : 'simple']}
      Full detail
    </button>
  )
}

/**
 * Applied before first paint, so a dark-mode reader never sees a white flash
 * and nobody watches the page shed two thirds of itself after hydration.
 * Inline and synchronous on purpose — a `useEffect` runs after paint, which is
 * exactly too late.
 *
 * A `?theme=` or `?depth=` param wins over the stored choice, is persisted, and
 * is then STRIPPED from the address bar: a param that lingered was replayed by
 * every reload and back-navigation, overwriting choices made after it was
 * minted. `system` is accepted and persisted like the other two theme values
 * but sets no attribute — the media query decides. The inner trys keep a
 * persist or rewrite failure from also losing the visible application.
 *
 * DEPTH IS ALWAYS STAMPED, theme only when explicit. Theme has a real "no
 * attribute" state meaning "let the media query decide"; depth does not — an
 * unstamped page is one whose CSS falls back to the full record, which is right
 * for a no-JS reader and wrong for one who chose the simple view. So the stored
 * value, else the route default, is written on every load.
 */
export const THEME_BOOT = `(function(){try{var q=location.search;var tm=q.match(/[?&]theme=(dark|light|system)\\b/);var dm=q.match(/[?&]depth=(simple|detailed)\\b/);var t=tm?tm[1]:localStorage.getItem('bliprank-theme');var d=dm?dm[1]:localStorage.getItem('bliprank-depth');if(tm){try{localStorage.setItem('bliprank-theme',tm[1])}catch(e){}}if(dm){try{localStorage.setItem('bliprank-depth',dm[1])}catch(e){}}if(tm||dm){try{var s=q.replace(/[?&]theme=(dark|light|system)\\b/,'').replace(/[?&]depth=(simple|detailed)\\b/,'').replace(/^&/,'?');history.replaceState(null,'',location.pathname+s+location.hash)}catch(e){}}if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}if(d!=='simple'&&d!=='detailed'){d=location.pathname.indexOf('/agency')===0?'detailed':'simple'}document.documentElement.setAttribute('data-depth',d)}catch(e){}})()`
