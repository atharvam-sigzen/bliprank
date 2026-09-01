import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * THE BACK-BUTTON CANONICAL RULES:
 *
 * 1. Root pages (the entry point of each chrome/role) have NO back button.
 *    - / (Neutral Root / Grader)
 *    - /dashboard (Brand Root / Overview)
 *    - /agency (Agency Root / Portfolio)
 *    Leaving a root role goes through the Navbar Mark (`BlipRank` -> /).
 *
 * 2. Every sub-page below a root MUST render a BackLink pointing to its immediate parent:
 *    - /pricing -> Back to the Grader (/)
 *    - /agency/pricing -> Back to the Grader (/)
 *    - /dashboard/workspace -> Back to the overview (/dashboard)
 *    - /dashboard/prompts -> Back to the overview (/dashboard) (both when domain is set and null)
 *    - /agency/add -> Back to the portfolio (/agency)
 *    - /agency/lifecycle -> Back to the portfolio (/agency)
 *    - /agency/client/[domain] -> Back to the portfolio (/agency)
 *    - /agency/client/[domain]/prompts -> Back to the client record (/agency/client/${domain})
 *    - /not-found -> Back to the Grader (/)
 */

describe('Back-button consistency across chromes and subpages', () => {
  const readPage = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

  it('root pages never render a BackLink', () => {
    const roots = [
      '../app/page.tsx', // Neutral root
      '../app/dashboard/page.tsx', // Brand root
      '../app/agency/page.tsx', // Agency root
    ]
    for (const file of roots) {
      const src = readPage(file)
      expect([file, src.includes('<BackLink')]).toEqual([file, false])
    }
  })

  it('neutral subpages render BackLink to the Grader', () => {
    const pricing = readPage('../app/pricing/page.tsx')
    expect(pricing).toContain('<BackLink href="/" label="Back to the Grader" />')

    const agencyPricing = readPage('../app/agency/pricing/page.tsx')
    expect(agencyPricing).toContain('<BackLink href="/" label="Back to the Grader" />')

    const notFound = readPage('../app/not-found.tsx')
    expect(notFound).toContain('<BackLink href="/" label="Back to the Grader" />')
  })

  it('brand subpages render BackLink to the Brand overview', () => {
    const workspace = readPage('../app/dashboard/workspace/page.tsx')
    expect(workspace).toContain('<BackLink href="/dashboard" label="Back to the overview" />')

    const prompts = readPage('../app/dashboard/prompts/page.tsx')
    expect(prompts).toContain('backHref="/dashboard"')
    expect(prompts).toContain('backLabel="Back to the overview"')
    expect(prompts).toContain('<BackLink href="/dashboard" label="Back to the overview" />')
  })

  it('agency subpages render BackLink to the portfolio or parent client record', () => {
    const add = readPage('../app/agency/add/page.tsx')
    expect(add).toContain('<BackLink href="/agency" label="Back to the portfolio" />')

    const lifecycle = readPage('../app/agency/lifecycle/page.tsx')
    expect(lifecycle).toContain('<BackLink href="/agency" label="Back to the portfolio" />')

    const client = readPage('../app/agency/client/[domain]/page.tsx')
    expect(client).toContain('<BackLink href="/agency" label="Back to the portfolio" />')

    const clientPrompts = readPage('../app/agency/client/[domain]/prompts/page.tsx')
    expect(clientPrompts).toContain('backHref={`/agency/client/${encodeURIComponent(workspace.domain)}`}')
    expect(clientPrompts).toContain('backLabel="Back to the client record"')
    expect(clientPrompts).toContain('<BackLink href="/agency" label="Back to the portfolio" />')
  })
})
