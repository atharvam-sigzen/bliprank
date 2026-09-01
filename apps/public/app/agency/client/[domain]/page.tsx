'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ActionLink } from '@/components/action-link'
import { BackLink } from '@/components/back-link'
import { ProductBar } from '@/components/chrome'
import { WorkspaceRecord } from '@/components/workspace-record'
import { normaliseTyped } from '@/lib/scan-result'
import { readAgencyDomains, workspaceFor } from '@/lib/workspace'
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
 * the frame: the chrome, the way back, and the three states a record cannot
 * express:
 *
 *   BOOTING       — localStorage not yet read (domain known, portfolio unknown)
 *   NOT IN PORTFOLIO — domain is valid but not in this browser's agency list
 *   LOADED        — domain is a confirmed portfolio member; render the record
 *
 * The domain comes from the URL param — never from the brand-side active domain
 * store. This page renders whichever client was clicked, independent of the
 * brand-side active domain.
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

  // `undefined` is "not yet read" — localStorage is unavailable during SSR and
  // during the first client render, so we read it in an effect rather than
  // synchronously. This keeps the same discipline as the brand dashboard.
  const [inPortfolio, setInPortfolio] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    if (!domain) {
      // Not a usable domain at all — no point checking the portfolio list.
      setInPortfolio(false)
      return
    }
    setInPortfolio(readAgencyDomains().includes(domain))
  }, [domain])

  // A genuinely unusable segment (empty, junk, a filename) is caught before the
  // portfolio check — there is no workspace to show regardless of the list.
  const workspace = domain ? workspaceFor(domain) : null

  return (
    <main className="shell shell--grader">
      <ProductBar current="agency" />

      <BackLink href="/agency" label="Back to the portfolio" />

      {inPortfolio === undefined ? (
        <Booting />
      ) : workspace === null || !inPortfolio ? (
        <NotInPortfolio typed={typed} />
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

/**
 * The pre-mount shell. Neutral on purpose: the page knows the domain from the
 * URL but does not yet know whether it is in this portfolio, because that lives
 * in localStorage and has not been read.
 */
function Booting() {
  return (
    <section className="record" aria-busy="true">
      <p className="prose">Opening the portfolio saved in this browser.</p>
    </section>
  )
}

/**
 * The domain is not a confirmed portfolio member — either the segment was not
 * a usable domain, or it resolved but is not in this browser's agency list.
 *
 * Never a raw 404: "not in portfolio" is a real, nameable state and the reader
 * deserves a page that says so, with a clear way back.
 */
function NotInPortfolio({ typed }: { typed: string }) {
  return (
    <section className="record">
      <h1 className="record__title">Not in this portfolio</h1>
      <p className="prose">
        {typed ? (
          <>
            <strong>{typed}</strong> is not in this portfolio.
          </>
        ) : (
          'This address names no client.'
        )}{' '}
        Nothing has been measured for it under this agency view and nothing on this page will pretend otherwise. Add it from{' '}
        <Link href="/agency/add">the portfolio&apos;s add sheet</Link> if it is a real client, or go back to{' '}
        <Link href="/agency">the portfolio</Link>.
      </p>
    </section>
  )
}
