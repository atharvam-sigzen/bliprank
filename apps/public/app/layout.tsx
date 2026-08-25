import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from 'next/font/google'

/*
 * THE TYPE IS THE POSITIONING, SO IT STOPPED BEING NEUTRAL.
 *
 * `next/font` self-hosts the files, preloads them and emits `size-adjust`
 * fallbacks: no third-party request at runtime, no reflow when a face arrives.
 *
 * Three roles, chosen against what this product claims rather than by taste:
 *
 *   Newsreader — the record's voice: headlines AND the annotation prose (the
 *   caveats, refusals and method sentences that are the product actually
 *   speaking). It replaced Instrument Serif, which was display-only — a
 *   single cut that could headline but never carry a paragraph, so the
 *   "published record" register stopped at the masthead. Newsreader is a
 *   text-first editorial family with a real optical-size axis (6–72) and true
 *   italics, so one family sets a 44px title and a 15px caveat, and the
 *   italic that marks a refused comparison is a designed letterform rather
 *   than a slant. It is also not the serif every AI-generated page ships.
 *
 *   IBM Plex Sans — the chassis: controls, labels, table headers. Demoted
 *   from prose duty; it is the machine's lettering, not the record's voice.
 *
 *   IBM Plex Mono — every number, bound and provenance line. A monospace
 *   readout is what an instrument looks like, and tabular width is
 *   load-bearing: a column of intervals that does not align is a column
 *   nobody scans. The serif and the mono never trade jobs.
 */
const display = Newsreader({ subsets: ['latin'], style: ['normal', 'italic'], axes: ['opsz'], variable: '--font-display-src', display: 'swap' })
const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-sans-src', display: 'swap' })
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-mono-src', display: 'swap' })
import './globals.css'
import { THEME_BOOT } from '@/components/chrome'

export const metadata: Metadata = {
  title: 'AI Visibility Grader — BlipRank',
  description: 'See how often AI answers mention your brand, with the confidence interval attached. Free.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={`${display.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* Before first paint, so a dark-mode reader never sees a white flash.
            A useEffect runs after paint, which is exactly too late. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
