/**
 * The published AGENCY plans, and the division that decides whether they work.
 *
 * DATA, NOT MARKUP — the same rule as `pricing.ts`, for the same reason. But
 * this file carries a second obligation the brand plans do not have.
 *
 * ⚠️ NO AGENCY TIER FUNDS A FULL CYCLE FOR EVERY DOMAIN IT ALLOWS. That is
 * deliberate, it is the shape of the offer, and it is the one fact a buyer
 * running forty clients will work out in their head within a minute of reading
 * the page. So every derived figure on that page is COMPUTED HERE from the tier
 * data — never typed as a literal into JSX — because a hardcoded "13.3" survives
 * a price change and quietly becomes a lie. `agency-pricing.test.ts` asserts the
 * shortfall still exists; if a future edit makes a tier sufficient, that test
 * fails and the copy gets rewritten rather than silently becoming wrong.
 *
 * ⚠️ NOTHING HERE ENFORCES ANYTHING. There are no agency accounts, no billing,
 * no metering, and no code anywhere in this product that holds a portfolio to a
 * domain ceiling or a prompt pool. This module describes what is SOLD.
 */

import { TIERS } from './pricing'
import { PROMPTS_PER_CYCLE } from './workspace'

export interface AgencyTier {
  readonly id: 'agency-starter' | 'agency-growth' | 'agency-scale'
  readonly name: string
  readonly usdPerMonth: number
  /** The domain CEILING. How many clients may sit in the portfolio at once. */
  readonly domains: number
  /**
   * The pooled prompts, shared across the whole portfolio. This is what
   * actually funds collection; the domain count only says how many places
   * there are to spend it.
   */
  readonly pooledPrompts: number
  readonly forWhom: string
}

export const AGENCY_TIERS: readonly AgencyTier[] = [
  {
    id: 'agency-starter',
    name: 'Agency Starter',
    usdPerMonth: 199,
    domains: 5,
    pooledPrompts: 75,
    forWhom: 'A small book of clients, watched rather than reported on weekly.',
  },
  {
    id: 'agency-growth',
    name: 'Agency Growth',
    usdPerMonth: 499,
    domains: 15,
    pooledPrompts: 200,
    forWhom: 'A retainer practice where visibility is a line on the invoice.',
  },
  {
    id: 'agency-scale',
    name: 'Agency Scale',
    usdPerMonth: 999,
    domains: 40,
    pooledPrompts: 500,
    forWhom: 'A portfolio large enough that depth has to be allocated, not assumed.',
  },
]

/** The featured plan, named once so the page and the tests agree on it. */
export const FEATURED_ID: AgencyTier['id'] = 'agency-growth'

export interface AgencyMaths {
  /** pooledPrompts ÷ domains — what each client gets if the pool is split evenly. */
  readonly promptsPerDomain: number
  /** promptsPerDomain, to one decimal, exactly as the page prints it. */
  readonly promptsPerDomainLabel: string
  /** True only if an even split would fund a full unprompted cycle each. */
  readonly fundsFullCycle: boolean
  /** How many prompts short of a full cycle each client is, under an even split. */
  readonly shortfallPerDomain: number
  /** domains × PROMPTS_PER_CYCLE — what the ceiling would cost at full depth. */
  readonly promptsForFullOccupancy: number
  /** How many clients the pool DOES fund at full depth, if depth is not shared. */
  readonly domainsAtFullCycle: number
  /** An even split rounded down to whole prompts — the allocation an agency can actually make. */
  readonly evenSplit: number
  /** usdPerMonth ÷ domains, at the ceiling. */
  readonly usdPerDomain: string
  /** usdPerMonth ÷ pooledPrompts. */
  readonly usdPerPrompt: string
}

/**
 * Every figure the agency pricing page states, derived from one tier.
 *
 * Money is returned as a fixed-2 STRING rather than a number: the page prints
 * these, a float printed raw gives "33.266666666666666", and rounding at the
 * call site is how two surfaces end up disagreeing by a cent.
 */
export function agencyMaths(t: AgencyTier): AgencyMaths {
  const promptsPerDomain = t.pooledPrompts / t.domains
  return {
    promptsPerDomain,
    promptsPerDomainLabel: promptsPerDomain.toFixed(1),
    fundsFullCycle: promptsPerDomain >= PROMPTS_PER_CYCLE,
    shortfallPerDomain: PROMPTS_PER_CYCLE - promptsPerDomain,
    promptsForFullOccupancy: t.domains * PROMPTS_PER_CYCLE,
    domainsAtFullCycle: Math.floor(t.pooledPrompts / PROMPTS_PER_CYCLE),
    evenSplit: Math.floor(t.pooledPrompts / t.domains),
    usdPerDomain: (t.usdPerMonth / t.domains).toFixed(2),
    usdPerPrompt: (t.usdPerMonth / t.pooledPrompts).toFixed(2),
  }
}

export const tierById = (id: AgencyTier['id']): AgencyTier => {
  const t = AGENCY_TIERS.find((x) => x.id === id)
  if (!t) throw new Error(`no agency tier ${id}`)
  return t
}

export interface BrandComparison {
  readonly brandName: string
  readonly brandUsdPerMonth: number
  readonly brandPrompts: number
  /** How many brand plans it takes to buy the agency tier's pool. */
  readonly clients: number
  /** clients × brandUsdPerMonth — the same prompts, bought one account at a time. */
  readonly brandTotalUsd: number
  readonly agencyName: string
  readonly agencyUsdPerMonth: number
  readonly pooledPrompts: number
  readonly savingUsd: number
}

/**
 * Why the agency tier exists at all, in the buyer's own arithmetic.
 *
 * The brand figures are IMPORTED, not restated. If Starter moves from $49 the
 * comparison moves with it, or the test fails — either is better than a page
 * that quotes a price the pricing page no longer charges.
 *
 * Only stated where it is honest: the brand plan's prompts must divide the pool
 * exactly, otherwise "the same 75" is not the same 75.
 */
export function brandComparison(): BrandComparison {
  const brand = TIERS.find((t) => t.id === 'starter')
  if (!brand) throw new Error('no brand starter tier')
  const agency = tierById('agency-starter')
  const clients = agency.pooledPrompts / brand.prompts
  const brandTotalUsd = clients * brand.usdPerMonth
  return {
    brandName: brand.name,
    brandUsdPerMonth: brand.usdPerMonth,
    brandPrompts: brand.prompts,
    clients,
    brandTotalUsd,
    agencyName: agency.name,
    agencyUsdPerMonth: agency.usdPerMonth,
    pooledPrompts: agency.pooledPrompts,
    savingUsd: brandTotalUsd - agency.usdPerMonth,
  }
}

export { PROMPTS_PER_CYCLE }
