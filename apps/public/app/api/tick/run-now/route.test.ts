/**
 * The machine's own entry to the daily tick (MVP_PLAN P1) and the status the
 * panel reads (P2), through the REAL routes over a scratch data directory.
 * Nothing here can spend: no case sets both of the owner's acts and a tracked
 * domain, the collector is never reached, and no provider key exists.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/supabase', () => ({ currentUser: async () => null }))
vi.mock('@/lib/auth/db', () => ({ appDb: () => null }))

import { NOBODY_TRACKED, NOT_LOCAL, NO_CAP } from '@/lib/local-tick'
import { recordCategory } from '../../../../../../services/grader/src/resolve-category.js'
import { setTracked } from '../../../../../../services/grader/src/due.js'
import { dailyLedgerFile } from '../../../../../../services/grader/src/daily-loop.js'
import { existsSync } from 'node:fs'
import { POST } from './route'
import { GET as status } from '../status/route'

let dir: string
const originalEnv = { ...process.env }
const IDENTITY = { SUPABASE_URL: 'https://x.supabase.test', SUPABASE_PUBLISHABLE_KEY: 'pk', DATABASE_URL: 'postgres://app_rw@pooler.test/db', AUTH_SIGNING_KID: 'kid', AUTH_SIGNING_SECRET: 's'.repeat(48), AUTH_ISSUER: 'https://issuer.test', AUTH_AUDIENCE: 'aud', SITE_URL: 'https://site.test' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-run-now-'))
  process.env = { ...originalEnv, GRADER_DATA_DIR: dir, COLLECTOR_TOPOLOGY: 'single-process' }
  for (const k of ['COLLECTION_ENABLED', 'GRADER_LIVE_SCAN', 'COLLECTION_BUDGET_USD_DAILY', 'GRADER_DAILY_LOOP', 'OPENWEBNINJA_API_KEY', 'OPENWEBNINJA_PLAN', 'VERCEL', ...Object.keys(IDENTITY)]) delete process.env[k]
  // ⚠️ SAFE BY CONSTRUCTION, NOT BY CONVENTION (cost review of P1, MAJOR 1). These cases run the REAL route, whose root is the real
  // repository: any variable a case does not set falls through to this machine's own dotenv, which may hold a real provider key,
  // the live flag, the daily cap and, one day, an armed loop. So the loop's explicit off switch is set for EVERY case in this
  // file. It is the last thing `localArming` asks, so every refusal below is still reached in its order, and no case here, now
  // or added later, can reach a tick.
  process.env['GRADER_DAILY_LOOP'] = 'off'
  recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-08-01', generated: false })
})
afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(dir, { recursive: true, force: true })
})

const press = async (headers: Record<string, string> = {}) => {
  const res = await POST(new Request('http://127.0.0.1:3001/api/tick/run-now', { method: 'POST', headers }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('POST /api/tick/run-now', () => {
  it('IS 404 WITH IDENTITY ON: the unsigned entry exists only on the owner’s machine; a deployment’s transport is the signed route beside it', async () => {
    Object.assign(process.env, IDENTITY)
    expect(await press()).toEqual({ status: 404, body: { kind: 'not-local', message: NOT_LOCAL } })
    expect((await status()).status).toBe(404)
  })

  it('is 404 on a fleet, declared or by marker, whatever else is set', async () => {
    process.env['COLLECTOR_TOPOLOGY'] = 'fleet'
    expect((await press()).status).toBe(404)
    process.env['COLLECTOR_TOPOLOGY'] = 'single-process'
    process.env['VERCEL'] = '1'
    expect((await press()).status).toBe(404)
  })

  it('on the machine, refuses with the fixed sentence for the first thing missing, and nothing is written or spent', async () => {
    // This machine's own dotenv may arm a real loop; the environment wins over the file, so each act is set or blanked here explicitly.
    process.env['COLLECTION_BUDGET_USD_DAILY'] = 'not set'
    expect(await press()).toEqual({ status: 409, body: { kind: 'no-cap', message: NO_CAP } })
    process.env['COLLECTION_BUDGET_USD_DAILY'] = '2'
    process.env['GRADER_LIVE_SCAN'] = 'true'
    expect(await press()).toEqual({ status: 409, body: { kind: 'nobody-tracked', message: NOBODY_TRACKED } })
    expect(existsSync(dailyLedgerFile(dir))).toBe(false)
  })

  it('a press that another site put in the owner’s browser is refused before anything is read', async () => {
    process.env['COLLECTION_BUDGET_USD_DAILY'] = '2'
    process.env['GRADER_LIVE_SCAN'] = 'true'
    // ⚠️ THIS CASE HOLDS BOTH ACTS AND A TRACKED DOMAIN, and this machine's real dotenv may hold a real key. So the loop's explicit off
    // switch is set as well: were the origin check ever to fail, the answer would be 409 "switched off" (and this test red), never a live tick.
    process.env['GRADER_DAILY_LOOP'] = 'off'
    setTracked(dir, 'acme.test', true, { by: 'local', reason: 'r' })
    for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://evil.example' }, { origin: 'null' }]) {
      expect(await press(headers), JSON.stringify(headers)).toMatchObject({ status: 403, body: { kind: 'origin' } })
    }
    expect(existsSync(dailyLedgerFile(dir))).toBe(false)
  })
})

describe('GET /api/tick/status', () => {
  it('on the machine: what is tracked, that nothing has run, and the fixed sentence for why a run could not start', async () => {
    process.env['COLLECTION_BUDGET_USD_DAILY'] = 'not set'
    process.env['GRADER_LIVE_SCAN'] = 'false'
    setTracked(dir, 'acme.test', true, { by: 'local', reason: 'r' })
    const res = await status()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ local: true, tickAt: '06:15', armed: false, notArmed: NO_CAP, tracked: ['acme.test'], today: null, yesterday: null, missedToday: false, failedPublishes: [] })
  })
})
