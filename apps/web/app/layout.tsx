import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from 'next/font/google'

/*
 * THE TYPE IS THE POSITIONING, SO IT STOPPED BEING NEUTRAL.
 *
 * Newsreader replaced Instrument Serif in the Measurement Record pass — a
 * text-first editorial family (optical sizes 6–72, true italics) so the
 * "published record" register can extend past the masthead into annotation
 * prose when this app gets its record-sheet restructure. The dashboard keeps
 * its current layout until that pass; the face and palette land now so the
 * two surfaces never read as different products. Full reasoning in
 * apps/public/app/layout.tsx.
 *
 *   IBM Plex Sans — the chassis: controls, labels, table headers.
 *   IBM Plex Mono — every number, bound and provenance line; tabular width
 *   is load-bearing. The serif and the mono never trade jobs.
 */
const display = Newsreader({ subsets: ['latin'], style: ['normal', 'italic'], axes: ['opsz'], variable: '--font-display-src', display: 'swap' })
const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-sans-src', display: 'swap' })
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-mono-src', display: 'swap' })
import './globals.css'
import { THEME_BOOT } from '@/components/chrome'

export const metadata: Metadata = {
  title: 'BlipRank',
  description: 'AI search visibility measurement, with the interval attached.',
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
