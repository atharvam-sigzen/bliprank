import { describe, expect, it } from 'vitest'
import { DEMO_BANKS, DEMO_TAXONOMY, FALLBACK_SLUG, classifyDomain, looksLikeFilename, normaliseHost } from './index.js'

/**
 * WHAT A TYPED DOMAIN ACTUALLY DOES — the whole decision table, on one screen.
 *
 * The point of this is the two columns nobody can infer from the classifier
 * alone: whether the input SPENDS, and where it lands if it does. Since the
 * no-category-no-spend guard was traded away, "does this cost a scan" is a
 * question about every string a visitor can type, and it now has to be answered
 * by looking rather than by reasoning.
 */
describe('the classification decision table', () => {
  const DOMAINS = [
    'pipedrive.com',
    'zendesk.com',
    'wix.com',
    'semrush.com',
    'zoom.us',
    'docusign.com',
    'mixpanel.com',
    'my-crm.io',
    'zoho.com',
    'hubspot.com',
    'stripe.com',
    'nike.com',
    'bbc.co.uk',
    'openai.com',
    'bliprank.com',
    'report.pdf',
    'hello.txt',
    'archive.zip',
    'acme',
    'a.b',
  ]

  const outcome = (d: string): { spends: boolean; lands: string } => {
    const c = classifyDomain(d, DEMO_BANKS, DEMO_TAXONOMY)
    if (normaliseHost(d) === '' || looksLikeFilename(d)) return { spends: false, lands: 'REFUSED (not a domain)' }
    if (c.status === 'classified') return { spends: true, lands: c.slug }
    return { spends: true, lands: `${FALLBACK_SLUG} (${c.status})` }
  }

  it('prints the table', () => {
    console.log(
      '\n' +
        DOMAINS.map((d) => {
          const o = outcome(d)
          return `${d.padEnd(16)} ${o.spends ? 'SPENDS' : 'free  '}  ${o.lands}`
        }).join('\n'),
    )
    expect(DOMAINS.length).toBeGreaterThan(0)
  })

  it('EVERY real domain lands somewhere — no dead ends', () => {
    const real = DOMAINS.filter((d) => normaliseHost(d) !== '' && !looksLikeFilename(d))
    for (const d of real) expect([d, outcome(d).lands]).not.toEqual([d, 'REFUSED (not a domain)'])
    // And the ones that are not domains are all still free.
    const junk = DOMAINS.filter((d) => !real.includes(d))
    expect(junk.sort()).toEqual(['a.b', 'acme', 'archive.zip', 'hello.txt', 'report.pdf'])
    for (const d of junk) expect([d, outcome(d).spends]).toEqual([d, false])
  })
})
