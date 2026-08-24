import { describe, expect, it } from 'vitest'
import { classifyDomain, hostTokens, isOnDomain, normaliseHost } from './classify-domain.js'
import { DEMO_TAXONOMY } from './taxonomy.js'
import type { PromptBank } from './types.js'

/**
 * Fixture banks, not the shipped ones. This file tests the ALGORITHM; the real
 * taxonomy and the real banks get their own suite in `demo-banks.test.ts`, so a
 * bank edit cannot quietly change what the classifier is proven to do.
 */
const bank = (category: string, leaders: PromptBank['leaders']): PromptBank => ({
  category,
  displayName: category,
  description: '',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note: 'fixture',
  leaders,
  prompts: [],
})

const BANKS: readonly PromptBank[] = [
  bank('crm-software', [
    { id: 'hubspot', name: 'HubSpot', aliases: ['hubspot'], domains: ['hubspot.com'] },
    { id: 'zoho', name: 'Zoho CRM', aliases: ['zoho crm'], domains: ['zoho.com'] },
  ]),
  bank('accounting-software', [
    { id: 'xero', name: 'Xero', aliases: ['xero'], domains: ['xero.com'] },
    { id: 'zohobooks', name: 'Zoho Books', aliases: ['zoho books'], domains: ['zoho.com', 'books.zoho.com'] },
  ]),
  bank('ecommerce-platforms', [{ id: 'shopify', name: 'Shopify', aliases: ['shopify'], domains: ['shopify.com'] }]),
]

const classify = (d: string) => classifyDomain(d, BANKS, DEMO_TAXONOMY)

describe('normaliseHost', () => {
  it('strips scheme, www, path, port, query and the root-zone trailing dot', () => {
    for (const input of [
      'https://www.hubspot.com/products/crm?x=1',
      'HubSpot.com',
      'http://hubspot.com:8080',
      'hubspot.com.',
      '  hubspot.com/  ',
    ]) {
      expect([input, normaliseHost(input)]).toEqual([input, 'hubspot.com'])
    }
  })

  it('rejects anything not shaped like a hostname', () => {
    for (const bad of ['', '   ', 'localhost', 'not a domain', '.com', 'a.b', '256', 'http://', 'a..b.com']) {
      expect([bad, normaliseHost(bad)]).toEqual([bad, ''])
    }
  })

  it('a pasted FILENAME is well-formed and is caught by classification, not by shape', () => {
    // `hello.txt` and `report.pdf` are syntactically valid hostnames — `.txt` is
    // only "not a TLD" if you carry a TLD list, and that is 1,500 entries to
    // improve an error message. Verified against the Grader's own input regex,
    // whose comment claims it was hardened against this exact string and is not.
    //
    // The protection that actually matters is downstream and holds regardless:
    // an unclassified domain has no category, so it has no bank, so no cycle is
    // ever published and nothing is spent. Refusing to classify IS the guard.
    expect(normaliseHost('hello.txt')).toBe('hello.txt')
    expect(classify('hello.txt')).toMatchObject({ status: 'unclassified' })
    expect(classify('report.pdf')).toMatchObject({ status: 'unclassified' })
  })
})

describe('isOnDomain', () => {
  it('matches the apex and any subdomain, and nothing else', () => {
    expect(isOnDomain('hubspot.com', 'hubspot.com')).toBe(true)
    expect(isOnDomain('blog.hubspot.com', 'hubspot.com')).toBe(true)
    expect(isOnDomain('nothubspot.com', 'hubspot.com')).toBe(false)
    expect(isOnDomain('hubspot.com.evil.test', 'hubspot.com')).toBe(false)
  })

  it('an empty domain matches nothing', () => {
    // One trailing comma in an imported domain list is enough to produce '',
    // and endsWith('.') would then match every host. The scorer shipped this
    // bug once and it made `cited` true for arbitrary third-party URLs.
    expect(isOnDomain('anything.com', '')).toBe(false)
    expect(isOnDomain('anything.com', '  ')).toBe(false)
    expect(isOnDomain('', 'hubspot.com')).toBe(false)
  })
})

describe('hostTokens', () => {
  it('splits on dots and hyphens and keeps the public suffix', () => {
    expect(hostTokens('my-crm.co.uk')).toEqual(['my', 'crm', 'co', 'uk'])
    // The TLD is a legitimate signal in its own right, which is why no public
    // suffix list is needed: `.shop` says something true about the site.
    expect(hostTokens('acme.shop')).toEqual(['acme', 'shop'])
  })
})

describe('signal 1 — a known leader domain', () => {
  it('classifies the apex and its subdomains', () => {
    expect(classify('hubspot.com')).toEqual({ status: 'classified', slug: 'crm-software', signal: 'leader-domain', evidence: 'hubspot.com' })
    expect(classify('https://blog.hubspot.com/x')).toMatchObject({ status: 'classified', slug: 'crm-software' })
  })

  it('a brand outranks a keyword in the same string', () => {
    // shopify.com is ecommerce because it IS Shopify, not because of any token.
    expect(classify('shopify.com')).toMatchObject({ status: 'classified', slug: 'ecommerce-platforms', signal: 'leader-domain' })
  })

  it('THE AMBIGUOUS CASE: a brand that leads more than one category is not resolved', () => {
    // Zoho leads CRM, accounting and HR. Microsoft and Adobe are the same shape.
    // Picking one would be inventing a fact, and the fact it invents silently
    // changes comparison_basis for every number that follows.
    expect(classify('zoho.com')).toEqual({
      status: 'ambiguous',
      candidates: ['accounting-software', 'crm-software'],
      signal: 'leader-domain',
      evidence: 'zoho.com',
    })
  })

  it('the longest matching domain wins the evidence line', () => {
    const r = classify('books.zoho.com')
    // Both `zoho.com` and `books.zoho.com` match; the more specific one is the
    // more informative thing to report back.
    expect(r).toMatchObject({ status: 'ambiguous' })
    if (r.status === 'ambiguous') expect(r.evidence).toContain('books.zoho.com')
  })
})

describe('signal 2 — a whole token of the host', () => {
  it('classifies a hyphen or dot delimited keyword', () => {
    expect(classify('my-crm.io')).toEqual({ status: 'classified', slug: 'crm-software', signal: 'domain-token', evidence: 'crm' })
    expect(classify('crm.example.com')).toMatchObject({ status: 'classified', slug: 'crm-software' })
    expect(classify('acme.shop')).toMatchObject({ status: 'classified', slug: 'ecommerce-platforms', evidence: 'shop' })
  })

  it('THE FINDING THIS PREVENTS: a concatenated label is never segmented', () => {
    // Substring matching is how compass.com becomes a password manager and
    // chronos.io becomes an HR product. A conservative miss is recoverable; a
    // confident wrong category is not.
    expect(classify('compass.com')).toMatchObject({ status: 'unclassified' })
    expect(classify('chronos.io')).toMatchObject({ status: 'unclassified' })
    expect(classify('mycrm.com')).toMatchObject({ status: 'unclassified' })
    expect(classify('scrmble.com')).toMatchObject({ status: 'unclassified' })
  })

  it('two categories keyed by one host is ambiguous, not a coin toss', () => {
    const r = classify('payroll-invoices.com')
    expect(r).toMatchObject({ status: 'ambiguous', signal: 'domain-token' })
    if (r.status === 'ambiguous') expect(r.candidates).toEqual(['accounting-software', 'hr-payroll-software'])
  })
})

describe('there is no default category and no fallback', () => {
  it('an unknown domain is unclassified, with a reason', () => {
    const r = classify('acme.com')
    expect(r).toEqual({ status: 'unclassified', reason: 'no known brand and no category keyword in the domain' })
  })

  it('a malformed input is unclassified rather than throwing', () => {
    expect(classify('not a domain')).toEqual({ status: 'unclassified', reason: 'not a domain' })
    expect(classify('')).toEqual({ status: 'unclassified', reason: 'not a domain' })
  })

  it('an empty taxonomy and empty banks classify nothing at all', () => {
    // The guard against a wiring bug that quietly returns the first category.
    expect(classifyDomain('hubspot.com', [], [])).toMatchObject({ status: 'unclassified' })
    expect(classifyDomain('my-crm.io', BANKS, [])).toMatchObject({ status: 'unclassified' })
  })
})

describe('determinism — the property the metric contract depends on', () => {
  it('the same host always yields the identical result', () => {
    // If this ever varies, the same domain lands in different banks on different
    // days and comparison_basis changes underneath the customer — the exact
    // change compare() exists to refuse.
    for (const d of ['hubspot.com', 'zoho.com', 'my-crm.io', 'acme.com', 'payroll-invoices.com']) {
      const runs = Array.from({ length: 5 }, () => JSON.stringify(classify(d)))
      expect(new Set(runs).size).toBe(1)
    }
  })

  it('candidate order does not depend on bank order', () => {
    const forward = classifyDomain('zoho.com', BANKS, DEMO_TAXONOMY)
    const reversed = classifyDomain('zoho.com', [...BANKS].reverse(), DEMO_TAXONOMY)
    expect(forward).toEqual(reversed)
  })
})
