'use client'

import { useEffect, useState } from 'react'

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
 */

export type Surface = 'dashboard' | 'grader' | 'pricing'

/** Absolute in dev so the cross-link works across two ports; env-overridable. */
const HREF = {
  dashboard: process.env['NEXT_PUBLIC_DASHBOARD_URL'] ?? 'http://localhost:3000',
  grader: process.env['NEXT_PUBLIC_GRADER_URL'] ?? 'http://localhost:3001',
}
// Pricing is a marketing page, so it ships with the free tools on Cloudflare
// Pages rather than with the paid app (ADR-0002) — hence off the Grader origin
// from both surfaces, not a relative path that would 404 from the dashboard.
const PRICING = `${HREF.grader}/pricing`

export function ProductBar({ current }: { current: Surface }) {
  return (
    <nav className="productbar" aria-label="BlipRank surfaces">
      <span className="productbar__mark">
        <span className="productbar__dot" aria-hidden="true" />
        BlipRank
      </span>
      <span className="cycle" style={{ fontSize: '0.75rem' }}>
        AI Search Visibility Assurance
      </span>
      <div className="productbar__nav">
        {/*
          Plain anchors, not next/link: these cross an origin in dev (3000 to
          3001) and cross a host in production (Vercel to Cloudflare Pages), and
          next/link's client navigation cannot do either.
        */}
        <a className="productbar__link" href={HREF.dashboard} {...(current === 'dashboard' ? { 'aria-current': 'page' as const } : {})}>
          Dashboard
        </a>
        <a className="productbar__link" href={HREF.grader} {...(current === 'grader' ? { 'aria-current': 'page' as const } : {})}>
          Grader
        </a>
        <a className="productbar__link" href={PRICING} {...(current === 'pricing' ? { 'aria-current': 'page' as const } : {})}>
          Pricing
        </a>
        <ThemeToggle />
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
    const stored = window.localStorage.getItem('bliprank-theme')
    if (stored === 'light' || stored === 'dark') setChoice(stored)
  }, [])

  function apply(next: Choice) {
    setChoice(next)
    const root = document.documentElement
    if (next === 'system') {
      root.removeAttribute('data-theme')
      window.localStorage.removeItem('bliprank-theme')
    } else {
      root.setAttribute('data-theme', next)
      window.localStorage.setItem('bliprank-theme', next)
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
