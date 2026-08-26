'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { normaliseTyped, scans } from '@/lib/scan-result'
import { readActiveDomain, readAgencyDomains, writeActiveDomain, writeRole } from '@/lib/workspace'

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
 * THE ROUTE DECIDES THE CHROME. There are three chromes and the surface picks
 * one: / and both pricing pages are NEUTRAL (the fork lives there as two
 * labelled doors), /dashboard is BRAND, /agency is AGENCY. The stored role is
 * never read here — a bar whose contents depend on storage ships the wrong
 * links in the prerender and swaps them after mount, which is exactly the
 * flash-of-wrong-workspace this structure removes. Entering a door WRITES the
 * role, so the Grader handoff and the dashboard keep working; leaving a role
 * goes back through the mark, and that one click of friction is deliberate.
 */

export type Surface = 'dashboard' | 'grader' | 'pricing' | 'agency'

type Chrome = 'neutral' | 'brand' | 'agency'

/** The whole architecture in one line: surface in, chrome out. Never storage. */
const CHROME: Record<Surface, Chrome> = {
  grader: 'neutral',
  pricing: 'neutral',
  dashboard: 'brand',
  agency: 'agency',
}

type Link = { readonly href: string; readonly label: string; readonly on?: Surface }

function NavLink({ link, current }: { link: Link; current: Surface }) {
  const on = link.on === current
  return (
    <a className={`navbar__link${on ? ' navbar__link--on' : ''}`} href={link.href} {...(on ? { 'aria-current': 'page' as const } : {})}>
      {link.label}
    </a>
  )
}

/** The mark is the way OUT of a role: one click back to neutral ground. */
function Mark() {
  return (
    <a className="navbar__mark" href="/">
      <span className="navbar__dot" aria-hidden="true" />
      BlipRank
    </a>
  )
}

/**
 * The domains this build can actually resolve a record for: every scan compiled
 * in or collected this session, plus whatever is stored as active.
 *
 * NOT a list of "your workspaces" — this build has no account and no server
 * list, and a switcher offering a domain nothing can render would be a control
 * promising a capability that does not exist. The stored domain is included
 * even when no scan matches it, because it genuinely is the one selected; the
 * dashboard is then the surface that says whether a cycle has been collected
 * for it.
 */
function resolvable(): readonly string[] {
  const active = readActiveDomain()
  const scanned = scans()
    .filter((s) => s.status === 'scanned')
    .map((s) => normaliseTyped(s.domain))
    .filter(Boolean)
  return [...new Set(active ? [...scanned, active] : scanned)]
}

/**
 * THE SWITCHER SHELL. The label is the fact — the domain, or the client count —
 * and the panel behind it is where that fact gets changed. The panel's contents
 * belong to the chrome that mounted it (brand: workspaces; agency: clients);
 * this component owns only the disclosure semantics.
 *
 * Not a `<select>`. The label is a fact about state rather than a chosen value,
 * and a native menu can render neither the mono domain nor an annotation.
 */
function Switcher({
  label,
  ariaLabel,
  panelLabel,
  onOpen,
  children,
}: {
  label: string
  ariaLabel: string
  panelLabel: string
  onOpen: () => void
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  // Focus goes INTO the panel on open. Without it a keyboard reader presses
  // Enter, the panel appears somewhere below their focus, and the next Tab
  // walks the nav links rather than the thing they just opened.
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>('button, a')?.focus()
  }, [open])

  // Outside click closes, and deliberately does NOT pull focus back: the reader
  // is already pointing somewhere else. Escape and selection do return it.
  useEffect(() => {
    if (!open) return
    function onDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  function close() {
    setOpen(false)
    buttonRef.current?.focus()
  }

  return (
    <div
      className="navbar__ws"
      ref={wrapRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) close()
      }}
      // Tabbing past the last item closes the panel rather than leaving it
      // hanging open over the links the reader has moved on to. The programmatic
      // focus on open lands inside `currentTarget`, so it does not trip this.
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <button
        type="button"
        ref={buttonRef}
        className={`navbar__wsbtn${open ? ' navbar__wsbtn--open' : ''}`}
        aria-expanded={open}
        aria-controls={panelId}
        // The visible text is inside the accessible name rather than replaced by
        // it (WCAG 2.5.3): a voice-control user says what they can read.
        aria-label={ariaLabel}
        // RE-READ ON OPEN. Storage is mutated by pages that never navigate:
        // /agency/add confirms a client, /agency removes one, the Grader
        // remembers a scan. A snapshot taken once at mount then contradicts the
        // page it sits on — "2 clients" in the bar over "3 in this portfolio" in
        // the margin, on one screen, in a product whose whole claim is that its
        // numbers reconcile. Every stale value here is only ever read while the
        // panel is open, so re-reading in the handler that opens it is the whole
        // fix; the label refreshes on that first open too.
        onClick={() => {
          if (!open) onOpen()
          setOpen(!open)
        }}
      >
        <span className="navbar__wsfig">{label}</span>
        {/* A vector, never a glyph: an icon in a control has to inherit
            currentColor and the type size around it. Rotation on open belongs to
            `--open` in the sheet, so reduced motion can reach it. */}
        <svg className="navbar__wscaret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9.5 12 15.5 18 9.5" />
        </svg>
      </button>

      {open ? (
        <div className="navbar__panel" id={panelId} ref={panelRef} role="group" aria-label={panelLabel}>
          {children(close)}
        </div>
      ) : null}
    </div>
  )
}

/**
 * NEUTRAL — / and both pricing pages. No switcher: there is no workspace on
 * neutral ground to state. The fork is two labelled doors; each is a plain
 * anchor that writes the role on the way through, so the destination and the
 * rest of the session agree on which mode was entered.
 */
function NeutralBar({ current }: { current: Surface }) {
  return (
    <nav className="navbar" aria-label="BlipRank">
      <div className="navbar__strip">
        <Mark />

        <div className="navbar__theme">
          <ThemeToggle />
        </div>

        <div className="navbar__links">
          <NavLink link={{ href: '/', label: 'Grader', on: 'grader' }} current={current} />
          <NavLink link={{ href: '/pricing', label: 'Pricing', on: 'pricing' }} current={current} />
        </div>

        <div className="navbar__util">
          <a className="navbar__link navbar__link--door" href="/dashboard" onClick={() => writeRole('brand')}>
            For brands
          </a>
          <a className="navbar__link navbar__link--door" href="/agency" onClick={() => writeRole('agency')}>
            For agencies
          </a>
        </div>
      </div>
    </nav>
  )
}

/** BRAND — /dashboard. The switcher lists resolvable domains, nothing else. */
function BrandBar({ current }: { current: Surface }) {
  const [active, setActive] = useState<string | null>(null)
  const [domains, setDomains] = useState<readonly string[]>([])
  // The server has no storage, so the first client render must match the server
  // exactly and everything stored arrives one paint later. Until then the
  // switcher reads "workspace" — the name of the control — and never "no
  // workspace", which would be a false statement about the reader's own account.
  const [mounted, setMounted] = useState(false)

  /** Everything the bar keeps from storage, read fresh. Mount, and every open. */
  function readStored() {
    setActive(readActiveDomain())
    setDomains(resolvable())
  }

  useEffect(() => {
    readStored()
    // The surface IS a statement of mode; written back so a session arriving
    // here from a link that never set the role — the worked-example app links
    // straight in — agrees with the page from now on.
    writeRole('brand')
    setMounted(true)
  }, [])

  function openDomain(domain: string) {
    writeActiveDomain(domain)
    // Full navigation, not a router push: the dashboard reads the active domain
    // back out of storage on load.
    window.location.href = '/dashboard'
  }

  const label = mounted ? (active ?? 'no workspace') : 'workspace'

  return (
    <nav className="navbar" aria-label="BlipRank">
      <div className="navbar__strip">
        <Mark />

        <Switcher label={label} ariaLabel={`Workspace ${label}. Change workspace.`} panelLabel="Workspace" onOpen={readStored}>
          {(close) => (
            <>
              <p className="navbar__panelcap">Workspace</p>
              {domains.length === 0 ? (
                <p className="navbar__panelnote">
                  No domain has been scanned in this browser yet, so there is nothing to switch to. Run the Grader to open one.
                </p>
              ) : (
                domains.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`navbar__item${d === active ? ' navbar__item--on' : ''}`}
                    // The current one is marked in words as well as in ink: a
                    // state carried by colour alone is unreadable to precisely
                    // the reader most likely to run two workspaces at once.
                    {...(d === active ? { 'aria-current': 'true' as const } : {})}
                    onClick={() => (d === active ? close() : openDomain(d))}
                  >
                    <span className="navbar__itemfig">{d}</span>
                    {d === active ? <span className="navbar__itemflag">current</span> : null}
                  </button>
                ))
              )}
            </>
          )}
        </Switcher>

        <div className="navbar__theme">
          <ThemeToggle />
        </div>

        <div className="navbar__links">
          <NavLink link={{ href: '/dashboard', label: 'Overview', on: 'dashboard' }} current={current} />
          {/* `#settings` lands on the workspace record, which every dashboard
              state carries — a hash that scrolls nowhere is a page claiming a
              surface it has not built. */}
          <NavLink link={{ href: '/dashboard#settings', label: 'Workspace' }} current={current} />
        </div>

        <div className="navbar__util">
          <NavLink link={{ href: '/', label: 'Grader', on: 'grader' }} current={current} />
          <NavLink link={{ href: '/pricing', label: 'Pricing', on: 'pricing' }} current={current} />
        </div>
      </div>
    </nav>
  )
}

/** AGENCY — /agency and /agency/add. The switcher lists clients, nothing else. */
function AgencyBar({ current }: { current: Surface }) {
  const [clients, setClients] = useState<readonly string[]>([])
  // Same guard as the brand bar: "workspace" until storage has been read.
  const [mounted, setMounted] = useState(false)

  /** Everything the bar keeps from storage, read fresh. Mount, and every open. */
  function readStored() {
    setClients(readAgencyDomains())
  }

  useEffect(() => {
    readStored()
    writeRole('agency')
    setMounted(true)
  }, [])

  const label = mounted ? `${clients.length} ${clients.length === 1 ? 'client' : 'clients'}` : 'workspace'

  return (
    <nav className="navbar" aria-label="BlipRank">
      <div className="navbar__strip">
        <Mark />

        <Switcher label={label} ariaLabel={`Portfolio: ${label}. Open a client record.`} panelLabel="Clients" onOpen={readStored}>
          {() => (
            <>
              <p className="navbar__panelcap">Clients</p>
              {clients.length === 0 ? (
                <p className="navbar__panelnote">No client is in this portfolio yet. Add one to open its record.</p>
              ) : (
                clients.map((d) => (
                  <a key={d} className="navbar__item" href={`/agency/client/${encodeURIComponent(d)}`}>
                    <span className="navbar__itemfig">{d}</span>
                  </a>
                ))
              )}
              <a className="navbar__item" href="/agency/add">
                <span className="navbar__itemname">Add client</span>
                <span className="navbar__itemgloss">Put another domain in the portfolio</span>
              </a>
            </>
          )}
        </Switcher>

        <div className="navbar__theme">
          <ThemeToggle />
        </div>

        <div className="navbar__links">
          <NavLink link={{ href: '/agency', label: 'Portfolio', on: 'agency' }} current={current} />
          <NavLink link={{ href: '/agency/add', label: 'Add client' }} current={current} />
        </div>

        <div className="navbar__util">
          <NavLink link={{ href: '/', label: 'Grader', on: 'grader' }} current={current} />
          <NavLink link={{ href: '/agency/pricing', label: 'Pricing' }} current={current} />
        </div>
      </div>
    </nav>
  )
}

export function ProductBar({ current }: { current: Surface }) {
  const chrome = CHROME[current]
  if (chrome === 'brand') return <BrandBar current={current} />
  if (chrome === 'agency') return <AgencyBar current={current} />
  return <NeutralBar current={current} />
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
