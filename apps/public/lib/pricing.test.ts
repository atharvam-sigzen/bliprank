import { describe, expect, it } from 'vitest'
import { TIERS, capRefusal } from './pricing'

const tier = (id: string) => TIERS.find((t) => t.id === id)!

describe('the prompt cap, when a workspace is being held to a plan', () => {
  it('allows everything when no plan is being checked against', () => {
    // The default, and the behaviour that shipped before the checker existed.
    // There is no billing in this build, so a cap presented as a held allowance
    // would describe a purchase that has not happened.
    expect(capRefusal(undefined, 17, 500)).toBeNull()
  })

  it('counts the curated bank against the same pool', () => {
    // One pool, any split. Checking `custom` alone would let a Starter carry 17
    // curated plus 15 of its own and call it fifteen.
    const starter = tier('starter')
    expect(starter.prompts).toBe(15)
    expect(capRefusal(starter, 17, 0)).not.toBeNull()
    expect(capRefusal(starter, 0, 14)).toBeNull()
    expect(capRefusal(starter, 0, 15)).not.toBeNull()
  })

  it('refuses AT the cap, not past it — the check runs before the add', () => {
    const pro = tier('pro')
    expect(capRefusal(pro, 17, pro.prompts - 17 - 1)).toBeNull()
    expect(capRefusal(pro, 17, pro.prompts - 17)).not.toBeNull()
  })

  it('names the plan and the arithmetic, so the refusal is actionable', () => {
    const message = capRefusal(tier('starter'), 17, 0)!
    expect(message).toContain('Starter')
    expect(message).toContain('15')
    expect(message).toContain('17 curated')
  })

  it('a bigger plan admits what a smaller one refused', () => {
    expect(capRefusal(tier('starter'), 17, 0)).not.toBeNull()
    expect(capRefusal(tier('growth'), 17, 0)).toBeNull()
  })
})
