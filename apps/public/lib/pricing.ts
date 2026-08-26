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
