import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SCAN } from '@/lib/scan-result'
import { WorkspaceRecord } from '@/components/workspace-record'
import { ManagePrompts } from '@/components/manage-prompts'

/**
 * ROUTE-LEVEL TESTS FOR /agency/client/[domain] AND /agency/client/[domain]/prompts
 *
 * Three claims per page:
 *
 *   CLIENT RECORD PAGE
 *   1. A valid client domain renders WorkspaceRecord in the agency-client context.
 *   2. An unknown domain shows the "not in portfolio" state, not a crash.
 *   3. The page always carries BackLink to /agency.
 *   4. The page imports readAgencyDomains (portfolio-membership guard) and not
 *      just workspaceFor — a raw workspaceFor call would show a workspace for
 *      any known domain regardless of portfolio membership.
 *
 *   PROMPTS PAGE
 *   5. The prompts page renders ManagePrompts correctly scoped to the client.
 *   6. It always carries BackLink to /agency (unconditional, not just in the null branch).
 *   7. The back link wires ManagePrompts to the client record, not to /agency.
 */

const clientSrc = readFileSync(new URL('../../../../app/agency/client/[domain]/page.tsx', import.meta.url), 'utf8')
const promptsSrc = readFileSync(new URL('../../../../app/agency/client/[domain]/prompts/page.tsx', import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// Source-level structural guards — the same style as agency/page.test.tsx.
// These fail `vitest` rather than a visitor's first load.
// ---------------------------------------------------------------------------

describe('agency client record page — structural guards', () => {
  it('guards portfolio membership with readAgencyDomains, not workspaceFor alone', () => {
    expect(clientSrc).toContain('readAgencyDomains')
    // The import must come from workspace, not a local re-implementation.
    expect(clientSrc).toMatch(/from '@\/lib\/workspace'/)
  })

  it('always renders BackLink to /agency regardless of state', () => {
    expect(clientSrc).toContain('<BackLink href="/agency" label="Back to the portfolio" />')
  })

  it('renders WorkspaceRecord with agency-client context', () => {
    expect(clientSrc).toContain('context="agency-client"')
  })

  it('renders ManagePrompts action link pointing at the prompts subpage', () => {
    expect(clientSrc).toContain('/agency/client/${encodeURIComponent(workspace.domain)}/prompts')
  })

  it('has a "not in portfolio" state distinct from a raw null-workspace state', () => {
    // The new state name distinguishes "not in this portfolio" from "not a usable domain".
    expect(clientSrc).toContain('Not in this portfolio')
    // Never a raw 404-style crash state or thrown error.
    expect(clientSrc).not.toContain('notFound')
    expect(clientSrc).not.toMatch(/\bthrow\s+new\b/)
  })

  it('reads the domain from route params, not from readActiveDomain', () => {
    expect(clientSrc).toContain('useParams')
    expect(clientSrc).not.toMatch(/\breadActiveDomain\s*\(/)
    expect(clientSrc).not.toMatch(/import\s*{[^}]*\breadActiveDomain\b/)
  })

  it('has a booting state while localStorage is being read', () => {
    // The tri-state discipline: `undefined` means "not yet read".
    expect(clientSrc).toContain('inPortfolio === undefined')
    expect(clientSrc).toContain('aria-busy="true"')
  })
})

describe('agency client prompts page — structural guards', () => {
  it('guards portfolio membership with readAgencyDomains', () => {
    expect(promptsSrc).toContain('readAgencyDomains')
    expect(promptsSrc).toMatch(/from '@\/lib\/workspace'/)
  })

  it('always renders BackLink to /agency — unconditional, not just in the null branch', () => {
    // The BackLink must appear in the outer shell, not only inside a conditional
    // branch. The test checks presence; back-button-rules.test.tsx validates position.
    expect(promptsSrc).toContain('<BackLink href="/agency" label="Back to the portfolio" />')
  })

  it('renders ManagePrompts with back link pointing at the client record', () => {
    expect(promptsSrc).toContain('backHref={`/agency/client/${encodeURIComponent(workspace.domain)}`}')
    expect(promptsSrc).toContain('backLabel="Back to the client record"')
  })

  it('has a "not in portfolio" state', () => {
    expect(promptsSrc).toContain('Not in this portfolio')
  })

  it('reads the domain from route params, not from readActiveDomain', () => {
    expect(promptsSrc).toContain('useParams')
    expect(promptsSrc).not.toMatch(/\breadActiveDomain\s*\(/)
    expect(promptsSrc).not.toMatch(/import\s*{[^}]*\breadActiveDomain\b/)
  })
})

// ---------------------------------------------------------------------------
// Render-level assertions — WorkspaceRecord and ManagePrompts in isolation.
// These confirm the components actually produce the right output for the
// context the pages pass them.
// ---------------------------------------------------------------------------

describe('WorkspaceRecord in agency-client context', () => {
  it('renders with a valid portfolio client domain in agency-client context', () => {
    // SCAN is pipedrive.com — the bundled scan that always resolves.
    const html = renderToStaticMarkup(<WorkspaceRecord domain={SCAN.domain} context="agency-client" />)
    // The record renders the domain name in the measured header.
    expect(html).toContain(SCAN.domain)
    // Agency context keeps workspace facts inline (not a pointer to /dashboard/workspace).
    expect(html).toContain('Tracked domain')
    expect(html).not.toContain('href="/dashboard/workspace"')
  })

  it('renders the "not a usable domain" guard for an empty segment', () => {
    // WorkspaceRecord's own inner guard: a blank or junk domain passed by a
    // caller bug renders an error section, not a blank record.
    const html = renderToStaticMarkup(<WorkspaceRecord domain="" context="agency-client" />)
    expect(html).toContain('not a usable domain')
  })
})

describe('ManagePrompts scoped to a client domain', () => {
  it('renders the prompt sheet for a valid portfolio client', () => {
    const html = renderToStaticMarkup(
      <ManagePrompts
        domain={SCAN.domain}
        backHref={`/agency/client/${encodeURIComponent(SCAN.domain)}`}
        backLabel="Back to the client record"
      />,
    )
    // The sheet renders the domain it was given.
    expect(html).toContain(SCAN.domain)
    // The back link is wired to the client record, not to /agency or /dashboard.
    expect(html).toContain(`/agency/client/${encodeURIComponent(SCAN.domain)}`)
    expect(html).toContain('Back to the client record')
    expect(html).not.toContain('href="/dashboard"')
    expect(html).not.toContain('href="/agency"')
  })
})
