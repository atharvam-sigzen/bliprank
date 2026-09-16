import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { r2KeyFor } from '@bliprank/collector'
import { DEMO_BANKS } from '@bliprank/taxonomy'
import { FileBlobStore } from './local-store.js'
import { cellsFor } from './scan.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readScanAnswers } from './answers.js'
import { writeCycle } from './cycles.js'
import { recordCategory } from './resolve-category.js'

/**
 * THE EVIDENCE FOR A CYCLE IS BUILT FROM THAT CYCLE'S OWN CATEGORY.
 *
 * Found by the ADR-0013 review: the reader took the bank from today's record,
 * so a cycle collected before a deliberate category change had its cells built
 * from the wrong bank — an empty or wrong evidence list under a basis check the
 * client still passed, because the basis string is copied from the file.
 *
 * No answer blobs are written here: what is under test is which bank the
 * reader chooses, which the returned `category` and `comparisonBasis` reveal.
 * Nothing spends and nothing leaves the machine.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-answers-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const DOMAIN = 'moved.example'
const cycle = (day: string, category: string) => ({
  status: 'scanned',
  domain: DOMAIN,
  category,
  categoryName: category,
  comparisonBasis: `grader|engines=chatgpt|en-US|US|${category}@1|unprompted=2|runs=1`,
  algoVersion: 'det-2',
  collectedAt: `${day}T10:00:00.000Z`,
  run: { mode: 'live', plan: 'payg', day, engines: ['chatgpt'], capUsd: 5, at: `${day}T10:01:00.000Z` },
  counts: { cellsRequested: 2, cacheHits: 0, collected: 2, failed: 0, answersScored: 2, providerCalls: 2 },
  brands: [],
})

describe('readScanAnswers picks the bank the cycle was measured against', () => {
  it('an earlier cycle under the old category reads with the old bank, whatever the record says today', async () => {
    writeCycle(dir, cycle('2026-08-20', 'crm-software'))
    writeCycle(dir, cycle('2026-09-02', 'accounting-software'))
    // The record moved to the new category by a deliberate act.
    recordCategory(dir, { host: DOMAIN, slug: 'accounting-software', source: 'site-content', evidence: 'x', decidedAt: '2026-09-01T00:00:00.000Z', generated: false })

    const old = await readScanAnswers(dir, DOMAIN, '2026-08-20')
    expect('refuse' in old).toBe(false)
    if ('refuse' in old) return
    expect(old.category).toBe('crm-software')
    expect(old.day).toBe('2026-08-20')
    expect(old.comparisonBasis).toContain('crm-software@1')

    const latest = await readScanAnswers(dir, DOMAIN)
    if ('refuse' in latest) throw new Error(latest.refuse)
    expect(latest.category).toBe('accounting-software')
    expect(latest.day).toBe('2026-09-02')
  })

  it('a day this domain has no cycle for is an absence, named', async () => {
    writeCycle(dir, cycle('2026-08-20', 'crm-software'))
    const got = await readScanAnswers(dir, DOMAIN, '2026-08-21')
    expect(got).toEqual({ refuse: `no stored cycle of ${DOMAIN} for 2026-08-21` })
  })

  it('a file that names no category falls back to the record, and refuses without one', async () => {
    const { category: _dropped, ...noCategory } = cycle('2026-08-20', 'crm-software')
    void _dropped
    writeCycle(dir, noCategory as unknown as Parameters<typeof writeCycle>[1])
    expect(await readScanAnswers(dir, DOMAIN)).toHaveProperty('refuse')
    recordCategory(dir, { host: DOMAIN, slug: 'crm-software', source: 'leader-domain', evidence: 'x', decidedAt: '2026-09-01T00:00:00.000Z', generated: false })
    const got = await readScanAnswers(dir, DOMAIN)
    if ('refuse' in got) throw new Error(got.refuse)
    expect(got.category).toBe('crm-software')
  })

  it('a recorded category with no bank is refused by name', async () => {
    writeCycle(dir, cycle('2026-08-20', 'no-such-bank'))
    writeFileSync(join(dir, 'domain-categories.json'), '{}\n')
    expect(await readScanAnswers(dir, DOMAIN)).toEqual({ refuse: `${DOMAIN}: no bank for category no-such-bank` })
  })
})

describe('every answer carries its citations, classified by the scan’s own rules (ADR-0014)', () => {
  it('owned, competitor, review and other, from a stored blob, with the rule set named', async () => {
    // pipedrive.com is a tracked crm-software leader, so its subject spec owns
    // pipedrive.com and HubSpot is a competitor with hubspot.com.
    const domain = 'pipedrive.com'
    const day = '2026-08-25'
    const stored = { ...cycle(day, 'crm-software'), domain, comparisonBasis: 'grader|engines=chatgpt|en-US|US|crm-software@1|unprompted=1|runs=1' }
    writeCycle(dir, stored)
    const bank = DEMO_BANKS.find((b) => b.category === 'crm-software')!
    const [first] = cellsFor(bank, ['chatgpt'], day, 1)
    const blob = new FileBlobStore(join(dir, 'answers'))
    await blob.put(
      r2KeyFor(first!.cell, 'openwebninja:chatgpt'),
      JSON.stringify({
        runs: [
          {
            text: 'Pipedrive and HubSpot are both popular.',
            collectedAt: `${day}T06:00:00.000Z`,
            citations: [
              { url: 'https://www.pipedrive.com/en/features', position: 0 },
              { url: 'https://www.g2.com/products/pipedrive/reviews', position: 1 },
              { url: 'https://www.hubspot.com/products/crm', position: 2 },
              { url: 'https://example.org/some-blog-post', position: 3 },
              { notAUrl: true },
            ],
          },
          { text: 'No sources here.', collectedAt: `${day}T06:00:01.000Z` },
        ],
      }),
    )

    const got = await readScanAnswers(dir, domain)
    if ('refuse' in got) throw new Error(got.refuse)
    expect(got.algoVersion).toMatch(/^det-/)
    expect(got.answers).toHaveLength(2)
    const [a, b] = got.answers
    expect(a!.citations.map((c) => [c.domain, c.sourceClass])).toEqual([
      ['pipedrive.com', 'owned'],
      ['g2.com', 'review'],
      ['hubspot.com', 'competitor'],
      ['example.org', 'other'],
    ])
    expect(a!.citations.map((c) => c.position)).toEqual([0, 1, 2, 3])
    // An answer that cited nothing says so with an empty list, not an absence.
    expect(b!.citations).toEqual([])
  })
})

describe('the competitor set a cycle was measured against (ADR-0016)', () => {
  it('a cycle whose basis names an override version the store does not hold is refused, never read under today’s set', async () => {
    writeCycle(dir, { ...cycle('2026-08-20', 'crm-software'), comparisonBasis: 'grader|engines=chatgpt|en-US|US|crm-software@1|unprompted=2|runs=1|set=4' } as never)
    recordCategory(dir, { host: DOMAIN, slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-08-01T00:00:00.000Z', generated: false })
    const got = await readScanAnswers(dir, DOMAIN, '2026-08-20')
    expect(got).toMatchObject({ refuse: expect.stringContaining('competitor set 4') })
  })
})
