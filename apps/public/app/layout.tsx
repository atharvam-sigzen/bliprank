import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans, Instrument_Serif } from 'next/font/google'

/*
 * THE TYPE IS THE POSITIONING, SO IT STOPPED BEING NEUTRAL.
 *
 * Fira Sans and Fira Code were reasonable and anonymous — the same technical
 * sans every dashboard in this category reaches for, loaded through a
 * render-blocking `@import` that also guaranteed a flash of fallback text on the
 * headline. Both problems are fixed here: `next/font` self-hosts the files,
 * preloads them and emits `size-adjust` fallbacks, so there is no third-party
 * request at runtime and no reflow when the face arrives.
 *
 * Three roles, chosen against what this product claims rather than by taste:
 *
 *   Instrument Serif — headings. A high-contrast editorial face, the register of
 *   a published record rather than an app chrome. This is the one deliberate
 *   piece of personality, and it is on the words rather than on the data.
 *
 *   IBM Plex Sans — interface. Drawn for engineering documentation, with real
 *   tabular figures. It carries technical credibility without shouting.
 *
 *   IBM Plex Mono — every number, bound and provenance line. A monospace readout
 *   is what an instrument looks like, and tabular width is load-bearing: a
 *   column of intervals that does not align is a column nobody scans.
 */
const display = Instrument_Serif({ subsets: ['latin'], weight: '400', variable: '--font-display-src', display: 'swap' })
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
