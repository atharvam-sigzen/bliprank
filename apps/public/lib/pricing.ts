/**
 * The published plans.
 *
 * DATA, NOT MARKUP — deliberately. A price and a cap that live inside JSX get
 * copy-pasted into a second page and then disagree with the first, and the one
 * a customer screenshots is always the wrong one. This is the only place either
 * number is written down.
 *
 * ⚠️ NOTHING HERE ENFORCES ANYTHING. There is no billing integration, no
 * metering, and no check that a workspace is inside its cap. This module
 * describes what is SOLD; the code that would hold a customer to it does not
 * exist yet, and a reader of this file should not assume otherwise.
 */

export interface Tier {
  readonly id: 'starter' | 'pro' | 'growth'
  readonly name: string
  readonly usdPerMonth: number
  /**
   * Tracked prompts, SHARED between the app's curated bank and the customer's
   * own. Not two allowances that happen to add up — one allowance, any split.
   * 15 curated + 0 custom and 0 curated + 15 custom are both a full Starter.
   */
  readonly prompts: number
  readonly forWhom: string
}

export const TIERS: readonly Tier[] = [
  { id: 'starter', name: 'Starter', usdPerMonth: 49, prompts: 15, forWhom: 'One brand, one category.' },
  { id: 'pro', name: 'Pro', usdPerMonth: 149, prompts: 40, forWhom: 'A brand with competitors worth watching.' },
  { id: 'growth', name: 'Growth', usdPerMonth: 349, prompts: 100, forWhom: 'Several categories, or an agency running a client.' },
]

/** What a tier buys: a daily re-check of every tracked prompt on every engine, once collection is scheduled. */
export const ENGINE_COUNT = 5
export const CHECKS_PER_DAY = (prompts: number): number => prompts * ENGINE_COUNT

/**
 * A worked split, for showing that the cap is one pool.
 *
 * Two thirds curated is not a rule and not a default — it is an EXAMPLE, and the
 * page says so. A page that shows one split without saying it is arbitrary is
 * read as a constraint.
 */
export const exampleSplit = (prompts: number): { curated: number; custom: number } => {
  const curated = Math.round(prompts * (2 / 3))
  return { curated, custom: prompts - curated }
}

/**
 * May another tracked prompt be added, if this workspace is being held to `tier`?
 *
 * Returns the refusal in words, or null to allow. In this module rather than in
 * the component for two reasons, and neither is tidiness: the cap is a statement
 * about the OFFER and every statement about the offer is written down here once;
 * and the component's version was reachable only through a click, which the SSR
 * test harness cannot make, so a rule about an allowance had no runnable check
 * behind it.
 *
 * ONE POOL, ANY SPLIT — the curated bank counts. `curated + custom` against the
 * cap is the whole rule; a check against `custom` alone would let a Starter
 * workspace carry 17 curated and 15 of its own and call it fifteen.
 *
 * `tier` undefined means no plan is being checked against, which is the default
 * and allows everything: there is no billing in this build and a cap presented
 * as a held allowance would describe a purchase that has not happened.
 */
export function capRefusal(tier: Tier | undefined, curated: number, custom: number): string | null {
  if (!tier) return null
  const total = curated + custom
  if (total < tier.prompts) return null
  return `${tier.name} allows ${tier.prompts} tracked prompts in total and this workspace already has ${total} — ${curated} curated plus ${custom} of your own. Remove one, or check against a larger plan.`
}
