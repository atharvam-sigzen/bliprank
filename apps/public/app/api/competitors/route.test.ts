import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyOverride, readOverride } from '../../../../../services/grader/src/competitor-overrides.js'
import { recordCategory } from '../../../../../services/grader/src/resolve-category.js'
import { GET, POST } from './route'

let dir: string
let ip = 0
const originalEnv = { ...process.env }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-competitors-api-'))
  process.env['GRADER_DATA_DIR'] = dir
  recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'pipeline', decidedAt: '2026-08-01T00:00:00.000Z', generated: false, brandName: 'Acme' })
})
afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(dir, { recursive: true, force: true })
})

const headers = () => ({ 'x-forwarded-for': `10.1.0.${++ip % 250}` })
const get = (q: string) => GET(new Request(`http://local/api/competitors${q}`, { headers: headers() }))
const post = (body: unknown, h: Record<string, string> = headers()) =>
  POST(new Request('http://local/api/competitors', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }))
const REASON = 'Zoho is our integration partner, not a rival'

describe('GET: the set in force, the exclusions, the includable, the version', () => {
  it('refuses a bad name and an unrecorded domain', async () => {
    expect((await get('')).status).toBe(400)
    const none = await get('?domain=nobody.test')
    expect(none.status).toBe(404)
    expect(await none.json()).toMatchObject({ kind: 'no-record' })
  })

  it('with no override: the category’s set, set null, every reviewed leader from other categories includable, the subject never listed', async () => {
    const body = (await (await get('?domain=acme.test')).json()) as { set: number | null; competitors: { id: string; source: string }[]; includable: { id: string; bank: string }[]; category: { slug: string; bankVersion: number } }
    expect(body.set).toBeNull()
    expect(body.category).toMatchObject({ slug: 'crm-software', bankVersion: 1 })
    expect(body.competitors.some((c) => c.id === 'hubspot' && c.source === 'category')).toBe(true)
    expect(body.includable.some((c) => c.id === 'semrush')).toBe(true)
    expect(body.includable.some((c) => c.id === 'hubspot')).toBe(false)
  })

  it('with an override: the excluded leader is out, the included one is in and marked, and the version and reason are shown', async () => {
    applyOverride(dir, { host: 'acme.test', exclude: ['zoho-crm'], include: ['semrush'], reason: REASON, by: 'operator', at: '2026-09-03T10:00:00.000Z' })
    const body = (await (await get('?domain=acme.test')).json()) as { set: number; competitors: { id: string; source: string }[]; excluded: { id: string }[]; last: { version: number; reason: string } }
    expect(body.set).toBe(1)
    expect(body.competitors.some((c) => c.id === 'zoho-crm')).toBe(false)
    expect(body.competitors.find((c) => c.id === 'semrush')?.source).toBe('included')
    expect(body.excluded).toEqual([{ id: 'zoho-crm', name: 'Zoho CRM' }])
    expect(body.last).toMatchObject({ version: 1, reason: REASON })
  })
})

describe('POST: files a request and never writes the override', () => {
  it('a filed request is pending on GET without its reason; the override is untouched', async () => {
    const res = await post({ domain: 'acme.test', exclude: ['zoho-crm'], include: ['semrush'], reason: REASON })
    expect(res.status).toBe(200)
    const body = (await (await get('?domain=acme.test')).json()) as { pending: { exclude: string[]; include: string[]; reason?: string } | null; set: number | null }
    expect(body.pending).toMatchObject({ exclude: ['zoho-crm'], include: ['semrush'] })
    expect(body.pending).not.toHaveProperty('reason')
    expect(body.set).toBeNull()
    expect(readOverride(dir, 'acme.test')).toBeNull()
  })

  it('refusals carry the store’s kind and a status', async () => {
    expect((await post({ domain: 'acme.test', exclude: ['semrush'], include: [], reason: REASON })).status).toBe(422)
    expect((await post({ domain: 'acme.test', exclude: [], include: ['made-up'], reason: REASON })).status).toBe(422)
    expect((await post({ domain: 'acme.test', exclude: [], include: [], reason: REASON })).status).toBe(400)
    expect((await post({ domain: 'acme.test', exclude: ['zoho-crm'], include: [], reason: 'meh' })).status).toBe(400)
    expect((await post({ domain: 'acme.test', exclude: 'zoho-crm', include: [], reason: REASON })).status).toBe(400)
    expect((await post({ domain: 'nobody.test', exclude: ['zoho-crm'], include: [], reason: REASON })).status).toBe(404)
  })

  it('the per-domain cap holds whatever the caller calls itself', async () => {
    for (let i = 0; i < 6; i++) expect((await post({ domain: 'acme.test', exclude: ['zoho-crm'], include: [], reason: `${REASON} ${i}` })).status).toBe(200)
    expect((await post({ domain: 'acme.test', exclude: ['hubspot'], include: [], reason: REASON })).status).toBe(429)
    const body = (await (await get('?domain=acme.test')).json()) as { pending: { exclude: string[] } }
    expect(body.pending.exclude).toEqual(['zoho-crm'])
  })
})
