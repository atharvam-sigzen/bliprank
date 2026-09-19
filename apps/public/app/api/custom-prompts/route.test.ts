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
    // One cycle's prompts: the set IS the measurement (ADR-0016 Amendment 1), so it is bounded where the bank is.
    expect(none.limits.maxPrompts).toBe(17)
    expect(none.perPrompt).toMatchObject({ cells: 5, plan: 'payg' })
    applyCustomPrompts(dir, { host: 'acme.test', prompts: GOOD, reason: REASON, by: 'operator', at: '2026-09-03T10:00:00.000Z' })
    const some = (await (await get('?domain=acme.test')).json()) as { set: { version: number; prompts: string[] } }
    expect(some.set).toMatchObject({ version: 1, prompts: GOOD })
  })
})

describe('POST on the machine’s own store: the store’s own validation, then the set is saved as the next version (ADR-0016 Amendment 1, MVP_PLAN C3)', () => {
  it('a prompt naming a tracked brand or the subject is refused at filing time, with the reason', async () => {
    const brand = await post({ domain: 'acme.test', prompts: ['how does this compare to HubSpot'], reason: REASON })
    expect(brand.status).toBe(422)
    expect(await brand.json()).toMatchObject({ kind: 'names-brand', message: expect.stringContaining('HubSpot') })
    const self = await post({ domain: 'acme.test', prompts: ['is Acme Labs good for a small team'], reason: REASON })
    expect(self.status).toBe(422)
  })

  it('the person at the keyboard is the machine’s operator: a good list is APPLIED as version 1, nothing is left pending, an identical list is no change, an edit is version 2; refusals carry a status and write nothing', async () => {
    // With identity on, an owner or admin applies and a member files (session-store.test.ts); on the file store there is one person and the entry flow saves directly.
    const saved = await post({ domain: 'acme.test', prompts: GOOD, reason: REASON })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ applied: true, version: 1 })
    const body = (await (await get('?domain=acme.test')).json()) as { pending: unknown; set: { version: number; prompts: string[] } | null }
    expect(body.pending).toBeNull()
    expect(body.set).toMatchObject({ version: 1, prompts: GOOD })
    expect(readCustomPromptSet(dir, 'acme.test')).toMatchObject({ version: 1, prompts: GOOD, by: 'local' })
    expect(await (await post({ domain: 'acme.test', prompts: GOOD, reason: REASON })).json()).toMatchObject({ kind: 'no-change' })
    expect(await (await post({ domain: 'acme.test', prompts: [GOOD[0]], reason: REASON })).json()).toMatchObject({ applied: true, version: 2 })
    expect(readCustomPromptSet(dir, 'acme.test')?.superseded).toHaveLength(1)
    // A refused list leaves the set where it was.
    expect((await post({ domain: 'acme.test', prompts: ['how does this compare to HubSpot'], reason: REASON })).status).toBe(422)
    expect(readCustomPromptSet(dir, 'acme.test')).toMatchObject({ version: 2 })
    expect((await post({ domain: 'acme.test', prompts: 'not a list', reason: REASON })).status).toBe(400)
    // An empty list CLEARS the set in force, which is a version too: the next cycle asks the bank's prompts again, on the bank's basis.
    expect(await (await post({ domain: 'acme.test', prompts: [], reason: REASON })).json()).toMatchObject({ applied: true, version: 3 })
    expect(readCustomPromptSet(dir, 'acme.test')).toMatchObject({ version: 3, prompts: [] })
    expect((await post({ domain: 'acme.test', prompts: ['too short'], reason: REASON })).status).toBe(400)
    expect((await post({ domain: 'nobody.test', prompts: GOOD, reason: REASON })).status).toBe(404)
  })

  it('the per-domain cap holds whatever the caller calls itself', async () => {
    for (let i = 0; i < 6; i++) expect((await post({ domain: 'acme.test', prompts: [`${GOOD[0]} number ${i}`], reason: REASON })).status).toBe(200)
    expect((await post({ domain: 'acme.test', prompts: GOOD, reason: REASON })).status).toBe(429)
  })
})
