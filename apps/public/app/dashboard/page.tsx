'use client'

import { useEffect, useState } from 'react'
import { assertProvisionalAllowed } from '@bliprank/stats'
import { ProductBar } from '@/components/chrome'
import { WorkspaceRecord } from '@/components/workspace-record'
import { ACTIVE_STORAGE_KEY, readActiveDomain, workspaceFor, type Workspace } from '@/lib/workspace'

// Module scope, exactly as the Grader does it. The record this page mounts
// renders a Confidence Grade, and the grade is only reached after a browser
// read — so relying on confidenceGrade to throw would mean discovering the
// block in front of a customer rather than at build time. This fails
// `next build` instead.
assertProvisionalAllowed('The brand dashboard')

/**
 * THE BRAND DASHBOARD — a thin mount around the workspace record.
 *
 * Everything measured or pre-flight lives in `WorkspaceRecord`, shared with the
 * agency's per-client view. This page owns only what is brand-specific: the
 * chrome, the storage read, and the two states a record cannot express —
 * "storage not read yet" and "no workspace at all".
 *
 * Nothing here collects. `workspaceFor` classifies offline; no code path on
 * this page can reach a provider (R3).
 */
export default function BrandDashboard() {
  // `undefined` means "storage not read yet" and is deliberately distinct from
  // `null`, which means "no workspace". Reading localStorage during render would
  // produce a server/client mismatch, and on this page the mismatch is visible:
  // a reader with data would see the pre-flight screen flash first.
  const [workspace, setWorkspace] = useState<Workspace | null | undefined>(undefined)

  useEffect(() => {
    const active = readActiveDomain()
    setWorkspace(active ? workspaceFor(active) : null)
  }, [])

  // THE HASH HAS TO BE RESOLVED TWICE. The bar's "Workspace" link is a full page
  // load of /dashboard#settings; the browser looks for #settings while the page
  // is still <Booting />, finds nothing, and never retries.
  //
  // The retry has to wait for the state that OWNS the anchor to be committed,
  // which is why it keys on `workspace` instead of sharing the effect above.
  // Inside that effect the `setWorkspace` render has not flushed yet, so the DOM
  // is still <Booting /> and the second lookup misses exactly like the first.
  useEffect(() => {
    if (workspace === undefined) return
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView()
  }, [workspace])

  return (
    <main className="shell shell--grader">
      <ProductBar current="dashboard" />
      {workspace === undefined ? (
        <Booting />
      ) : workspace === null ? (
        <NoWorkspace />
      ) : (
        <WorkspaceRecord domain={workspace.domain} context="brand" />
      )}
    </main>
  )
}

/**
 * The pre-mount shell. Neutral on purpose: it names no domain, shows no figure
 * and commits to neither state, because at this point the page genuinely does
 * not know which one it is in.
 */
function Booting() {
  return (
    <section className="record" aria-busy="true">
      <p className="prose">Opening the workspace saved in this browser.</p>
    </section>
  )
}

/**
 * No active domain. The Grader is the only door into a workspace, so point at it.
 *
 * It carries `id="settings"` because the product bar's "Workspace" link exists
 * in this state too, and a nav entry aimed at a section this state never renders
 * is a link that silently does nothing.
 */
function NoWorkspace() {
  return (
    <div className="annotated">
      <section className="record annotated__body" id="settings">
        <h1 className="record__title">No workspace yet</h1>
        <p className="prose">
          A workspace opens around one domain, and this browser has none set. Scan a domain in the <a href="/">Grader</a> and it becomes the
          subject of this dashboard.
        </p>
        {/* No sample dashboard is rendered in its place. A placeholder screen
            teaches the reader that the numbers here are decorative. */}
        <p className="prose">Nothing is shown below because nothing has been measured.</p>
      </section>
      <aside className="note">
        <span className="note__cap">Storage</span>
        <span className="note__line">key {ACTIVE_STORAGE_KEY}</span>
        <span className="note__gloss">
          The active domain is kept in this browser only. There is no account behind it yet, so clearing site data clears the workspace.
        </span>
      </aside>
    </div>
  )
}
