import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENGINES } from '@bliprank/contracts'
import { parseBasis } from '@bliprank/contracts'

/**
 * THE ENTRY FLOW, AS THE OWNER DESCRIBED IT ON 2026-09-16 (MVP_PLAN C3,
 * ADR-0016 Amendment 1), over the machine's own store with identity off:
 *
 *   1. the person enters a domain and sees the prompts a cycle would ask;
 *   2. edits them (removes one, adds one, rewords one) and the result is the
 *      domain's prompt set, version 1, PROPERTY 2 still enforced;
 *   3. enters a number of days;
 *   4. the first cycle runs now over THAT set, on a basis that names it;
 *   5. three daily ticks collect the same set on the same basis, and the
 *      fourth refuses `expired`.
 *
 * Nothing here spends: the first cycle and every tick run the fixture adapter
 * offline, the network is stubbed shut, and no flag that opens a live path is
 * set.
 */
vi.mock('@/lib/auth/supabase', () => ({ currentUser: async () => null }))
vi.mock('@/lib/auth/db', () => ({ appDb: () => null }))
vi.mock('../../../../services/grader/src/fetch-site.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../services/grader/src/fetch-site.js')>()
  return { ...actual, fetchSiteHtml: vi.fn(async () => ({ ok: false, reason: 'the entry-flow test reached the network' })) }
})

import { POST as preview } from './preview/route'
import { POST as customPrompts } from './custom-prompts/route'
import { GET as trackedGet, POST as trackedPost } from './tracked/route'
import { recordCategory } from '../../../../services/grader/src/resolve-category.js'
import { readTracked } from '../../../../services/grader/src/due.js'
import { runGrader } from '../../../../services/grader/src/run.js'
import { runTick } from '../../../../services/grader/src/daily-loop.js'
import { printDue } from '../../../../services/grader/src/tick.js'
import { listCycles } from '../../../../services/grader/src/cycles.js'
import { fileWorkspaceStore } from '../../../../services/grader/src/store/file-store.js'
import { cycleInputOf } from '../../../../services/grader/src/store/documents.js'
import { untilDay } from '@/lib/tracked'
import type { PreviewResponse } from '@/lib/preview-contract'

let dir: string
const originalEnv = { ...process.env }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-entry-flow-'))
  process.env = { ...originalEnv, GRADER_DATA_DIR: dir, COLLECTOR_TOPOLOGY: 'single-process', TRUSTED_PROXY: 'cloudflare' }
  for (const k of ['COLLECTION_ENABLED', 'GRADER_LIVE_SCAN', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'DATABASE_URL', 'AUTH_SIGNING_KID', 'AUTH_SIGNING_SECRET', 'AUTH_ISSUER', 'AUTH_AUDIENCE', 'GRADER_DAILY_LOOP']) delete process.env[k]
  recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-08-01', generated: false, brandName: 'Acme Labs' })
})
afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(dir, { recursive: true, force: true })
})

let ip = 0
const headers = () => ({ 'cf-connecting-ip': `10.0.1.${++ip % 250}`, 'Content-Type': 'application/json' })
const post = async (fn: (r: Request) => Promise<Response>, path: string, body: unknown) => {
  const res = await fn(new Request(`http://local/api/${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const get = async (fn: (r: Request) => Promise<Response>, path: string) => {
  const res = await fn(new Request(`http://local/api/${path}`, { headers: headers() }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const today = () => new Date().toISOString().slice(0, 10)
const cycleFile = (day: string) => JSON.parse(readFileSync(listCycles(dir, 'acme.test').find((c) => c.day === day)!.file, 'utf8')) as { comparisonBasis: string; promptRows: { prompt: string }[]; run: { source: string } }

describe('enter, edit, set the days, first cycle now, three daily ticks, then expired', () => {
  it('walks the whole flow over the machine’s store, offline', { timeout: 180_000 }, async () => {
    // 1. Enter: the bank's unprompted prompts, no set in force yet.
    const first = await post(preview, 'preview', { domain: 'acme.test' })
    expect(first.status).toBe(200)
    const shown = first.body as unknown as PreviewResponse
    expect(shown.prompts.length).toBe(17)
    expect(shown.promptSet).toBeUndefined()
    expect(shown.prompts.every((p) => p.intent !== 'own')).toBe(true)

    // 2. Edit: remove most of the bank's, reword one, keep one, add one of the person's own. Three prompts, so four offline cycles stay quick; the flow is the same at seventeen.
    const bank = shown.prompts.map((p) => p.text)
    const reworded = `${bank[1]!.replace(/\?$/, '')} for a two-person team?`
    const own = 'which crm works offline on a phone'
    const edited = [reworded, bank[2]!, own]
    expect(edited).toHaveLength(3)
    // PROPERTY 2 still holds on the person's text: a prompt naming a tracked brand is refused with the reason, and nothing is saved.
    const refused = await post(customPrompts, 'custom-prompts', { domain: 'acme.test', prompts: [...edited, 'how does this compare to HubSpot'], reason: 'edited on entry from the record' })
    expect(refused).toMatchObject({ status: 422, body: { kind: 'names-brand', message: expect.stringContaining('HubSpot') } })
    expect(((await post(preview, 'preview', { domain: 'acme.test' })).body as { promptSet?: unknown }).promptSet).toBeUndefined()
    // The edited set is saved as version 1 on the machine's own store: no request, no operator, the person at the keyboard applies.
    const saved = await post(customPrompts, 'custom-prompts', { domain: 'acme.test', prompts: edited, reason: 'edited on entry from the record' })
    expect(saved).toMatchObject({ status: 200, body: { applied: true, version: 1 } })
    // Entering again shows the person's own latest version, not the bank: kept prompts keep their intent, the person's own are theirs.
    const again = (await post(preview, 'preview', { domain: 'acme.test' })).body as unknown as PreviewResponse
    expect(again.prompts.map((p) => p.text)).toEqual(edited)
    expect(again.promptSet).toEqual({ version: 1, count: 3 })
    expect(again.prompts.filter((p) => p.intent === 'own').map((p) => p.text)).toEqual([reworded, own])

    // 3. The number of days: three. The entry carries the end and the set version the instruction was given with.
    const D = today()
    const tracked = await post(trackedPost, 'tracked', { domain: 'acme.test', on: true, days: 3 })
    expect(tracked).toMatchObject({ status: 200, body: { tracked: true, until: untilDay(D, 3), daysLeft: 3, prompts: 1, may: true } })
    expect(readTracked(dir)).toEqual([{ host: 'acme.test', since: expect.any(String), until: untilDay(D, 3), prompts: 1, by: 'local', reason: expect.stringContaining('3 days') }])
    expect((await get(trackedGet, 'tracked?domain=acme.test')).body).toMatchObject({ tracked: true, daysLeft: 3, prompts: 1 })

    // 4. The first cycle runs now, over the edited set and nothing of the bank's, on a basis that names the set. Fixture adapter: nothing is spent.
    const r = await runGrader({ domain: 'acme.test', plan: 'payg', day: D, engines: [...ENGINES], capUsd: 10, mode: 'fixture', apiKey: '', dataDir: dir, log: () => {} })
    expect(r.status).toBe('scanned')
    if (r.status !== 'scanned') return
    expect(r.comparisonBasis).toMatch(/\|unprompted=0\|runs=1\|custom=3@1$/)
    expect(parseBasis(r.comparisonBasis)?.custom).toEqual({ count: 3, version: 1 })
    const asked = [...new Set((r.promptRows as readonly { prompt: string }[]).map((x) => x.prompt))].sort()
    expect(asked).toEqual([...edited].sort())
    expect(r.run.source).toBe('hand')
    await fileWorkspaceStore(dir).cycles.put(cycleInputOf(r))
    expect(listCycles(dir, 'acme.test').map((c) => c.day)).toEqual([D])

    // 5. Three daily ticks collect the edited set on its own basis, each a loop-filed cycle.
    for (const n of [1, 2, 3]) {
      const day = untilDay(D, n)!
      const out = await runTick({ dataDir: dir, env: process.env, day, apply: true, mode: 'fixture' })
      if ('refuse' in out) throw new Error(out.refuse)
      expect(out.ran.map((x) => [x.host, x.status])).toEqual([['acme.test', 'scanned']])
      const filed = cycleFile(day)
      expect(filed.comparisonBasis).toBe(r.comparisonBasis)
      expect([...new Set(filed.promptRows.map((x) => x.prompt))].sort()).toEqual([...edited].sort())
      expect(filed.run.source).toBe('loop')
    }
    expect(listCycles(dir, 'acme.test').map((c) => c.day)).toEqual([D, untilDay(D, 1), untilDay(D, 2), untilDay(D, 3)])

    // The fourth tick: the instruction has ended. Nothing runs, the day's list says why, and the dry listing says the same.
    const fourth = await runTick({ dataDir: dir, env: process.env, day: untilDay(D, 4)!, apply: true, mode: 'fixture' })
    if ('refuse' in fourth) throw new Error(fourth.refuse)
    expect(fourth.ran).toEqual([])
    expect(fourth.list.notDue).toEqual([expect.objectContaining({ host: 'acme.test', reason: 'expired' })])
    expect(fourth.capUsd).toBe(0)
    const lines: string[] = []
    await printDue(dir, process.env, untilDay(D, 4)!, (s) => lines.push(s))
    expect(lines.some((l) => /not due\s+acme\.test\s+expired/.test(l))).toBe(true)
    expect(listCycles(dir, 'acme.test')).toHaveLength(4)

    // Switching off is a write of nothing but the removal; switching off a host not tracked writes nothing at all.
    expect(await post(trackedPost, 'tracked', { domain: 'acme.test', on: false })).toMatchObject({ status: 200, body: { tracked: false, trackedInWorkspace: 0 } })
    expect(readTracked(dir)).toEqual([])
    expect(await post(trackedPost, 'tracked', { domain: 'acme.test', on: false })).toMatchObject({ status: 200, body: { tracked: false } })
  })

  it('a second edit is version 2 and a new basis: the next cycle breaks the trend at the version change, by design', async () => {
    const shown = (await post(preview, 'preview', { domain: 'acme.test' })).body as unknown as PreviewResponse
    const bank = shown.prompts.map((p) => p.text)
    expect(await post(customPrompts, 'custom-prompts', { domain: 'acme.test', prompts: bank.slice(0, 5), reason: 'five questions our buyers actually ask' })).toMatchObject({ status: 200, body: { version: 1 } })
    // Switched on under version 1...
    expect(await post(trackedPost, 'tracked', { domain: 'acme.test', on: true, days: 3 })).toMatchObject({ status: 200, body: { prompts: 1, promptsAtSwitch: 1 } })
    expect(await post(customPrompts, 'custom-prompts', { domain: 'acme.test', prompts: bank.slice(0, 6), reason: 'and a sixth, from the sales call' })).toMatchObject({ status: 200, body: { version: 2 } })
    // ...and edited mid-tracking: the record says what tomorrow's cycle WILL ask (version 2), and keeps the switch-time version apart as provenance (C3 stats review).
    expect((await get(trackedGet, 'tracked?domain=acme.test')).body).toMatchObject({ tracked: true, prompts: 2, promptsAtSwitch: 1 })
    const D = today()
    const r = await runGrader({ domain: 'acme.test', plan: 'payg', day: D, engines: [...ENGINES], capUsd: 10, mode: 'fixture', apiKey: '', dataDir: dir, log: () => {} })
    expect(r.status).toBe('scanned')
    if (r.status !== 'scanned') return
    expect(parseBasis(r.comparisonBasis)?.custom).toEqual({ count: 6, version: 2 })
    // The identical list is refused as no change, so a version is never spent on nothing.
    expect(await post(customPrompts, 'custom-prompts', { domain: 'acme.test', prompts: bank.slice(0, 6), reason: 'the same six, sent twice' })).toMatchObject({ status: 400, body: { kind: 'no-change' } })
  })
})
