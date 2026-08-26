'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ActionLink } from '@/components/action-link'
import { BackLink } from '@/components/back-link'
import { ProductBar } from '@/components/chrome'
import { WorkspaceRecord } from '@/components/workspace-record'
import { normaliseTyped } from '@/lib/scan-result'
import { workspaceFor } from '@/lib/workspace'
import { assertProvisionalAllowed } from '@bliprank/stats'

// Module scope, as on /agency: a provisional surface must fail `next build`
// rather than throw in front of a reader.
assertProvisionalAllowed('The agency client record')

/**
 * ONE CLIENT'S RECORD, inside the agency chrome.
 *
 * The record itself is the shared `WorkspaceRecord` — the same measured and
 * pre-flight states the brand dashboard renders, with `context="agency-client"`
 * changing only the copy that names the plan side. This page owns nothing but
 * the frame: the chrome, the way back, and the refusal to render a workspace
 * for a segment that does not resolve to one.
 */

/** decodeURIComponent throws on a malformed escape; a hand-typed URL must
 * render the honest empty state, never a crash. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export default function AgencyClientPage() {
  const params = useParams<{ domain: string }>()
  const typed = safeDecode(params?.domain ?? '')
  const domain = normaliseTyped(typed)
  // Same resolver every other surface uses. Null means the segment is not a
  // usable domain (empty, junk, a filename) — there is no workspace to show,
  // and this page says so rather than inventing one.
  const workspace = domain ? workspaceFor(domain) : null

  return (
    <main className="shell shell--grader">
      <ProductBar current="agency" />

      <BackLink href="/agency" label="Back to the portfolio" />

      {workspace === null ? (
        <section className="record">
          <h1 className="record__title">Not a client workspace</h1>
          <p className="prose">
            {typed ? <><strong>{typed}</strong> does not resolve to a workspace.</> : 'This address names no client.'} Nothing has been measured
            for it and nothing on this page will pretend otherwise. Add it from{' '}
            <Link href="/agency/add">the portfolio&apos;s add sheet</Link> if it is a real domain, or go back to{' '}
            <Link href="/agency">the portfolio</Link>.
          </p>
        </section>
      ) : (
        <>
          <WorkspaceRecord domain={workspace.domain} context="agency-client" />
          {/* A forward action on its own line, as everywhere else: a short
              destination label, with the gloss kept as plain prose beside it
              rather than folded into the link text. */}
          <ActionLink href={`/agency/client/${encodeURIComponent(workspace.domain)}/prompts`}>Manage prompts</ActionLink>
          <p className="prose">The sheet a cycle would ask for this client, and any custom prompts added to it.</p>
        </>
      )}
    </main>
  )
}
