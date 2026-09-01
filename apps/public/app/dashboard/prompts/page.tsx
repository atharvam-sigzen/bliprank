'use client'

import { useEffect, useState } from 'react'
import { assertProvisionalAllowed } from '@bliprank/stats'
import { BackLink } from '@/components/back-link'
import { ProductBar } from '@/components/chrome'
import { ManagePrompts } from '@/components/manage-prompts'
import { readActiveDomain } from '@/lib/workspace'

// Module scope, exactly as the dashboard does it: the arithmetic on this page
// is provisional-grade material, and the block should fail `next build` rather
// than a customer's first visit.
assertProvisionalAllowed('Manage prompts')

/**
 * /dashboard/prompts — the brand mount of <ManagePrompts />.
 *
 * Thin on purpose: chrome, the storage read, and the two states the component
 * cannot express. Everything about prompts lives in the shared component, which
 * the agency surface mounts against its own routes.
 */
export default function BrandPromptsPage() {
  // `undefined` is "storage not read yet", distinct from `null`, "no
  // workspace" — same discipline as the dashboard, for the same hydration
  // reason.
  const [domain, setDomain] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    setDomain(readActiveDomain())
  }, [])

  return (
    <main className="shell shell--grader">
      <ProductBar current="dashboard" />
      {domain === undefined ? (
        <section className="record" aria-busy="true">
          <p className="prose">Opening the workspace saved in this browser.</p>
        </section>
      ) : domain === null ? (
        <>
          <BackLink href="/dashboard" label="Back to the overview" />
          <section className="record">
            <h1 className="record__title">No workspace yet</h1>
            <p className="prose">
              Prompts belong to a workspace, and this browser has none set. Scan a domain in the <a href="/">Grader</a> and its bank appears here.
            </p>
          </section>
        </>
      ) : (
        <ManagePrompts domain={domain} backHref="/dashboard" backLabel="Back to the overview" />
      )}
    </main>
  )
}
