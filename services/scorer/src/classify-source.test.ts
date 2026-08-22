import { describe, expect, it } from 'vitest'
import type { Citation } from '@bliprank/contracts'
import { classifyCitation, classifyCitations, parseTimestamp, sourceMix, type ClassifierRegistry } from './classify-source.js'
import { registrableDomain, isOnDomain } from './domain.js'

const REG: ClassifierRegistry = {
  ownedDomains: ['hubspot.com'],
  competitorDomains: { Salesforce: ['salesforce.com'], 'Zoho CRM': ['zoho.com', 'zoho.in'] },
  publishers: { 'techcrunch.com': 'TechCrunch', 'forbes.com': 'Forbes' },
}
const cite = (url: string, position = 0, meta?: Citation['meta']): Citation => ({ url, position, ...(meta ? { meta } : {}) })
const classOf = (url: string, meta?: Citation['meta']) => classifyCitation(cite(url, 0, meta), REG).sourceClass

describe('registrable domain', () => {
  it('strips subdomains and www', () => {
    expect(registrableDomain('https://docs.hubspot.com/x')).toBe('hubspot.com')
    expect(registrableDomain('https://www.g2.com/')).toBe('g2.com')
  })
  it('handles the multi-label suffixes in our markets', () => {
    expect(registrableDomain('https://shop.example.co.uk/a')).toBe('example.co.uk')
    expect(registrableDomain('https://blog.example.com.au')).toBe('example.com.au')
    expect(registrableDomain('https://x.example.co.in')).toBe('example.co.in')
  })
  it('returns empty for an unparseable url rather than guessing', () => {
    expect(registrableDomain('not a url')).toBe('')
  })
  it('isOnDomain matches subdomains but not lookalikes', () => {
    expect(isOnDomain('https://api.hubspot.com/v1', 'hubspot.com')).toBe(true)
    expect(isOnDomain('https://hubspot.com.evil.example/x', 'hubspot.com')).toBe(false)
    expect(isOnDomain('https://nothubspot.com/x', 'hubspot.com')).toBe(false)
  })
})

describe('classification precedence — identity before platform', () => {
  it('owned wins even on a platform domain', () => {
    const reg: ClassifierRegistry = { ...REG, ownedDomains: ['hubspot.com', 'youtube.com/@hubspot'] }
    expect(classifyCitation(cite('https://blog.hubspot.com/crm-guide'), reg).sourceClass).toBe('owned')
  })
  it('a competitor domain is `competitor`, and names which one', () => {
    const c = classifyCitation(cite('https://www.zoho.in/crm/'), REG)
    expect(c.sourceClass).toBe('competitor')
    expect(c.detail.competitor).toBe('Zoho CRM')
  })
  it('a competitor beats the publisher registry', () => {
    const reg: ClassifierRegistry = { ...REG, publishers: { 'salesforce.com': 'Salesforce Blog' } }
    expect(classifyCitation(cite('https://salesforce.com/news'), reg).sourceClass).toBe('competitor')
  })
})

describe('platform classes and their extracted detail', () => {
  it('video: platform, id and timestamp from the URL', () => {
    const c = classifyCitation(cite('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90'), REG)
    expect(c.sourceClass).toBe('video')
    expect(c.detail).toMatchObject({ platform: 'youtube', videoId: 'dQw4w9WgXcQ', timestamp: 90 })
  })
  it('video: youtu.be short links and /shorts/ paths', () => {
    expect(classifyCitation(cite('https://youtu.be/abc123'), REG).detail.videoId).toBe('abc123')
    expect(classifyCitation(cite('https://www.youtube.com/shorts/xyz789'), REG).detail.videoId).toBe('xyz789')
  })
  it("video: the provider's own marker wins over the URL — it may name a chapter", () => {
    const c = classifyCitation(cite('https://www.youtube.com/watch?v=a&t=10', 0, { timestamp: 'chapter-3' }), REG)
    expect(c.detail.timestamp).toBe('chapter-3')
  })
  it('community: subreddit and thread id', () => {
    const c = classifyCitation(cite('https://www.reddit.com/r/smallbusiness/comments/abc123/best_crm/'), REG)
    expect(c.sourceClass).toBe('community')
    expect(c.detail).toMatchObject({ platform: 'reddit', subCommunity: 'r/smallbusiness', threadId: 'abc123' })
  })
  it('community: stack exchange question id', () => {
    const c = classifyCitation(cite('https://stackoverflow.com/questions/12345/how-to'), REG)
    expect(c.detail).toMatchObject({ platform: 'stackoverflow', threadId: '12345' })
  })
  it('review: platform and listing id', () => {
    expect(classifyCitation(cite('https://www.g2.com/products/hubspot-crm/reviews'), REG).detail).toMatchObject({ platform: 'g2', listingId: 'hubspot-crm' })
    expect(classifyCitation(cite('https://www.capterra.com/p/135464/HubSpot-CRM/'), REG).detail).toMatchObject({ platform: 'capterra', listingId: '135464' })
  })
  it('reference: wikipedia, standards bodies and government suffixes', () => {
    expect(classOf('https://en.wikipedia.org/wiki/CRM')).toBe('reference')
    expect(classOf('https://www.w3.org/TR/html/')).toBe('reference')
    expect(classOf('https://www.irs.gov/businesses')).toBe('reference')
    expect(classOf('https://www.gov.uk/guidance/vat')).toBe('reference')
  })
  it('earned_media only via the authority registry', () => {
    expect(classOf('https://techcrunch.com/2026/01/02/crm/')).toBe('earned_media')
    expect(classifyCitation(cite('https://forbes.com/x'), REG).detail.publisher).toBe('Forbes')
  })
})

describe('ADR-0005 constraint: `other` is never silently reclassified', () => {
  it('an unrecognised domain is `other`', () => {
    expect(classOf('https://some-blog.example/best-crm')).toBe('other')
  })

  it("a provider-supplied publisher name does NOT promote an unknown domain to earned_media", () => {
    // Otherwise the class would depend on which provider collected the run,
    // and the same URL would classify differently across collection paths.
    const c = classifyCitation(cite('https://random.example/x', 0, { publisher: 'Totally Real News' }), REG)
    expect(c.sourceClass).toBe('other')
    expect(c.detail.publisher).toBe('Totally Real News') // recorded, not acted on
  })

  it('a domain merely CONTAINING the brand name is never `owned`', () => {
    expect(classOf('https://hubspot-reviews.example/hubspot')).toBe('other')
    expect(classOf('https://hubspot.com.phishing.example/')).toBe('other')
  })

  it('an unparseable URL is `other`, not owned', () => {
    expect(classOf('javascript:alert(1)')).toBe('other')
    expect(classOf('')).toBe('other')
  })

  it('there is no input for which an unlisted domain reaches `owned`', () => {
    const hostile = [
      'https://hubspot.com@evil.example/x',
      'https://evil.example/?u=hubspot.com',
      'https://evil.example/#hubspot.com',
      'https://xn--hubspt-5wa.com/',
    ]
    for (const u of hostile) expect(classOf(u), u).not.toBe('owned')
  })
})

describe('parseTimestamp', () => {
  it('reads the forms YouTube actually emits', () => {
    expect(parseTimestamp('90')).toBe(90)
    expect(parseTimestamp('1m30s')).toBe(90)
    expect(parseTimestamp('1h2m3s')).toBe(3723)
    expect(parseTimestamp('01:30')).toBe(90)
    expect(parseTimestamp('1:01:30')).toBe(3690)
  })
  it('returns undefined rather than 0 for nonsense — 0 is a real timestamp', () => {
    expect(parseTimestamp('banana')).toBeUndefined()
    expect(parseTimestamp(null)).toBeUndefined()
    expect(parseTimestamp('0')).toBe(0)
  })
})

describe('sourceMix', () => {
  it('counts every class, including the zeroes', () => {
    const mix = sourceMix(
      classifyCitations(
        [cite('https://hubspot.com/a', 0), cite('https://reddit.com/r/x/comments/1/t', 1), cite('https://unknown.example/y', 2)],
        REG,
      ),
    )
    expect(mix).toEqual({ owned: 1, video: 0, community: 1, review: 0, earned_media: 0, competitor: 0, reference: 0, other: 1 })
  })
})
