import type { Metadata } from 'next'

/** See `dashboard/layout.tsx` — a client page cannot carry its own title. */
export const metadata: Metadata = {
  title: 'Agency portfolio — BlipRank',
  description: 'Every client on one sheet, each row carrying its own confidence interval rather than a league table of point estimates.',
}

export default function AgencyLayout({ children }: { children: React.ReactNode }) {
  return children
}
