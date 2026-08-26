'use client'

import { useEffect, useState } from 'react'
import { assertProvisionalAllowed } from '@bliprank/stats'
import { BackLink } from '@/components/back-link'
import { ProductBar } from '@/components/chrome'
import { WorkspaceFacts } from '@/components/workspace-record'
import { readActiveDomain, workspaceFor, type Workspace } from '@/lib/workspace'

// Module scope, exactly as the dashboard does it: the schedule row on this page
// is provisional-grade material, and the block should fail `next build` rather
// than a customer's first visit.
assertProvisionalAllowed('The workspace page')

/**
 * /dashboard/workspace — a real page for what the bar's anchor pretended to be.
 *
 * The workspace facts, the locked-domain rule and the way to the prompt bank
 * used to sit at the foot of the overview, reachable only as a hash scroll.
 * They are the settings surface of the product, so they get an address. The
 * facts themselves are the shared `WorkspaceFacts` — the same section the
 * agency client pages render inline — with the brand copy.
 *
 * Thin on purpose: chrome, the storage read, and the two states the section
 * cannot express. Nothing here collects; `workspaceFor` classifies offline
 * (R3).
 */
export default function BrandWorkspacePage() {
  // `undefined` is "storage not read yet", distinct from `null`, "no
  // workspace" — same discipline as the dashboard, for the same hydration
  // reason.
  const [workspace, setWorkspace] = useState<Workspace | null | undefined>(undefined)

  useEffect(() => {
    const active = readActiveDomain()
    setWorkspace(active ? workspaceFor(active) : null)
  }, [])

  return (
    <main className="shell shell--grader">
      <ProductBar current="workspace" />
      <BackLink href="/dashboard" label="Back to the overview" />
      {workspace === undefined ? (
        <section className="record" aria-busy="true">
          <p className="prose">Opening the workspace saved in this browser.</p>
        </section>
      ) : workspace === null ? (
        <section className="record">
          <h1 className="record__title">No workspace yet</h1>
          <p className="prose">
            A workspace opens around one domain, and this browser has none set. Scan a domain in the <a href="/">Grader</a> and its facts appear
            here.
          </p>
        </section>
      ) : (
        <>
          <header className="masthead">
            <h1 className="record__title">{workspace.domain}</h1>
            <p className="lede">{workspace.categoryName}</p>
          </header>
          <WorkspaceFacts workspace={workspace} context="brand" />
        </>
      )}
    </main>
  )
}
