import type { Metadata } from 'next'
import './globals.css'
import { THEME_BOOT } from '@/components/chrome'

export const metadata: Metadata = {
  title: 'BlipRank',
  description: 'AI search visibility measurement, with the interval attached.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <head>
        {/* Before first paint, so a dark-mode reader never sees a white flash.
            A useEffect runs after paint, which is exactly too late. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
