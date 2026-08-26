'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { BackLink } from '@/components/back-link'
import { ProductBar } from '@/components/chrome'
import { ManagePrompts } from '@/components/manage-prompts'
import { normaliseTyped } from '@/lib/scan-result'
import { workspaceFor } from '@/lib/workspace'
import { assertProvisionalAllowed } from '@bliprank/stats'

assertProvisionalAllowed('The agency client prompt sheet')

/**
 * ONE CLIENT'S PROMPT SHEET. The sheet itself is the shared `ManagePrompts`;
 * this page owns only the agency chrome and the guard against a segment that
 * resolves to no workspace.
 */

/** See ../page.tsx — a malformed escape must not crash the route. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export default function AgencyClientPromptsPage() {
  const params = useParams<{ domain: string }>()
  const domain = normaliseTyped(safeDecode(params?.domain ?? ''))
  const workspace = domain ? workspaceFor(domain) : null

  return (
    <main className="shell shell--grader">
      <ProductBar current="agency" />

      {workspace === null ? (
        <>
        <BackLink href="/agency" label="Back to the portfolio" />
        <section className="record">
          <h1 className="record__title">Not a client workspace</h1>
          <p className="prose">
            This address names no client, so there is no prompt sheet to show. Go back to <Link href="/agency">the portfolio</Link>.
          </p>
        </section>
        </>
      ) : (
        /* backHref is the explicit client-record path rather than "..": a
           relative href resolved from /agency/client/x/prompts (no trailing
           slash) lands on /agency/client/, which is not a page. */
        <ManagePrompts
          domain={workspace.domain}
          backHref={`/agency/client/${encodeURIComponent(workspace.domain)}`}
          backLabel="Back to the client record"
        />
      )}
    </main>
  )
}
