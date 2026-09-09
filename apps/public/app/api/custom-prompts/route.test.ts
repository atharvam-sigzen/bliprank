import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyCustomPrompts, readCustomPromptSet } from '../../../../../services/grader/src/custom-prompts.js'
import { recordCategory } from '../../../../../services/grader/src/resolve-category.js'
import { GET, POST } from './route'

let dir: string
let ip = 0
const originalEnv = { ...process.env }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-prompts-api-'))
  process.env['GRADER_DATA_DIR'] = dir
  process.env['TRUSTED_PROXY'] = 'cloudflare'
  recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'pipeline', decidedAt: '2026-08-01T00:00:00.000Z', generated: false, brandName: 'Acme Labs' })
})
afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(dir, { recursive: true, force: true })
})

const headers = () => ({ 'cf-connecting-ip': `10.2.0.${++ip % 250}` })
const get = (q: string) => GET(new Request(`http://local/api/custom-prompts${q}`, { headers: headers() }))
const post = (body: unknown, h: Record<string, string> = headers()) =>
  POST(new Request('http://local/api/custom-prompts', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }))
const REASON = 'these are the questions our buyers actually ask'
const GOOD = ['best invoicing tool for a two-person studio', 'which crm works offline on a phone']

describe('GET: the set in force, the limits, the cost per prompt', () => {
  it('refuses an unrecorded domain; with no set says so; with one shows it with its version', async () => {
    expect((await get('?domain=nobody.test')).status).toBe(404)
    const none = (await (await get('?domain=acme.test')).json()) as { set: null; limits: { maxPrompts: number }; perPrompt: { cells: number; plan: string } }
    expect(none.set).toBeNull()
    expect(none.limits.maxPrompts).toBe(15)
    expect(none.perPrompt).toMatchObject({ cells: 5, plan: 'payg' })
    applyCustomPrompts(dir, { host: 'acme.test', prompts: GOOD, reason: REASON, by: 'operator', at: '2026-09-03T10:00:00.000Z' })
    const some = (await (await get('?domain=acme.test')).json()) as { set: { version: number; prompts: string[] } }
    expect(some.set).toMatchObject({ version: 1, prompts: GOOD })
  })
})

describe('POST: files a request with the store’s own validation, never writes the set', () => {
  it('a prompt naming a tracked brand or the subject is refused at filing time, with the reason', async () => {
    const brand = await post({ domain: 'acme.test', prompts: ['how does this compare to HubSpot'], reason: REASON })
    expect(brand.status).toBe(422)
    expect(await brand.json()).toMatchObject({ kind: 'names-brand', message: expect.stringContaining('HubSpot') })
    const self = await post({ domain: 'acme.test', prompts: ['is Acme Labs good for a small team'], reason: REASON })
    expect(self.status).toBe(422)
  })

  it('a filed request is pending on GET without its reason; the set is untouched; refusals carry a status', async () => {
    expect((await post({ domain: 'acme.test', prompts: GOOD, reason: REASON })).status).toBe(200)
    const body = (await (await get('?domain=acme.test')).json()) as { pending: { prompts: string[]; reason?: string } | null; set: null }
    expect(body.pending).toMatchObject({ prompts: GOOD })
    expect(body.pending).not.toHaveProperty('reason')
    expect(readCustomPromptSet(dir, 'acme.test')).toBeNull()
    expect((await post({ domain: 'acme.test', prompts: 'not a list', reason: REASON })).status).toBe(400)
    expect((await post({ domain: 'acme.test', prompts: [], reason: REASON })).status).toBe(400)
    expect((await post({ domain: 'acme.test', prompts: ['too short'], reason: REASON })).status).toBe(400)
    expect((await post({ domain: 'nobody.test', prompts: GOOD, reason: REASON })).status).toBe(404)
  })

  it('the per-domain cap holds whatever the caller calls itself', async () => {
    for (let i = 0; i < 6; i++) expect((await post({ domain: 'acme.test', prompts: [`${GOOD[0]} number ${i}`], reason: REASON })).status).toBe(200)
    expect((await post({ domain: 'acme.test', prompts: GOOD, reason: REASON })).status).toBe(429)
  })
})
