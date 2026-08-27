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
 *
 * WHY THIS ONE IS NEUTRAL AND STATIC. Same single strip and the same class
 * names, so the two deploys do not look like two products — but the workspace
 * lives entirely in `apps/public`: the role, the active domain and the client
 * list are stored in that origin's `localStorage` and cannot be read from here.
 * So this bar takes no side in the brand/agency fork and links to no workspace:
 * the switcher slot is a static label stating the one true thing this app can
 * say about itself — that it is a worked example — and the links go to the
 * Grader and its pricing page, where the fork actually lives.
 */

export type Surface = 'dashboard' | 'grader' | 'pricing' | 'agency'

/** Absolute in dev so the cross-link works across two ports; env-overridable. */
const GRADER = process.env['NEXT_PUBLIC_GRADER_URL'] ?? 'http://localhost:3001'

import { ThemeToggle, THEME_BOOT, themedUrl, useTheme, readTheme } from './theme'
export { ThemeToggle, THEME_BOOT, themedUrl, useTheme, readTheme }

/**
 * Backward compatibility wrapper. In new code, prefer `themedUrl(url, useTheme())`
 * so the link stays reactive to live theme changes.
 */
export function withTheme(url: string): string {
  return themedUrl(url, readTheme())
}

export function ProductBar({ current: _current }: { current: Surface }) {
  const theme = useTheme()

  return (
    <nav className="navbar" aria-label="BlipRank">
      <div className="navbar__strip">
        {/* Plain anchors, not next/link: every link here crosses an origin in
            dev (3000 to 3001) and a host in production (Vercel to Cloudflare
            Pages), and next/link's client navigation cannot do either. */}
        <a className="navbar__mark" href={themedUrl(GRADER, theme)}>
          <span className="navbar__dot" aria-hidden="true" />
          BlipRank
        </a>

        {/* The switcher slot, static. Same wrapper, same metrics, no button and
            no caret: there is nothing here to switch between. */}
        <div className="navbar__ws">
          <span className="navbar__wsstatic">worked example</span>
        </div>

        <div className="navbar__theme">
          <ThemeToggle />
        </div>

        <div className="navbar__util">
          <a className="navbar__link" href={themedUrl(GRADER, theme)}>
            Grader
          </a>
          <a className="navbar__link" href={themedUrl(`${GRADER}/pricing`, theme)}>
            Pricing
          </a>
        </div>
      </div>
    </nav>
  )
}
