import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * REGRESSION. The portfolio's prompt pool was drawn against the BRAND Growth
 * tier (100 prompts, $349/mo) and the legend rendered that cap as this
 * portfolio's plan ("— Growth plan"), one click from /agency/pricing selling
 * AGENCY tiers with pooled prompts 75/200/500 and no such plan. Two guards,
 * both mechanical:
 *
 *   1. This page may not import the brand plan book at all.
 *   2. The wording follows ManagePrompts: what a plan WOULD allow, and an
 *      inline statement that no plan is attached — never a cap stated as a
 *      fact of the portfolio.
 */
const src = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('the agency portfolio pool and its plan book', () => {
  it('draws against the agency tiers, never the brand ones', () => {
    expect(src).not.toContain("'@/lib/pricing'")
    expect(src).toContain("from '@/lib/agency-pricing'")
    expect(src).toContain('pooledPrompts')
  })

  it('states the pool as what a plan would allow, with no plan attached', () => {
    expect(src).toContain('would pool')
    expect(src).toContain('No plan is attached to this portfolio in this build')
    expect(src).toContain('not an allowance this portfolio holds')
    // The old legend's plan attribution must not come back in any casing.
    expect(src).not.toMatch(/—\s*\{[A-Z_]+\.name\} plan/)
  })
})
