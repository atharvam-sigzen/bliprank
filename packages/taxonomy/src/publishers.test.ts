import { describe, expect, it } from 'vitest'
// Relative on purpose: the taxonomy package does not depend on the scorer, and must not; this test only reads its tables.
import { PLATFORM_TABLES } from '../../../services/scorer/src/classify-source.js'
import { DEMO_BANKS } from './banks/index.js'
import { NOT_PUBLISHERS, PUBLISHERS, PUBLISHER_REGISTRY } from './publishers.js'

/**
 * The registry is a list of claims; these are the checks a claim has to pass
 * before it can be one. None of this is the scoring rule — wiring the map into
 * scoring is a version bump (ADR-0015) — but a malformed entry would be a
 * wrong rule the day it is wired, so it is refused now.
 */
describe('every publisher entry is well-formed and reasoned', () => {
  it('domains are registrable, lower-case, unique, and never a www or a path', () => {
    const seen = new Set<string>()
    for (const p of PUBLISHERS) {
      expect(p.domain, p.name).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/)
      expect(p.domain.startsWith('www.'), p.domain).toBe(false)
      expect(seen.has(p.domain), `duplicate ${p.domain}`).toBe(false)
      seen.add(p.domain)
      expect(p.why.length, p.domain).toBeGreaterThan(20)
      expect(p.regions.length, p.domain).toBeGreaterThan(0)
      expect(p.addedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    expect(Object.keys(PUBLISHER_REGISTRY)).toHaveLength(PUBLISHERS.length)
  })

  it('⚠️ a publisher is never a vendor the taxonomy tracks — criterion 2, checked against every bank', () => {
    const vendorDomains = new Set(DEMO_BANKS.flatMap((b) => b.leaders.flatMap((l) => [...l.domains, ...(l.siteDomains ?? [])])))
    for (const p of PUBLISHERS) {
      for (const v of vendorDomains) expect(p.domain === v || p.domain.endsWith(`.${v}`), `${p.domain} is a tracked vendor's domain (${v})`).toBe(false)
    }
  })

  it('a publisher is never a platform the classifier already names — those classes win first anyway', () => {
    const platforms = new Set([...Object.keys(PLATFORM_TABLES.video), ...Object.keys(PLATFORM_TABLES.community), ...Object.keys(PLATFORM_TABLES.review), ...Object.keys(PLATFORM_TABLES.reference)])
    for (const p of PUBLISHERS) expect(platforms.has(p.domain), p.domain).toBe(false)
  })

  it('the exclusions do not overlap the list, and each names the criterion it fails', () => {
    const listed = new Set(PUBLISHERS.map((p) => p.domain))
    for (const n of NOT_PUBLISHERS) {
      expect(listed.has(n.domain), n.domain).toBe(false)
      expect([1, 2, 3, 4]).toContain(n.fails)
    }
  })
})
