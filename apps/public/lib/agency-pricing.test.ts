import { describe, expect, it } from 'vitest'

import { AGENCY_TIERS, FEATURED_ID, PROMPTS_PER_CYCLE, agencyMaths, brandComparison, tierById } from './agency-pricing'
import { TIERS } from './pricing'

describe('agency tier arithmetic', () => {
  it('derives every figure the page prints from the tier data', () => {
    for (const t of AGENCY_TIERS) {
      const m = agencyMaths(t)
      expect(m.promptsPerDomain).toBeCloseTo(t.pooledPrompts / t.domains, 10)
      expect(m.promptsPerDomainLabel).toBe((t.pooledPrompts / t.domains).toFixed(1))
      expect(m.usdPerDomain).toBe((t.usdPerMonth / t.domains).toFixed(2))
      expect(m.usdPerPrompt).toBe((t.usdPerMonth / t.pooledPrompts).toFixed(2))
      expect(m.promptsForFullOccupancy).toBe(t.domains * PROMPTS_PER_CYCLE)
      expect(m.domainsAtFullCycle).toBe(Math.floor(t.pooledPrompts / PROMPTS_PER_CYCLE))
      expect(m.evenSplit).toBe(Math.floor(t.pooledPrompts / t.domains))
    }
  })

  // Pinned, because these three strings are the page's headline claim and a
  // price edit that changes them must be seen, not absorbed.
  it('prints the figures the page states', () => {
    expect(AGENCY_TIERS.map((t) => agencyMaths(t).promptsPerDomainLabel)).toEqual(['15.0', '13.3', '12.5'])
    expect(AGENCY_TIERS.map((t) => agencyMaths(t).usdPerDomain)).toEqual(['39.80', '33.27', '24.98'])
    expect(AGENCY_TIERS.map((t) => agencyMaths(t).usdPerPrompt)).toEqual(['2.65', '2.50', '2.00'])
  })

  /**
   * THE CENTRAL CLAIM. The page says, in the product's own voice, that the
   * domain count is a ceiling and the pool is what funds it — that no tier
   * funds a full cycle for every client at maximum occupancy.
   *
   * If a future edit pads a pool or trims a ceiling until one tier is
   * sufficient, this test fails on purpose. The correct response is to rewrite
   * the copy, not to relax the assertion.
   */
  it('leaves every tier short of a full cycle at maximum occupancy', () => {
    for (const t of AGENCY_TIERS) {
      const m = agencyMaths(t)
      expect(m.fundsFullCycle).toBe(false)
      expect(m.promptsPerDomain).toBeLessThan(PROMPTS_PER_CYCLE)
      expect(m.shortfallPerDomain).toBeGreaterThan(0)
      // The same statement from the other side: the pool is smaller than a
      // full cycle for every domain the ceiling allows.
      expect(t.pooledPrompts).toBeLessThan(t.domains * PROMPTS_PER_CYCLE)
      expect(m.promptsForFullOccupancy).toBeGreaterThan(t.pooledPrompts)
      // ...and fewer clients can run at full depth than the ceiling allows.
      expect(m.domainsAtFullCycle).toBeLessThan(t.domains)
    }
  })

  it('derives the brand comparison from the imported brand plans', () => {
    const brand = TIERS.find((t) => t.id === 'starter')
    expect(brand).toBeDefined()
    const c = brandComparison()
    const agency = tierById('agency-starter')

    expect(c.brandUsdPerMonth).toBe(brand?.usdPerMonth)
    expect(c.brandPrompts).toBe(brand?.prompts)
    // The comparison is only honest if the brand plan divides the pool exactly.
    expect(c.clients).toBe(agency.pooledPrompts / c.brandPrompts)
    expect(Number.isInteger(c.clients)).toBe(true)
    expect(c.clients * c.brandPrompts).toBe(agency.pooledPrompts)
    expect(c.brandTotalUsd).toBe(c.clients * c.brandUsdPerMonth)
    expect(c.savingUsd).toBe(c.brandTotalUsd - agency.usdPerMonth)
    // Same prompts, less money — otherwise the tier has no reason to exist.
    expect(c.savingUsd).toBeGreaterThan(0)
  })

  it('names a featured tier that exists', () => {
    expect(tierById(FEATURED_ID).id).toBe(FEATURED_ID)
  })
})
