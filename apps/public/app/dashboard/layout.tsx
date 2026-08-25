import type { Metadata } from 'next'

/**
 * A title, and nothing else.
 *
 * `page.tsx` in this segment is a client component — it reads the active
 * workspace out of browser storage — and a client component cannot export
 * metadata. Without this file the tab reads "AI Visibility Grader", which is a
 * different page of a different product surface. That is the only reason this
 * file exists; it adds no markup.
 */
export const metadata: Metadata = {
  title: 'Brand workspace — BlipRank',
  description: 'One tracked domain, its category, the prompts a cycle asks, and any cycle that has been collected for it.',
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return children
}
