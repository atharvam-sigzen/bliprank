'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { normaliseTyped, scans } from '@/lib/scan-result'
import { readActiveDomain, readAgencyDomains, readRole, writeActiveDomain, writeRole, type Role } from '@/lib/workspace'

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
 * WHY ONE ROW NOW. The two-tier bar cost 116px on desktop and 201px at 390px to
 * carry, on every page, a bordered segmented role switch that was the loudest
 * object on screen — while the single most important fact, WHICH RECORD AM I
 * LOOKING AT, was an unlabelled mono string floating beside it. Both tiers ran
 * roughly 900px of dead space.
 *
 * So role, active context and switching collapse into ONE control. The label is
 * the fact — the domain, or the client count — and the panel behind it is where
 * that fact gets changed. Chrome is not the product: it states where you are in
 * one hairline strip and then gets out of the way.
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
 * portfolio, with the switcher reporting the mode you are not in. The choice is
 * written back so the rest of the session agrees with the page.
 */
const IMPLIED: Partial<Record<Surface, Role>> = { dashboard: 'brand', agency: 'agency' }

const ROLE_LABEL: Record<Role, string> = { brand: 'Brand', agency: 'Agency' }
/** What each role IS, in one clause. The panel is where a reader learns this. */
const ROLE_GLOSS: Record<Role, string> = {
  brand: 'One domain, one record',
  agency: 'A portfolio of client records',
}

function NavLink({ link, current }: { link: Link; current: Surface }) {
  const on = link.on === current
  return (
    <a className={`navbar__link${on ? ' navbar__link--on' : ''}`} href={link.href} {...(on ? { 'aria-current': 'page' as const } : {})}>
      {link.label}
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
 * THE SWITCHER. One control carrying three jobs that used to be three objects:
 * which record am I looking at (the label), which mode am I in and how do I
 * leave it (the role section), and which other record can I open (the workspace
 * section).
 *
 * Not a `<select>`. The label is a fact about state rather than a chosen value,
 * the panel holds two different kinds of item — a mode change and a record
 * change — and a native menu can render neither the mono domain nor the
 * annotation that says what a mode is.
 */
function WorkspaceSwitcher({
  label,
  role,
  domains,
  active,
  onRole,
  onDomain,
  onOpen,
}: {
  label: string
  role: Role
  domains: readonly string[]
  active: string | null
  onRole: (next: Role) => void
  onDomain: (domain: string) => void
  onOpen: () => void
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
        aria-label={`Workspace ${label}. Change workspace or role.`}
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
        <div className="navbar__panel" id={panelId} ref={panelRef} role="group" aria-label="Workspace and role">
          <p className="navbar__panelcap">Role</p>
          {(['brand', 'agency'] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={`navbar__item${role === r ? ' navbar__item--on' : ''}`}
              // The current one is marked in words as well as in ink: a state
              // carried by colour alone is unreadable to precisely the reader
              // most likely to be running two workspaces at once.
              {...(role === r ? { 'aria-current': 'true' as const } : {})}
              onClick={() => (role === r ? close() : onRole(r))}
            >
              <span className="navbar__itemname">{ROLE_LABEL[r]}</span>
              <span className="navbar__itemgloss">{ROLE_GLOSS[r]}</span>
              {role === r ? <span className="navbar__itemflag">current</span> : null}
            </button>
          ))}

          {role === 'brand' ? (
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
                    {...(d === active ? { 'aria-current': 'true' as const } : {})}
                    onClick={() => (d === active ? close() : onDomain(d))}
                  >
                    <span className="navbar__itemfig">{d}</span>
                    {d === active ? <span className="navbar__itemflag">current</span> : null}
                  </button>
                ))
              )}
            </>
          ) : (
            <>
              <p className="navbar__panelcap">Clients</p>
              <a className="navbar__item" href="/agency/add">
                <span className="navbar__itemname">Add client</span>
                <span className="navbar__itemgloss">Put another domain in the portfolio</span>
              </a>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function ProductBar({ current }: { current: Surface }) {
  // AT RENDER, NOT IN THE EFFECT. `IMPLIED[current]` depends only on the prop,
  // so it is identical on the server and on the first client render and cannot
  // cause a mismatch — while deferring it shipped the brand nav over /agency in
  // the prerendered HTML, permanently so with JS off or to a crawler, and sent
  // anyone clicking during that frame to /dashboard from the portfolio.
  const [role, setRole] = useState<Role>(() => IMPLIED[current] ?? 'brand')
  const [active, setActive] = useState<string | null>(null)
  const [clients, setClients] = useState(0)
  const [domains, setDomains] = useState<readonly string[]>([])
  // The server has no storage, so the first client render must match the server
  // exactly and everything stored arrives one paint later. Until then the
  // switcher reads "workspace" — the name of the control — and never "no
  // workspace", which would be a false statement about the reader's own account.
  const [mounted, setMounted] = useState(false)

  /** Everything the bar keeps from storage, read fresh. Mount, and every open. */
  function readStored() {
    setActive(readActiveDomain())
    setClients(readAgencyDomains().length)
    setDomains(resolvable())
  }

  useEffect(() => {
    const implied = IMPLIED[current]
    const actual = implied ?? readRole()
    setRole(actual)
    setActive(readActiveDomain())
    setClients(readAgencyDomains().length)
    setDomains(resolvable())
    if (implied) writeRole(implied)
    setMounted(true)
  }, [current])

  function switchTo(next: Role) {
    writeRole(next)
    // A mode change goes to that mode's home. Full navigation, not a router
    // push: the destination reads the role back out of storage on load.
    window.location.href = HOME[next]
  }

  function openDomain(domain: string) {
    writeActiveDomain(domain)
    window.location.href = HOME.brand
  }

  const label = !mounted ? 'workspace' : role === 'agency' ? `${clients} ${clients === 1 ? 'client' : 'clients'}` : (active ?? 'no workspace')

  return (
    <nav className="navbar" aria-label="BlipRank">
      <div className="navbar__strip">
        <span className="navbar__mark">
          <span className="navbar__dot" aria-hidden="true" />
          BlipRank
        </span>

        <WorkspaceSwitcher label={label} role={role} domains={domains} active={active} onRole={switchTo} onDomain={openDomain} onOpen={readStored} />

        {/*
          The toggle sits third in the DOM and is ordered last on the strip, so
          that when the two link groups drop to their own lines on a narrow
          screen it stays on the identity line beside the switcher instead of
          being stranded alone on a fourth row.
        */}
        <div className="navbar__theme">
          <ThemeToggle />
        </div>

        {/*
          GATED THE SAME WAY THE LABEL IS. `IMPLIED` covers /dashboard and
          /agency, where the surface itself states the role and the server can
          render the right links. On /pricing and / it does not, so `role` starts
          at the `brand` fallback and the stored role only arrives one paint
          later — which shipped the brand links in the prerendered HTML, visibly
          swapped the strip after mount, and sent an agency reader clicking in
          that frame to /dashboard. Rendering nothing until the role is known is
          the honest state: a link group that names the wrong workspace is worse
          than a link group that is not there yet.
        */}
        <div className="navbar__links">
          {mounted || IMPLIED[current]
            ? NAV[role].map((link) => <NavLink key={link.href} link={link} current={current} />)
            : null}
        </div>

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
