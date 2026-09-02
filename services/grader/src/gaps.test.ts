import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeCycle } from './cycles.js'
import { gapReportFor } from './gaps.js'
import { recordCategory } from './resolve-category.js'

/**
 * Synthetic throughout: an invented homepage served by an injected fetch, a
 * resolver that answers a public address without DNS, and a stored cycle
 * written by hand. Nothing here reaches a network.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-gaps-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const DOMAIN = 'gaps.example'
const cycle = (day: string, category: string, prompts: number) => ({
  status: 'scanned',
  domain: DOMAIN,
  category,
  categoryName: category,
  comparisonBasis: `grader|engines=chatgpt|en-US|US|${category}@1|unprompted=${prompts}|runs=1`,
  algoVersion: 'det-2',
  collectedAt: `${day}T10:00:00.000Z`,
  run: { mode: 'live', plan: 'payg', day, engines: ['chatgpt'], capUsd: 5, at: `${day}T10:01:00.000Z` },
  counts: { cellsRequested: prompts, cacheHits: 0, collected: prompts, failed: 0, answersScored: prompts, providerCalls: prompts },
  brands: [],
})

const page = (body: string, head = '<title>Gaps Example CRM</title>') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
const serving = (html: string) => ({
  fetchImpl: (async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch,
  resolve: async () => ['93.184.216.34'],
})
const NOW = () => new Date('2026-09-02T12:00:00.000Z')

describe('the gap report is about the cycle it sits under', () => {
  it('audits the homepage against the prompts the LATEST cycle was measured over, and carries the cycle’s identity', async () => {
    writeCycle(dir, cycle('2026-08-01', 'crm-software', 17))
    writeCycle(dir, cycle('2026-09-01', 'crm-software', 2))
    const got = await gapReportFor(dir, DOMAIN, { fetch: serving(page('<h1>A CRM for solo founders</h1><p>Best CRM for a small team.</p>')), now: NOW })
    if ('refuse' in got) throw new Error(got.refuse)
    expect(got.category).toBe('crm-software')
    expect(got.day).toBe('2026-09-01')
    expect(got.promptCount).toBe(2)
    expect(got.coverage).toHaveLength(2)
    expect(got.comparisonBasis).toContain('unprompted=2')
    expect(got.fetchedAt).toBe('2026-09-02T12:00:00.000Z')
    expect(got.findings.map((f) => f.id)).toContain('json-ld')
    expect(got.findings.find((f) => f.id === 'h1')?.status).toBe('present')
    expect(got.truncated).toBe(false)
    expect(got.bytes).toBeGreaterThan(0)
  })

  it('a named day reads THAT cycle, at its own prompt count', async () => {
    writeCycle(dir, cycle('2026-08-01', 'crm-software', 17))
    writeCycle(dir, cycle('2026-09-01', 'crm-software', 2))
    const got = await gapReportFor(dir, DOMAIN, { day: '2026-08-01', fetch: serving(page('<p>hello</p>')), now: NOW })
    if ('refuse' in got) throw new Error(got.refuse)
    expect(got.day).toBe('2026-08-01')
    expect(got.promptCount).toBe(17)
  })

  it('⚠️ an earlier-category cycle is audited against ITS bank, whatever the record says today', async () => {
    writeCycle(dir, cycle('2026-08-01', 'crm-software', 3))
    writeCycle(dir, cycle('2026-09-01', 'accounting-software', 3))
    recordCategory(dir, { host: DOMAIN, slug: 'accounting-software', source: 'site-content', evidence: 'x', decidedAt: '2026-09-01T00:00:00.000Z', generated: false })
    const old = await gapReportFor(dir, DOMAIN, { day: '2026-08-01', fetch: serving(page('<p>hello</p>')), now: NOW })
    if ('refuse' in old) throw new Error(old.refuse)
    expect(old.category).toBe('crm-software')
    expect(old.coverage[0]!.prompt.toLowerCase()).toContain('crm')
  })
})

describe('what it refuses, spending nothing', () => {
  it('a domain with no stored cycle — so the route around it is not a fetch proxy', async () => {
    let fetched = 0
    const got = await gapReportFor(dir, DOMAIN, { fetch: { fetchImpl: (async () => { fetched += 1; return new Response('') }) as unknown as typeof fetch, resolve: async () => ['93.184.216.34'] } })
    expect(got).toEqual({ refuse: `no stored result for ${DOMAIN}` })
    expect(fetched).toBe(0)
  })

  it('a homepage that cannot be read is a named refusal, not an empty report', async () => {
    writeCycle(dir, cycle('2026-09-01', 'crm-software', 2))
    const got = await gapReportFor(dir, DOMAIN, { fetch: { fetchImpl: (async () => { throw new Error('connection reset') }) as unknown as typeof fetch, resolve: async () => ['93.184.216.34'] } })
    expect('refuse' in got && got.refuse).toContain('could not read the homepage')
  })

  it('a category with no bank is refused by name', async () => {
    writeCycle(dir, cycle('2026-09-01', 'no-such-bank', 2))
    const got = await gapReportFor(dir, DOMAIN, { fetch: serving(page('<p>x</p>')) })
    expect(got).toEqual({ refuse: `${DOMAIN}: no bank for category no-such-bank` })
  })
})
