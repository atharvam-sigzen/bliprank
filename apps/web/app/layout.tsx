import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'BlipRank',
  description: 'AI search visibility measurement, with the interval attached.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  )
}
