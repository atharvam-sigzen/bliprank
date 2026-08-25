'use client'

import { useEffect, useState } from 'react'
import { readActiveDomain, readAgencyDomains, readRole, writeRole, type Role } from '@/lib/workspace'

/**
 * Shared chrome: the product bar and the theme toggle.
 *
 * WHY THIS EXISTS. `apps/web` and `apps/public` are separate deploys, for
 * hosting reasons rather than product ones (ADR-0002): the Grader sits on
 * acquisition traffic nobody can forecast, so it goes to Cloudflare Pages where
 * static requests are free and unmetered, while the dashboard is low-volume and
 * latency-sensitive and goes to Vercel. That is an infrastructure fact, and a
 * reader should never have to infer it from two pages that look unrelated. One
 * bar, one mark, and each surface names the other.
 *
 * WHY TWO TIERS. The flat bar listed Dashboard, Grader, Pricing and Agency as
 * peers, which made it role-blind: it could not say who you are or which domain
 * is on screen, so a brand director and an agency operator saw the same four
 * words and had to work out for themselves which two were theirs. Tier one is
 * identity — who, in what mode, looking at what. Tier two is the product for
 * that mode. The role switch is a real mode change and navigates, because a
 * control that only relabels the page is a lie about what it did.
 */

export type Surface = 'dashboard' | 'grader' | 'pricing' | 'agency'

/** Absolute in dev so the cross-link works across two ports; env-overridable. */
const WORKED_EXAMPLE = process.env['NEXT_PUBLIC_DASHBOARD_URL'] ?? 'http://localhost:3000'

/** Where a role lives. Relative: every one of these ships in this app. */
const HOME: Record<Role, string> = { brand: '/dashboard', agency: '/agency' }

type Link = { readonly href: string; readonly label: string; readonly on?: Surface }

/*
 * EVERY HASH HERE HAS TO LAND ON SOMETHING, IN EVERY STATE OF ITS PAGE.
 *
 * `#prompts` and `#settings` were written against sections that do not exist —
 * a link that scrolls nowhere is a page claiming a surface it has not built,
 * which on this product is the same class of defect as a figure with nothing
 * behind it. `#settings` now points at the workspace record, which every
 * dashboard state carries and which is re-scrolled once the state that owns it
 * has mounted; the agency equivalent is the pool,
 * which is the only portfolio-wide setting there is. A "Prompts" entry is gone
 * rather than aimed at a list that only the pre-flight state draws.
 */
const NAV: Record<Role, readonly Link[]> = {
  brand: [
    { href: '/dashboard', label: 'Overview', on: 'dashboard' },
    { href: '/dashboard#settings', label: 'Workspace' },
  ],
  agency: [
    { href: '/agency', label: 'Portfolio', on: 'agency' },
    { href: '/agency/add', label: 'Add client' },
    { href: '/agency#pool-heading', label: 'Prompt pool' },
  ],
}

/**
 * The surface you are on IS a statement of mode: /dashboard is a brand
 * workspace and /agency is a portfolio. Without this the stored role wins, so
 * arriving at /agency from anywhere that did not set it — the worked-example
 * app links straight at both — draws the brand half of the bar over a
 * portfolio, with the role switch reporting the mode you are not in. The
 * choice is written back so the rest of the session agrees with the page.
 */
const IMPLIED: Partial<Record<Surface, Role>> = { dashboard: 'brand', agency: 'agency' }

function NavLink({ link, current }: { link: Link; current: Surface }) {
  const on = link.on === current
  return (
    <a className={`navbar__link${on ? ' navbar__link--on' : ''}`} href={link.href} {...(on ? { 'aria-current': 'page' as const } : {})}>
      {link.label}
    </a>
  )
}

export function ProductBar({ current }: { current: Surface }) {
  // AT RENDER, NOT IN THE EFFECT. `IMPLIED[current]` depends only on the prop,
  // so it is identical on the server and on the first client render and cannot
  // cause a mismatch — while deferring it shipped the brand nav and a pressed
  // "Brand" switch over /agency in the prerendered HTML, permanently so with JS
  // off or to a crawler, and sent anyone clicking during that frame to
  // /dashboard from the portfolio.
  const [role, setRole] = useState<Role>(() => IMPLIED[current] ?? 'brand')
  const [context, setContext] = useState('')
  // The server has no storage, so the first client render must match the server
  // exactly and the stored role arrives one paint later. `context` starts empty
  // rather than at "no workspace" so the bar never states something false about
  // the reader's own account, however briefly.
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const implied = IMPLIED[current]
    const actual = implied ?? readRole()
    setRole(actual)
    setContext(describe(actual))
    if (implied) writeRole(implied)
    setMounted(true)
  }, [current])

  function switchTo(next: Role) {
    setRole(next)
    setContext(describe(next))
    writeRole(next)
    // A mode change goes to that mode's home. Full navigation, not a router
    // push: the destination reads the role back out of storage on load.
    window.location.href = HOME[next]
  }

  return (
    <nav className="navbar" aria-label="BlipRank">
      <div className="navbar__identity">
        <span className="navbar__mark">
          <span className="navbar__dot" aria-hidden="true" />
          BlipRank
        </span>
        <div className="navbar__role" role="group" aria-label="Workspace role">
          {(['brand', 'agency'] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={`navbar__rolebtn${role === r ? ' navbar__rolebtn--on' : ''}`}
              // aria-pressed, not aria-current: these are two states of one
              // control, and only one of them is ever true.
              aria-pressed={role === r}
              onClick={() => switchTo(r)}
            >
              {r === 'brand' ? 'Brand' : 'Agency'}
            </button>
          ))}
        </div>
        <span className="navbar__active">{mounted ? context : ''}</span>
        <ThemeToggle />
      </div>

      <div className="navbar__nav">
        {NAV[role].map((link) => (
          <NavLink key={link.href} link={link} current={current} />
        ))}
        <div className="navbar__util">
          <NavLink link={{ href: '/', label: 'Grader', on: 'grader' }} current={current} />
          <NavLink link={{ href: '/pricing', label: 'Pricing', on: 'pricing' }} current={current} />
          {/*
            Plain anchor and an absolute URL: this one crosses an origin in dev
            (3001 to 3000) and a host in production (Cloudflare Pages to Vercel),
            and next/link's client navigation cannot do either. It is no longer
            called "Dashboard" — that name belongs to the brand dashboard above,
            and this is a worked example on committed data.
          */}
          <a className="navbar__link" href={WORKED_EXAMPLE}>
            Worked example
          </a>
        </div>
      </div>
    </nav>
  )
}

/** What the reader is looking at, in the words of whichever role they are in. */
function describe(role: Role): string {
  if (role === 'agency') {
    const n = readAgencyDomains().length
    return `${n} ${n === 1 ? 'client' : 'clients'}`
  }
  return readActiveDomain() ?? 'no workspace'
}

type Choice = 'light' | 'dark' | 'system'
const NEXT: Record<Choice, Choice> = { system: 'light', light: 'dark', dark: 'system' }
const LABEL: Record<Choice, string> = { system: 'System', light: 'Light', dark: 'Dark' }
/**
 * Inline SVG, not `☀`/`☾`/`◐`.
 *
 * Those are Unicode symbols pressed into service as icons, and they render at
 * whatever size, weight and colour the platform's emoji or symbol font decides —
 * on some Windows builds `☀` arrives as a full-colour emoji. An icon in a
 * control has to inherit `currentColor` and the surrounding type size, which
 * only a real vector does. 1.5px strokes to match the interface weight.
 */
const ICON: Record<Choice, React.ReactNode> = {
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
 * dark-mode machine", and that is the one a reader notices. `system` removes the
 * attribute entirely so the media query decides again.
 */
export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>('system')

  useEffect(() => {
    // A private window throws on the `localStorage` property itself, not on the
    // call — and this control is on every page in the app, so an unguarded read
    // here is a white screen everywhere rather than a lost preference. Same
    // reasoning as `readRaw` in lib/workspace.ts, and the same as THEME_BOOT
    // below, which has always had its try.
    try {
      const stored = window.localStorage.getItem('bliprank-theme')
      if (stored === 'light' || stored === 'dark') setChoice(stored)
    } catch {
      // Nothing stored that we are allowed to see; the media query decides.
    }
  }, [])

  function apply(next: Choice) {
    setChoice(next)
    const root = document.documentElement
    // The attribute is what actually changes the theme, so it is set first and
    // outside the try: the toggle must work in a window that cannot persist.
    if (next === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', next)
    try {
      if (next === 'system') window.localStorage.removeItem('bliprank-theme')
      else window.localStorage.setItem('bliprank-theme', next)
    } catch {
      // The choice holds for this page and does not survive a reload.
    }
  }

  return (
    <button
      type="button"
      className="themetoggle"
      onClick={() => apply(NEXT[choice])}
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
 */
export const THEME_BOOT = `(function(){try{var t=localStorage.getItem('bliprank-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})()`
