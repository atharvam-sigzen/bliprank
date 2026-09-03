import { describe, expect, it } from 'vitest'
import { fileCompetitorChange, loadCompetitorStatus, parseCompetitorStatus } from './competitor-request'

const good = {
  domain: 'acme.test',
  category: { slug: 'crm-software', name: 'CRM software', bankVersion: 1 },
  set: 2,
  competitors: [{ id: 'hubspot', name: 'HubSpot', source: 'category' }, { id: 'semrush', name: 'Semrush', source: 'included' }, { name: 'no id' }],
  excluded: [{ id: 'zoho-crm', name: 'Zoho CRM' }],
  includable: [{ id: 'ahrefs', name: 'Ahrefs', bank: 'SEO tools' }, 'junk'],
  last: { version: 2, at: '2026-09-03', by: 'operator', reason: 'r' },
  pending: { exclude: ['hubspot'], include: [], requestedAt: '2026-09-04' },
  history: [{ status: 'declined', requestedAt: 'a', resolvedAt: 'b', note: 'n' }, { status: 'pending' }],
}

describe('the status is shape-checked', () => {
  it('keeps what is well-formed and drops what is not', () => {
    const s = parseCompetitorStatus(good)!
    expect(s.set).toBe(2)
    expect(s.competitors.map((c) => [c.id, c.source])).toEqual([
      ['hubspot', 'category'],
      ['semrush', 'included'],
    ])
    expect(s.includable).toEqual([{ id: 'ahrefs', name: 'Ahrefs', bank: 'SEO tools' }])
    expect(s.pending?.exclude).toEqual(['hubspot'])
    expect(s.history).toHaveLength(1)
    expect(parseCompetitorStatus({ ...good, set: 0 })!.set).toBeNull()
    expect(parseCompetitorStatus({ ...good, category: null })).toBeNull()
  })
})

const respond = (status: number, body?: unknown): typeof fetch => (async () => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

describe('the loader and the filer', () => {
  it('tells a missing service from a missing record, and reports the service’s own refusal', async () => {
    expect(await loadCompetitorStatus('acme.test', respond(404))).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(await loadCompetitorStatus('acme.test', respond(404, { kind: 'no-record', message: 'none' }))).toMatchObject({ ok: false, kind: 'no-record' })
    expect(await loadCompetitorStatus('acme.test', respond(200, good))).toMatchObject({ ok: true })
    expect(await fileCompetitorChange('acme.test', ['hubspot'], [], 'a long enough reason', respond(200, { request: { requestedAt: '2026-09-04' } }))).toEqual({ ok: true, requestedAt: '2026-09-04' })
    expect(await fileCompetitorChange('acme.test', ['x'], [], 'a long enough reason', respond(422, { message: 'not in the set' }))).toEqual({ ok: false, message: 'not in the set' })
  })
})
