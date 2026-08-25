import type { Metadata } from 'next'

/**
 * Nested inside `agency/layout.tsx`, which would otherwise title this page
 * "Agency portfolio". Adding a client is its own step and says so.
 */
export const metadata: Metadata = {
  title: 'Add a client — BlipRank',
  description: 'See the category, the prompt allocation and the questions a cycle would ask, before anything is collected.',
}

export default function AddClientLayout({ children }: { children: React.ReactNode }) {
  return children
}
