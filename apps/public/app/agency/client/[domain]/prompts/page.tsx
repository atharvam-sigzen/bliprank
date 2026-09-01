'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { BackLink } from '@/components/back-link'
import { ProductBar } from '@/components/chrome'
import { ManagePrompts } from '@/components/manage-prompts'
import { normaliseTyped } from '@/lib/scan-result'
import { readAgencyDomains, workspaceFor } from '@/lib/workspace'
import { assertProvisionalAllowed } from '@bliprank/stats'

assertProvisionalAllowed('The agency client prompt sheet')

/**
 * ONE CLIENT'S PROMPT SHEET, inside the agency chrome.
 *
 * The sheet itself is the shared `ManagePrompts`; this page owns only the
 * agency chrome and the three states the component cannot express:
 *
 *   BOOTING        — localStorage not yet read (domain known, portfolio unknown)
 *   NOT IN PORTFOLIO — domain valid but not in this browser's agency list
 *   LOADED         — confirmed portfolio member; render the prompt sheet
 *
 * Domain comes from the route param, independent of the brand-side active
 * domain. The portfolio check uses `readAgencyDomains()` for the same reason
 * the client record page does: the prompts sheet must not render for a domain
 * that was not added to this portfolio.
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
  const typed = safeDecode(params?.domain ?? '')
  const domain = normaliseTyped(typed)

  // `undefined` is "not yet read" — same discipline as the client record page
  // and the brand dashboard: localStorage is read in an effect, never during
  // render, so server and first-client renders agree.
  const [inPortfolio, setInPortfolio] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    if (!domain) {
      setInPortfolio(false)
      return
    }
    setInPortfolio(readAgencyDomains().includes(domain))
  }, [domain])

  const workspace = domain ? workspaceFor(domain) : null

  return (
    <main className="shell shell--grader">
      <ProductBar current="agency" />

      {/* The portfolio-level back control is unconditional: every state on this
          page — booting, not in portfolio, or loaded — is a subpage of /agency,
          and the reader must always have a clear way back to it. */}
      <BackLink href="/agency" label="Back to the portfolio" />

      {inPortfolio === undefined ? (
        <section className="record" aria-busy="true">
          <p className="prose">Opening the portfolio saved in this browser.</p>
        </section>
      ) : workspace === null || !inPortfolio ? (
        <section className="record">
          <h1 className="record__title">Not in this portfolio</h1>
          <p className="prose">
            {typed ? (
              <>
                <strong>{typed}</strong> is not in this portfolio,
              </>
            ) : (
              'This address names no client,'
            )}{' '}
            so there is no prompt sheet to show. Go back to <Link href="/agency">the portfolio</Link>.
          </p>
        </section>
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
