import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { correctCategory, readCategoryRecord, recordCategory } from '../../../../../services/grader/src/resolve-category.js'
import { GET, POST } from './route'

/**
 * The route against a scratch store. Nothing is mocked: the record, the
 * request store, the throttles and the JSON are real. Nothing spends.
 */

let dir: string
let ip = 0
const originalEnv = { ...process.env }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-category-api-'))
  process.env['GRADER_DATA_DIR'] = dir
  process.env['TRUSTED_PROXY'] = 'cloudflare'
  recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'pipeline', decidedAt: '2026-08-01T00:00:00.000Z', generated: false })
})
afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(dir, { recursive: true, force: true })
})

const headers = () => ({ 'cf-connecting-ip': `10.0.0.${++ip % 250}` })
const get = (q: string) => GET(new Request(`http://local/api/category${q}`, { headers: headers() }))
const post = (body: unknown, h: Record<string, string> = headers()) =>
  POST(new Request('http://local/api/category', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }))

const REASON = 'the pricing page sells accounting modules'

describe('GET: the record, its history, the choices, the consequences', () => {
  it('refuses a bad name and an unrecorded domain before touching any ledger', async () => {
    expect((await get('')).status).toBe(400)
    const none = await get('?domain=nobody.test')
    expect(none.status).toBe(404)
    expect(await none.json()).toMatchObject({ kind: 'no-record' })
  })

  it('a never-corrected record: version 1, no corrections, every measurable category offered, the next cycle priced', async () => {
    const res = await get('?domain=https://www.acme.test/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['record']).toMatchObject({ slug: 'crm-software', name: 'CRM software', version: 1, source: 'site-content', corrections: [] })
    const cats = body['categories'] as { slug: string; generated: boolean }[]
    expect(cats.some((c) => c.slug === 'seo-tools')).toBe(true)
    expect(cats.every((c) => c.generated === false)).toBe(true)
    // Seen in the browser check: the general bank was offered while the store refused it. It is an absence, not a choice.
    expect(cats.some((c) => c.slug === 'general-business-software')).toBe(false)
    expect(body['pending']).toBeNull()
    expect(body['nextCycle']).toMatchObject({ engines: 5, earlierCycles: 0, plan: 'payg' })
    expect((body['nextCycle'] as { cells: number }).cells).toBeGreaterThan(0)
  })

  it('a corrected record shows every correction, oldest first, and the current version', async () => {
    correctCategory(dir, { host: 'acme.test', slug: 'accounting-software', reason: REASON, by: 'operator', at: '2026-09-02T00:00:00.000Z' })
    correctCategory(dir, { host: 'acme.test', slug: 'seo-tools', reason: 'and then SEO, for the test', by: 'operator', at: '2026-09-03T00:00:00.000Z' })
    const body = (await (await get('?domain=acme.test')).json()) as { record: { version: number; slug: string; corrections: { from: string; to: string }[] } }
    expect(body.record.version).toBe(3)
    expect(body.record.slug).toBe('seo-tools')
    expect(body.record.corrections).toEqual([
      expect.objectContaining({ from: 'crm-software', to: 'accounting-software' }),
      expect.objectContaining({ from: 'accounting-software', to: 'seo-tools' }),
    ])
  })
})

describe('POST: files a request and nothing else', () => {
  it('a filed request appears as pending on GET, and the record is untouched', async () => {
    const res = await post({ domain: 'acme.test', slug: 'accounting-software', reason: REASON })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ request: { host: 'acme.test', slug: 'accounting-software', status: 'pending' } })
    const status = (await (await get('?domain=acme.test')).json()) as { pending: { slug: string; name: string } | null }
    expect(status.pending).toMatchObject({ slug: 'accounting-software', name: 'Accounting software' })
    expect(readCategoryRecord(dir, 'acme.test')?.slug).toBe('crm-software')
    expect(readCategoryRecord(dir, 'acme.test')?.version).toBe(1)
  })

  it('refusals carry the store’s kind and a status a person can act on', async () => {
    expect((await post({ domain: 'acme.test', slug: 'crm-software', reason: REASON })).status).toBe(409)
    expect((await post({ domain: 'acme.test', slug: 'made-up', reason: REASON })).status).toBe(422)
    expect((await post({ domain: 'acme.test', slug: 'accounting-software', reason: 'meh' })).status).toBe(400)
    expect((await post({ domain: 'nobody.test', slug: 'accounting-software', reason: REASON })).status).toBe(404)
    expect((await post({ domain: 'acme.test', reason: REASON })).status).toBe(400)
    expect((await post({ domain: 'acme.test', slug: 'accounting-software', reason: { toString: () => REASON } })).status).toBe(400)
    expect((await post('not json at all')).status).toBe(400)
  })

  it('the per-domain cap holds whatever the caller calls itself, and a refusal books no slot', async () => {
    // Six filings from six "visitors" fill the domain's hour; the seventh is refused; the pending one stands.
    for (let i = 0; i < 6; i++) expect((await post({ domain: 'acme.test', slug: 'accounting-software', reason: `${REASON} ${i}` })).status).toBe(200)
    const seventh = await post({ domain: 'acme.test', slug: 'seo-tools', reason: REASON })
    expect(seventh.status).toBe(429)
    const status = (await (await get('?domain=acme.test')).json()) as { pending: { slug: string; reason?: string } }
    expect(status.pending.slug).toBe('accounting-software')
    // The reason is the filer's and the operator's, never the page's: anyone could otherwise post a sentence on anyone's record.
    expect(status.pending).not.toHaveProperty('reason')
    // A refused filing did not count against the domain: the ledger holds six entries, not seven.
    const ledger = JSON.parse(readFileSync(join(dir, 'category-request-domain-cap.json'), 'utf8')) as Record<string, unknown[]>
    expect(Object.values(ledger).flat()).toHaveLength(6)
  })

  it('the per-visitor allowance is on its own ledger', async () => {
    const same = { 'cf-connecting-ip': '10.9.9.9' }
    for (let i = 0; i < 5; i++) expect((await post({ domain: 'acme.test', slug: 'accounting-software', reason: `${REASON} ${i}` }, same)).status).toBe(200)
    expect((await post({ domain: 'acme.test', slug: 'accounting-software', reason: REASON }, same)).status).toBe(429)
    // Reads are unaffected by filings.
    expect((await GET(new Request('http://local/api/category?domain=acme.test', { headers: same }))).status).toBe(200)
  })
})
