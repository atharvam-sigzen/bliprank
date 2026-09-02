/**
 * THE VERSION PIN — alias derivation may not change without the stamp changing.
 *
 * ⚠️ WHY THIS FILE EXISTS. 0d4af7f (2026-09-01) changed what `domainBrandForms`
 * returns for one shape of domain — a prefix plus exactly four characters, with
 * a site title naming those four — and shipped it under the same `det-2` stamp
 * that 12408cc had introduced twenty-seven minutes earlier. The comment on the
 * constant says "bumped whenever a rule changes what an existing answer would
 * score", and nothing enforced it. ADR-0012 records why that particular lapse
 * was accepted as part of det-2's definition (a full-corpus check found zero
 * differing rows, and no record could ever reach the differing case) and sets
 * the bar for any future one. This test is the enforcement the comment lacked.
 *
 * HOW IT WORKS. A table of (host, title) inputs is pinned to the exact forms the
 * CURRENT version derives for them, keyed by that version. If the derivation
 * changes, an entry fails. If the version is bumped, the lookup fails until a
 * table for the new version is written — which is the moment to record what
 * changed, in the changelog, per R5. Either way the change cannot be silent.
 *
 * The rows are the seven synthetic cases from the ADR-0012 investigation plus
 * the two real domain-label subjects in the store, with their recorded titles.
 * Every title is invented or recorded; nothing here fetches anything.
 */

import { describe, expect, it } from 'vitest'
import { domainBrandForms, SCORING_ALGO_VERSION } from './score.js'

type Forms = ReturnType<typeof domainBrandForms>
type Pin = { readonly host: string; readonly title?: string; readonly forms: Forms; readonly why: string }

const PINNED: Readonly<Record<string, readonly Pin[]>> = {
  'det-2': [
    // The differing case: four-character remainder, title names it. 12408cc gave
    // {name:'getlago', aliases:['getlago'], squashedAliases:['getlago']}. det-2 as
    // DEFINED (ADR-0012) admits `lago` on the title's evidence.
    { host: 'getlago.com', title: 'Lago - Open Source Usage Based Billing', why: 'four-letter remainder, corroborated', forms: { name: 'Lago', aliases: ['getlago', 'Lago'], squashedAliases: ['getlago', 'lago'] } },
    { host: 'getlago.com', why: 'four-letter remainder, no title: refused', forms: { name: 'getlago', aliases: ['getlago'], squashedAliases: ['getlago'] } },
    { host: 'getlago.com', title: 'Alternatives to Stripe Billing and Chargebee', why: 'four-letter remainder, title names a rival: refused', forms: { name: 'getlago', aliases: ['getlago'], squashedAliases: ['getlago'] } },
    { host: 'google.com', title: 'Google', why: '"ogle" stays refused under every title', forms: { name: 'Google', aliases: ['google', 'Google'], squashedAliases: ['google'] } },
    { host: 'thecosmicbyte.com', why: 'ten-letter remainder, trusted on length', forms: { name: 'thecosmicbyte', aliases: ['thecosmicbyte'], squashedAliases: ['thecosmicbyte', 'cosmicbyte'] } },
    { host: 'thecosmicbyte.com', title: 'Cosmic Byte - Gaming Gear', why: 'title corroborates the trusted remainder into a trading name', forms: { name: 'Cosmic Byte', aliases: ['thecosmicbyte', 'Cosmic Byte'], squashedAliases: ['thecosmicbyte', 'cosmicbyte'] } },
    { host: 'usebubbles.com', why: 'seven-letter remainder, trusted on length', forms: { name: 'usebubbles', aliases: ['usebubbles'], squashedAliases: ['usebubbles', 'bubbles'] } },
    { host: 'mybank.com', title: 'Bank of Somewhere', why: 'second four-letter case: `my` + `bank`, corroborated', forms: { name: 'Bank', aliases: ['mybank', 'Bank'], squashedAliases: ['mybank', 'bank'] } },
    // The two real domain-label subjects in the store, with their RECORDED titles.
    { host: 'sigzen.com', title: 'Sigzen', why: 'stored subject; no prefix, so no remainder', forms: { name: 'Sigzen', aliases: ['sigzen', 'Sigzen'], squashedAliases: ['sigzen'] } },
  ],
}

describe(`alias derivation is pinned to SCORING_ALGO_VERSION (${SCORING_ALGO_VERSION})`, () => {
  it('the current version has a pinned table — a bump must bring a new one', () => {
    // Bumping the constant makes this fail on purpose. Write the table for the
    // new version, and the changelog row that explains the differences.
    expect(Object.keys(PINNED)).toContain(SCORING_ALGO_VERSION)
  })

  for (const pin of PINNED[SCORING_ALGO_VERSION] ?? []) {
    it(`${pin.host} · title=${JSON.stringify(pin.title ?? null)} · ${pin.why}`, () => {
      expect(domainBrandForms(pin.host, pin.title)).toEqual(pin.forms)
    })
  }
})
