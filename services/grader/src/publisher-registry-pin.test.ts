/**
 * ⚠️ THE REGISTRY IS A SCORING RULE NOW, SO IT IS PINNED LIKE ONE.
 *
 * `source-class-pin.test.ts` freezes `PLATFORM_TABLES` byte-exact under
 * `SCORING_ALGO_VERSION`, on the stated reasoning that "an entry in a table is a
 * rule, and one added domain changes what an existing answer scores". Since
 * det-3 that is true of `PUBLISHER_REGISTRY` and nothing enforced it: adding a
 * 53rd domain tomorrow would change what a stored answer scores, both cycles
 * would stamp `det-3`, `compare()` could not see the difference, and a published
 * source-mix share would rebase silently. That is the exact failure R5 exists to
 * prevent, moved out of the classifier and into its data.
 *
 * Found by `stats-reviewer` on the det-3 bump, not by a failing test.
 *
 * It lives in `services/grader` for the same reason the wiring guard does:
 * checking it needs `@bliprank/taxonomy`, and `services/scorer` does not depend
 * on it and should not.
 *
 * ⚠️ WHEN THIS FAILS, THE FIX IS A VERSION BUMP, NOT A NEW HASH. Adding or
 * removing an outlet is a scoring rule change: run `/score-version`, take the
 * snapshot first, and put the flip list in the changelog. Updating the constant
 * below without doing that is the silent rebase this file exists to stop.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PUBLISHERS, PUBLISHER_REGISTRY } from '@bliprank/taxonomy'
import { SCORING_ALGO_VERSION } from '@bliprank/scorer'

/** The exact domain set each version scores with. Sorted, so ordering is not a rule. */
const PINNED: Readonly<Record<string, { readonly count: number; readonly sha256: string }>> = {
  'det-3': { count: 52, sha256: '4ee8ec50f584528c482a48df14bc5d082b5934f40e2a7038f381afb6d7a77d9c' },
}

const fingerprint = (): string => createHash('sha256').update(Object.keys(PUBLISHER_REGISTRY).sort().join('\n')).digest('hex')

describe(`the publisher registry is pinned to ${SCORING_ALGO_VERSION}`, () => {
  it('the current version has a pinned registry — a bump must bring one', () => {
    expect(Object.keys(PINNED)).toContain(SCORING_ALGO_VERSION)
  })

  it('⚠️ the exact set of domains is what this version says it is', () => {
    const pin = PINNED[SCORING_ALGO_VERSION]!
    expect(Object.keys(PUBLISHER_REGISTRY)).toHaveLength(pin.count)
    expect(fingerprint()).toBe(pin.sha256)
  })

  it('the registry and the list it is built from cannot drift apart', () => {
    expect(Object.keys(PUBLISHER_REGISTRY).sort()).toEqual(PUBLISHERS.map((p) => p.domain).sort())
  })
})
