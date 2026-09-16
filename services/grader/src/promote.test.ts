/**
 * The two refusals the RUNNER owns, both found by re-reading this module after
 * it had already shipped and passed review.
 *
 *   (A) The corpus is unprompted answers only. Feeding promotion every prompt in
 *       a bank admits the 190 prompts across the hand-authored taxonomy that
 *       name a brand by construction, and a brand named in the question is
 *       guaranteed a mention in the answer.
 *
 *   (B) A promotion only reaches a GENERATED bank. Writing one for a
 *       hand-authored category reported a success that nothing read.
 */

import { describe, expect, it } from 'vitest'
import { DEMO_BANKS } from '@bliprank/taxonomy'
import { UNPROMPTED_INTENTS } from './scan.js'
import { readGeneratedBanks } from './resolve-category.js'
import { parsePromoteArgs } from './promote.js'

describe('the corpus filter — evidence may not be something we asked for', () => {
  it('⚠️ the hand-authored taxonomy is full of prompts that name a brand', () => {
    // The reason (A) matters. If this ever reaches zero the filter is still
    // right, but the risk it guards has changed and somebody should know.
    const all = DEMO_BANKS.flatMap((b) => b.prompts)
    const naming = all.filter((p) => !(UNPROMPTED_INTENTS as readonly string[]).includes(p.intent))
    expect(naming.length).toBeGreaterThan(100)
    expect(naming.some((p) => /HubSpot|Salesforce|Pipedrive/i.test(p.text))).toBe(true)
  })

  it('the unprompted filter is the same one the scan applies', () => {
    // One definition of "a prompt that names no brand", shared with `runScan`
    // PROPERTY 2. A second list here would drift, and the direction it drifts is
    // toward admitting evidence we supplied ourselves.
    expect([...UNPROMPTED_INTENTS]).toEqual(['discovery', 'problem-led'])
    for (const bank of DEMO_BANKS) {
      const unprompted = bank.prompts.filter((p) => (UNPROMPTED_INTENTS as readonly string[]).includes(p.intent))
      expect(unprompted.length).toBeLessThan(bank.prompts.length)
      expect(unprompted.every((p) => p.intent === 'discovery' || p.intent === 'problem-led')).toBe(true)
    }
  })
})

describe('which banks a promotion may touch', () => {
  it('⚠️ the hand-authored banks are not generated ones, so promotion must refuse them', () => {
    // The condition the runner refuses on. `readGeneratedBanks` over a data dir
    // with no generated-banks directory is empty, so every DEMO bank fails the
    // membership test — which is exactly the refusal.
    const generated = readGeneratedBanks('does-not-exist')
    expect(generated).toEqual([])
    for (const bank of DEMO_BANKS) expect(generated.some((g) => g.bank.category === bank.category)).toBe(false)
  })
})

describe('the argument parser', () => {
  it('refuses without a category, and reads the refusals as a list', () => {
    expect('refuse' in parsePromoteArgs([])).toBe(true)
    const parsed = parsePromoteArgs(['--category', 'erp-software', '--exclude', 'Shopify, ERPNext', '--apply'])
    if ('refuse' in parsed) throw new Error(parsed.refuse)
    expect(parsed.exclude).toEqual(['Shopify', 'ERPNext'])
    expect(parsed.apply).toBe(true)
  })

  it('an absent --exclude is an empty list, not a list holding one empty name', () => {
    // `''.split(',')` is `['']`, and an empty name would squash to '' and match
    // every candidate whose name also squashed to nothing. Filtered.
    const parsed = parsePromoteArgs(['--category', 'x'])
    if ('refuse' in parsed) throw new Error(parsed.refuse)
    expect(parsed.exclude).toEqual([])
  })

  it('refuses a threshold that is not a positive integer', () => {
    expect('refuse' in parsePromoteArgs(['--category', 'x', '--min-engines', '0'])).toBe(true)
    expect('refuse' in parsePromoteArgs(['--category', 'x', '--min-answers', 'lots'])).toBe(true)
  })
})
