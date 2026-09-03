import { describe, expect, it } from 'vitest'
import { fileCorrection, loadCategoryStatus, parseCategoryStatus } from './category-request'

const good = {
  domain: 'acme.test',
  record: { slug: 'crm-software', name: 'CRM software', source: 'site-content', decidedAt: '2026-08-01', version: 2, corrections: [{ from: 'seo-tools', to: 'crm-software', at: '2026-08-02', by: 'operator', reason: 'r' }, { nonsense: true }] },
  categories: [{ slug: 'seo-tools', name: 'SEO tools', generated: false }, { slug: '' }, 'junk'],
  pending: { slug: 'seo-tools', name: 'SEO tools', requestedAt: '2026-09-03' },
  history: [{ slug: 'x', status: 'applied', requestedAt: '2026-08-01', resolvedAt: '2026-08-02', note: '' }, { slug: 'y', status: 'pending' }],
  nextCycle: { prompts: 17, engines: 5, cells: 85, usd: 0.578, plan: 'payg', earlierCycles: 1 },
}

describe('the status is shape-checked, field by field', () => {
  it('keeps what is well-formed and drops what is not', () => {
    const s = parseCategoryStatus(good)!
    expect(s.record).toMatchObject({ slug: 'crm-software', version: 2 })
    expect(s.record.corrections).toHaveLength(1)
    expect(s.categories).toEqual([{ slug: 'seo-tools', name: 'SEO tools', generated: false }])
    expect(s.pending?.slug).toBe('seo-tools')
    expect(s.history).toHaveLength(1)
    expect(s.nextCycle.cells).toBe(85)
  })

  it('a version that is missing or nonsense reads as 1; a body with no record is not a status', () => {
    expect(parseCategoryStatus({ ...good, record: { ...good.record, version: 'two' } })!.record.version).toBe(1)
    expect(parseCategoryStatus({ ...good, record: null })).toBeNull()
    expect(parseCategoryStatus('nope')).toBeNull()
  })
})

const respond = (status: number, body?: unknown): typeof fetch => (async () => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

describe('the loader tells three absences apart', () => {
  it('a 404 with no JSON is a deployment without the service; a 404 naming no-record is a domain without a record', async () => {
    expect(await loadCategoryStatus('acme.test', respond(404))).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(await loadCategoryStatus('acme.test', respond(404, { kind: 'no-record', message: 'none yet' }))).toMatchObject({ ok: false, kind: 'no-record', message: 'none yet' })
    expect(await loadCategoryStatus('acme.test', (async () => { throw new Error('offline') }) as unknown as typeof fetch)).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(await loadCategoryStatus('acme.test', respond(200, good))).toMatchObject({ ok: true, status: { domain: 'acme.test' } })
    expect(await loadCategoryStatus('acme.test', respond(200, { junk: 1 }))).toMatchObject({ ok: false, kind: 'failed' })
  })

  it('filing reports the confirmed request or the service’s own refusal', async () => {
    expect(await fileCorrection('acme.test', 'seo-tools', 'a reason long enough', respond(200, { request: { slug: 'seo-tools', requestedAt: '2026-09-03' } }))).toEqual({ ok: true, slug: 'seo-tools', requestedAt: '2026-09-03' })
    expect(await fileCorrection('acme.test', 'seo-tools', 'short', respond(400, { message: 'say why' }))).toEqual({ ok: false, message: 'say why' })
    expect(await fileCorrection('acme.test', 'seo-tools', 'a reason long enough', respond(200, {}))).toMatchObject({ ok: false })
  })
})
