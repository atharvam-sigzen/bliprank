import { migratedPglite, pgliteDb, TEST_KEY } from '@bliprank/db/testing'
import { mintWorkspaceToken } from '@bliprank/db/token'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionWorkspaceStore } from '../../../../services/grader/src/store/pg-store.js'
import type { AuthUser } from '@/lib/auth/supabase'

/**
 * END TO END ON PGLITE (MVP_PLAN B3b): request → session → token → context →
 * store → response, through the real route handlers, the real migrations and
 * the real policies. The session is the one thing faked, because it is the
 * one thing the database does not verify.
 *
 * Two brand accounts, two workspaces. Every route that reads or writes
 * workspace state must: refuse a request with no session; take the workspace
 * from the session alone, so a body or query naming another workspace or
 * account changes nothing; and show one account nothing of the other's.
 */
const session = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock('@/lib/auth/supabase', () => ({ currentUser: async () => session.user }))
const pgHolder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/auth/db', () => ({ appDb: () => pgHolder.db }))

import { GET as answers } from './answers/route'
import { GET as categoryGet, POST as categoryPost } from './category/route'
import { GET as competitorsGet, POST as competitorsPost } from './competitors/route'
import { GET as promptsGet, POST as promptsPost } from './custom-prompts/route'
import { GET as cycles } from './cycles/route'
import { GET as gaps } from './gaps/route'
import { POST as preview } from './preview/route'
import { POST as scan } from './scan/route'
import { NOT_SIGNED_IN } from '@/lib/auth/handlers'

let pg: Awaited<ReturnType<typeof migratedPglite>>
let dir: string
const ONE: AuthUser = { id: '66666666-0000-4000-8000-000000000001', email: 'one@brand.test' }
const TWO: AuthUser = { id: '66666666-0000-4000-8000-000000000002', email: 'two@brand.test' }
const ws: Record<string, { account: string; workspace: string }> = {}
const originalEnv = { ...process.env }

beforeAll(async () => {
  pg = await migratedPglite()
  pgHolder.db = pgliteDb(pg)
  const app = pgliteDb(pg)
  for (const [u, name] of [[ONE, 'One'], [TWO, 'Two']] as const) {
    await app.query('SELECT ensure_account($1, $2, $3)', [u.id, u.email, 'brand'])
    await app.query('SELECT create_workspace($1, $2)', [u.id, name])
    const [row] = await app.query<{ account_id: string; workspace_id: string }>('SELECT account_id, workspace_id FROM workspaces_of($1)', [u.id])
    ws[u.id] = { account: row!.account_id, workspace: row!.workspace_id }
  }
})
afterAll(async () => {
  await pg.close()
})
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-session-store-'))
  Object.assign(process.env, {
    GRADER_DATA_DIR: dir,
    TRUSTED_PROXY: 'cloudflare',
    SUPABASE_URL: 'https://x.supabase.test',
    SUPABASE_PUBLISHABLE_KEY: 'pk',
    DATABASE_URL: 'postgres://app_rw@pooler.test/db',
    AUTH_SIGNING_KID: TEST_KEY.kid,
    AUTH_SIGNING_SECRET: TEST_KEY.secret,
    AUTH_ISSUER: TEST_KEY.issuer,
    AUTH_AUDIENCE: TEST_KEY.audience,
    SITE_URL: 'https://bliprank.test',
  })
  delete process.env['COLLECTION_ENABLED']
  delete process.env['GRADER_LIVE_SCAN']
  session.user = null
})
afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(dir, { recursive: true, force: true })
})

/** The store as the app would open it for `u`: a real token for that account's workspace. */
const storeOf = (u: AuthUser) => sessionWorkspaceStore(pgliteDb(pg), mintWorkspaceToken(TEST_KEY, { sub: ws[u.id]!.account, workspaceId: ws[u.id]!.workspace }))

let ip = 0
const headers = () => ({ 'cf-connecting-ip': `10.0.0.${++ip % 250}`, 'Content-Type': 'application/json' })
const get = (fn: (r: Request) => Promise<Response>, path: string) => fn(new Request(`http://local/api/${path}`, { headers: headers() }))
const post = (fn: (r: Request) => Promise<Response>, path: string, body: unknown) => fn(new Request(`http://local/api/${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) }))
const RECORD = { slug: 'crm-software', source: 'site-content', evidence: 'pipeline', decidedAt: '2026-09-01T00:00:00.000Z', generated: false, brandName: 'Acme' }
const CYCLE = (day: string) => ({
  status: 'scanned',
  domain: 'acme.test',
  category: 'crm-software',
  categoryName: 'CRM software',
  comparisonBasis: 'crm-software@1|engines=chatgpt|prompts=1',
  algoVersion: 'det-3',
  collectedAt: `${day}T10:00:00.000Z`,
  counts: { cellsRequested: 1, cacheHits: 0, collected: 1, failed: 0, answersScored: 1, providerCalls: 1 },
  brands: [],
  run: { mode: 'live', plan: 'payg', day, engines: ['chatgpt'], capUsd: 5, at: `${day}T10:01:00.000Z` },
})

describe('no session: every workspace route refuses before touching anything', () => {
  it('the seven JSON routes answer 401 with one fixed sentence', async () => {
    const calls: [string, () => Promise<Response>][] = [
      ['cycles', () => get(cycles, 'cycles?domain=acme.test')],
      ['answers', () => get(answers, 'answers?domain=acme.test')],
      ['gaps', () => get(gaps, 'gaps?domain=acme.test')],
      ['category GET', () => get(categoryGet, 'category?domain=acme.test')],
      ['category POST', () => post(categoryPost, 'category', { domain: 'acme.test', slug: 'hr-payroll-software', reason: 'a reason long enough to pass' })],
      ['competitors GET', () => get(competitorsGet, 'competitors?domain=acme.test')],
      ['competitors POST', () => post(competitorsPost, 'competitors', { domain: 'acme.test', exclude: ['hubspot'], include: [], reason: 'a reason long enough to pass' })],
      ['custom-prompts GET', () => get(promptsGet, 'custom-prompts?domain=acme.test')],
      ['custom-prompts POST', () => post(promptsPost, 'custom-prompts', { domain: 'acme.test', prompts: ['what is the best crm for a small bakery'], reason: 'a reason long enough to pass' })],
      ['preview', () => post(preview, 'preview', { domain: 'acme.test' })],
    ]
    for (const [name, call] of calls) {
      const res = await call()
      expect([name, res.status]).toEqual([name, 401])
      expect([name, ((await res.json()) as { message: string }).message]).toEqual([name, NOT_SIGNED_IN])
    }
  })

  it('the scan stream ends with the same refusal, and no ledger is touched', async () => {
    const res = await post(scan, 'scan', { domain: 'acme.test' })
    const text = await res.text()
    expect(text).toContain('event: error')
    expect(text).toContain(NOT_SIGNED_IN)
    expect((await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM workspace_cycles')).rows).toEqual([{ n: 0 }])
  })
})

describe('request → session → token → context → store → response', () => {
  it('a filed request lands in the session\'s workspace, whatever workspace or account the body names', async () => {
    await storeOf(ONE).documents.put('category-record', 'acme.test', RECORD, 0)
    session.user = ONE
    const res = await post(categoryPost, 'category', {
      domain: 'acme.test',
      slug: 'hr-payroll-software',
      reason: 'the site sells payroll software, not CRM',
      // Fields nothing reads: the workspace is the session's.
      workspace_id: ws[TWO.id]!.workspace,
      workspaceId: ws[TWO.id]!.workspace,
      account_id: ws[TWO.id]!.account,
    })
    expect(res.status).toBe(200)
    const rows = await pg.query<{ workspace_id: string; host: string; kind: string; status: string }>('SELECT workspace_id, host, kind, status FROM workspace_requests')
    expect(rows.rows).toEqual([{ workspace_id: ws[ONE.id]!.workspace, host: 'acme.test', kind: 'category', status: 'pending' }])
    // GET shows it pending for One...
    const one = (await (await get(categoryGet, 'category?domain=acme.test')).json()) as { pending: { slug: string } | null; record: { version: number } }
    expect(one.pending?.slug).toBe('hr-payroll-software')
    expect(one.record.version).toBe(1)
    // ...and Two has no record of acme.test at all: a 404, not One's record.
    session.user = TWO
    expect((await get(categoryGet, `category?domain=acme.test&workspace=${ws[ONE.id]!.workspace}`)).status).toBe(404)
    expect((await get(competitorsGet, 'competitors?domain=acme.test')).status).toBe(404)
    expect((await get(promptsGet, 'custom-prompts?domain=acme.test')).status).toBe(404)
  })

  it('cycles are listed from the session\'s workspace; a query naming another workspace is a field nothing reads', async () => {
    await storeOf(ONE).cycles.put({ host: 'acme.test', day: '2026-09-01', algoVersion: 'det-3', comparisonBasis: 'b', result: CYCLE('2026-09-01') })
    await storeOf(ONE).cycles.put({ host: 'acme.test', day: '2026-09-08', algoVersion: 'det-3', comparisonBasis: 'b', result: CYCLE('2026-09-08') })
    await storeOf(TWO).cycles.put({ host: 'acme.test', day: '2026-09-03', algoVersion: 'det-3', comparisonBasis: 'b', result: CYCLE('2026-09-03') })
    session.user = ONE
    const res = await get(cycles, `cycles?domain=acme.test&workspace=${ws[TWO.id]!.workspace}&workspace_id=${ws[TWO.id]!.workspace}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { cycles: { run: { day: string } }[] }).cycles.map((c) => c.run.day)).toEqual(['2026-09-01', '2026-09-08'])
    session.user = TWO
    expect(((await (await get(cycles, 'cycles?domain=acme.test')).json()) as { cycles: { run: { day: string } }[] }).cycles.map((c) => c.run.day)).toEqual(['2026-09-03'])
    // The evidence route reads the same cycle through the same token: Two's cycle names a category with no stored answers, so it refuses on the answers, not on access.
    const ev = await get(answers, 'answers?domain=acme.test&day=2026-09-01')
    expect(ev.status).toBe(404)
    expect(((await ev.json()) as { message: string }).message).toContain('no stored cycle of acme.test for 2026-09-01')
  })

  it('the competitor and prompt requests file into the session\'s workspace too, and the other account sees none', async () => {
    // The record from the first case stands (one database for the file); a re-write here would be a version 2 nobody decided.
    expect((await storeOf(ONE).documents.latest('category-record', 'acme.test'))?.version).toBe(1)
    session.user = ONE
    expect((await post(competitorsPost, 'competitors', { domain: 'acme.test', exclude: ['hubspot'], include: [], reason: 'our integration partner, not a rival', workspace_id: ws[TWO.id]!.workspace })).status).toBe(200)
    expect((await post(promptsPost, 'custom-prompts', { domain: 'acme.test', prompts: ['which crm suits a two-person bakery'], reason: 'our buyers ask this exact question', workspace_id: ws[TWO.id]!.workspace })).status).toBe(200)
    const rows = await pg.query<{ workspace_id: string; kind: string }>(`SELECT workspace_id, kind FROM workspace_requests WHERE kind <> 'category' ORDER BY kind`)
    expect(rows.rows).toEqual([
      { workspace_id: ws[ONE.id]!.workspace, kind: 'competitors' },
      { workspace_id: ws[ONE.id]!.workspace, kind: 'custom-prompts' },
    ])
    session.user = TWO
    expect((await post(competitorsPost, 'competitors', { domain: 'acme.test', exclude: ['hubspot'], include: [], reason: 'our integration partner, not a rival' })).status).toBe(404)
  })

  it('a session with no account, or an account with no workspace, is refused with the route\'s own status', async () => {
    session.user = { id: '66666666-0000-4000-8000-000000000009', email: 'ghost@brand.test' }
    expect((await get(cycles, 'cycles?domain=acme.test')).status).toBe(404)
    const app = pgliteDb(pg)
    const LONE: AuthUser = { id: '66666666-0000-4000-8000-00000000000a', email: 'lone@brand.test' }
    await app.query('SELECT ensure_account($1, $2, $3)', [LONE.id, LONE.email, 'brand'])
    session.user = LONE
    expect((await get(cycles, 'cycles?domain=acme.test')).status).toBe(409)
  })
})
