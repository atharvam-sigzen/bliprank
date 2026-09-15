import type { Db } from '@bliprank/db/client'
import { migratedPglite, pgliteDb, TEST_KEY } from '@bliprank/db/testing'
import { mintWorkspaceToken } from '@bliprank/db/token'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionWorkspaceStore } from '../../../../services/grader/src/store/pg-store.js'
import type { AuthUser } from '@/lib/auth/supabase'

/**
 * END TO END ON PGLITE (MVP_PLAN B3b, B4): request → session → token →
 * context → store → response, through the real route handlers, the real
 * migrations and the real policies. The session is the one thing faked,
 * because it is the one thing the database does not verify.
 *
 * Two brand accounts with a workspace each, and a member of the first.
 * Every route that reads or writes workspace state must: refuse a request
 * with no session; take the workspace from the session alone, so a body or
 * query naming another workspace or account changes nothing; show one
 * account nothing of the other's. A member files a request; an owner
 * applies, version N+1 with the history intact, and the request that asked
 * for it is marked applied.
 */
const session = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock('@/lib/auth/supabase', () => ({ currentUser: async () => session.user }))
const pgHolder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/auth/db', () => ({ appDb: () => pgHolder.db }))
// The gap report's homepage read is the one thing in these routes that would
// open a socket; it is served from here, and counted, so the cap cases below
// exercise the ledger and never the network.
const pages = vi.hoisted(() => ({ fetched: [] as string[] }))
vi.mock('../../../../services/grader/src/fetch-site.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../services/grader/src/fetch-site.js')>()
  return {
    ...actual,
    fetchSiteHtml: vi.fn(async (domain: string) => {
      pages.fetched.push(domain)
      return { ok: true, html: '<html><head><title>Acme</title></head><body><h1>Acme CRM</h1><p>A CRM for small teams.</p></body></html>', finalUrl: `https://${domain}/`, bytes: 120, truncated: false }
    }),
  }
})

import { defaultDomainCeilingConfig, recordDomainCycle } from '../../../../services/grader/src/domain-ceiling.js'
import { defaultGateConfig, recordScan } from '../../../../services/grader/src/live-gate.js'
import { ledgerStores } from '../../../../services/grader/src/ledger-stores.js'
import { GET as answers } from './answers/route'
import { GET as categoryGet, POST as categoryPost } from './category/route'
import { GET as competitorsGet, POST as competitorsPost } from './competitors/route'
import { GET as promptsGet, POST as promptsPost } from './custom-prompts/route'
import { GET as cycles } from './cycles/route'
import { GET as gaps } from './gaps/route'
import { POST as preview } from './preview/route'
import { POST as scan } from './scan/route'
import { NOT_SIGNED_IN } from '@/lib/auth/handlers'
import { FIRST_RECORD_NEEDS_OPERATOR, READ_AGAIN } from '@/lib/workspace-access'

/**
 * The app's Db with one race on demand (B3c item 7): while `race.armed`, the
 * next ws_put_document is preceded, in the same transaction and context, by
 * the identical write from another tab of the same owner, so the route's own
 * write then names a version that is no longer current. PGlite is one
 * connection, so the other tab cannot be a second transaction; inside the
 * same one it exercises the same check under the same lock.
 */
const race = vi.hoisted(() => ({ armed: false }))
const raced = (real: Db): Db => ({
  query: (text, params) => real.query(text, params),
  transaction: (fn) =>
    real.transaction((tx) =>
      fn({
        transaction: tx.transaction,
        query: async <T,>(text: string, params: readonly unknown[] = []) => {
          if (race.armed && /ws_put_document/.test(text)) {
            race.armed = false
            await tx.query(text, params)
          }
          return tx.query<T>(text, params)
        },
      }),
    ),
})

let pg: Awaited<ReturnType<typeof migratedPglite>>
let dir: string
const ONE: AuthUser = { id: '66666666-0000-4000-8000-000000000001', email: 'one@brand.test' }
const TWO: AuthUser = { id: '66666666-0000-4000-8000-000000000002', email: 'two@brand.test' }
const MEMBER: AuthUser = { id: '66666666-0000-4000-8000-000000000003', email: 'member@brand.test' }
const ws: Record<string, { account: string; workspace: string; role: 'owner' | 'member' }> = {}
const originalEnv = { ...process.env }

beforeAll(async () => {
  pg = await migratedPglite()
  pgHolder.db = raced(pgliteDb(pg))
  const app = pgliteDb(pg)
  for (const [u, name] of [[ONE, 'One'], [TWO, 'Two']] as const) {
    await app.query('SELECT ensure_account($1, $2, $3)', [u.id, u.email, 'brand'])
    await app.query('SELECT create_workspace($1, $2)', [u.id, name])
    const [row] = await app.query<{ account_id: string; workspace_id: string }>('SELECT account_id, workspace_id FROM workspaces_of($1)', [u.id])
    ws[u.id] = { account: row!.account_id, workspace: row!.workspace_id, role: 'owner' }
  }
  // A member of One's workspace: an account with no workspace of its own, added by the onboarding role.
  const [m] = await app.query<{ id: string }>('SELECT ensure_account($1, $2, $3) AS id', [MEMBER.id, MEMBER.email, 'brand'])
  await pgliteDb(pg, 'svc_onboard').query('INSERT INTO workspace_members (workspace_id, account_id, role) VALUES ($1, $2, $3)', [ws[ONE.id]!.workspace, m!.id, 'member'])
  ws[MEMBER.id] = { account: m!.id, workspace: ws[ONE.id]!.workspace, role: 'member' }
})
afterAll(async () => {
  await pg.close()
})
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-session-store-'))
  Object.assign(process.env, {
    GRADER_DATA_DIR: dir,
    COLLECTOR_TOPOLOGY: 'single-process',
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
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

/** The store as the app would open it for `u`: a real token for that account's workspace. */
const storeOf = (u: AuthUser) => sessionWorkspaceStore(pgliteDb(pg), mintWorkspaceToken(TEST_KEY, { sub: ws[u.id]!.account, workspaceId: ws[u.id]!.workspace, role: ws[u.id]!.role }))

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
/** The body fields nothing reads: the workspace is the session's. */
const naming = () => ({ workspace_id: ws[TWO.id]!.workspace, workspaceId: ws[TWO.id]!.workspace, account_id: ws[TWO.id]!.account })

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
  it('a member\'s filing lands in the session\'s workspace as a pending request, whatever workspace or account the body names', async () => {
    await storeOf(ONE).documents.put('category-record', 'acme.test', RECORD, 0)
    session.user = MEMBER
    const res = await post(categoryPost, 'category', { domain: 'acme.test', slug: 'hr-payroll-software', reason: 'the site sells payroll software, not CRM', ...naming() })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { applied?: boolean }).applied).toBeUndefined()
    const rows = await pg.query<{ workspace_id: string; host: string; kind: string; status: string }>('SELECT workspace_id, host, kind, status FROM workspace_requests')
    expect(rows.rows).toEqual([{ workspace_id: ws[ONE.id]!.workspace, host: 'acme.test', kind: 'category', status: 'pending' }])
    // GET shows it pending for the owner, the record untouched...
    session.user = ONE
    const one = (await (await get(categoryGet, 'category?domain=acme.test')).json()) as { pending: { slug: string } | null; record: { version: number } }
    expect(one.pending?.slug).toBe('hr-payroll-software')
    expect(one.record.version).toBe(1)
    // ...and Two has no record of acme.test at all: a 404, not One's record.
    session.user = TWO
    expect((await get(categoryGet, `category?domain=acme.test&workspace=${ws[ONE.id]!.workspace}`)).status).toBe(404)
    expect((await get(competitorsGet, 'competitors?domain=acme.test')).status).toBe(404)
    expect((await get(promptsGet, 'custom-prompts?domain=acme.test')).status).toBe(404)
  })

  it('the owner\'s POST applies the correction: version 2, version 1 kept, the pending request marked applied by the owner (B4)', async () => {
    session.user = ONE
    const res = await post(categoryPost, 'category', { domain: 'acme.test', slug: 'hr-payroll-software', reason: 'the site sells payroll software, not CRM', ...naming() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { applied: boolean; version: number; request: { status: string; slug: string } }
    expect(body).toMatchObject({ applied: true, version: 2, request: { status: 'applied', slug: 'hr-payroll-software' } })
    // Two rows for the host in One's workspace, none anywhere else; the request is resolved by the owner's account.
    const docs = await pg.query<{ workspace_id: string; version: number; slug: string }>(`SELECT workspace_id, version, body->>'slug' AS slug FROM workspace_documents WHERE kind = 'category-record' ORDER BY version`)
    expect(docs.rows).toEqual([
      { workspace_id: ws[ONE.id]!.workspace, version: 1, slug: 'crm-software' },
      { workspace_id: ws[ONE.id]!.workspace, version: 2, slug: 'hr-payroll-software' },
    ])
    const reqs = await pg.query<{ status: string; resolved_by: string }>(`SELECT status, resolved_by FROM workspace_requests WHERE kind = 'category'`)
    expect(reqs.rows).toEqual([{ status: 'applied', resolved_by: ws[ONE.id]!.account }])
    const status = (await (await get(categoryGet, 'category?domain=acme.test')).json()) as { record: { version: number; slug: string; corrections: { from: string; to: string }[] }; pending: unknown; history: { status: string }[] }
    expect(status.record).toMatchObject({ version: 2, slug: 'hr-payroll-software', corrections: [{ from: 'crm-software', to: 'hr-payroll-software' }] })
    expect(status.pending).toBeNull()
    expect(status.history.map((h) => h.status)).toEqual(['applied'])
    // The same slug again is nothing to correct: refused, and version 2 stands.
    expect((await post(categoryPost, 'category', { domain: 'acme.test', slug: 'hr-payroll-software', reason: 'the site sells payroll software, not CRM' })).status).toBe(422)
    expect((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_documents WHERE kind = 'category-record'`)).rows).toEqual([{ n: 2 }])
    // A member cannot apply: the same POST from the member files a request instead.
    session.user = MEMBER
    const filed = await post(categoryPost, 'category', { domain: 'acme.test', slug: 'crm-software', reason: 'no, it really is a CRM after all' })
    expect(filed.status).toBe(200)
    expect(((await filed.json()) as { applied?: boolean }).applied).toBeUndefined()
    expect((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_documents WHERE kind = 'category-record'`)).rows).toEqual([{ n: 2 }])
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
    // The evidence route reads the same cycle through the same token: Two holds no 2026-09-01, so it refuses on the cycle, not on access.
    const ev = await get(answers, 'answers?domain=acme.test&day=2026-09-01')
    expect(ev.status).toBe(404)
    expect(((await ev.json()) as { message: string }).message).toContain('no stored cycle of acme.test for 2026-09-01')
  })

  it('competitors and prompts: a member files, the owner applies version 1 of each and the requests are marked applied; the other account sees none (B4)', async () => {
    session.user = MEMBER
    // acme.test is hr-payroll-software since the correction above; gusto leads that bank.
    expect((await post(competitorsPost, 'competitors', { domain: 'acme.test', exclude: ['gusto'], include: [], reason: 'our integration partner, not a rival', ...naming() })).status).toBe(200)
    expect((await post(promptsPost, 'custom-prompts', { domain: 'acme.test', prompts: ['which payroll tool suits a two-person bakery'], reason: 'our buyers ask this exact question', ...naming() })).status).toBe(200)
    expect((await pg.query<{ kind: string; status: string }>(`SELECT kind, status FROM workspace_requests WHERE kind <> 'category' ORDER BY kind`)).rows).toEqual([
      { kind: 'competitors', status: 'pending' },
      { kind: 'custom-prompts', status: 'pending' },
    ])
    session.user = ONE
    const o = await post(competitorsPost, 'competitors', { domain: 'acme.test', exclude: ['gusto'], include: [], reason: 'our integration partner, not a rival' })
    expect(o.status).toBe(200)
    expect(await o.json()).toMatchObject({ applied: true, version: 1, request: { status: 'applied', exclude: ['gusto'] } })
    const p = await post(promptsPost, 'custom-prompts', { domain: 'acme.test', prompts: ['which payroll tool suits a two-person bakery'], reason: 'our buyers ask this exact question' })
    expect(p.status).toBe(200)
    expect(await p.json()).toMatchObject({ applied: true, version: 1 })
    expect((await pg.query<{ kind: string; status: string; resolved_by: string }>(`SELECT kind, status, resolved_by FROM workspace_requests WHERE kind <> 'category' ORDER BY kind`)).rows).toEqual([
      { kind: 'competitors', status: 'applied', resolved_by: ws[ONE.id]!.account },
      { kind: 'custom-prompts', status: 'applied', resolved_by: ws[ONE.id]!.account },
    ])
    const comp = (await (await get(competitorsGet, 'competitors?domain=acme.test')).json()) as { set: number | null; excluded: { id: string }[] }
    expect(comp.set).toBe(1)
    expect(comp.excluded.map((e) => e.id)).toEqual(['gusto'])
    // The same lists again are no change: refused, version 1 stands.
    expect((await post(competitorsPost, 'competitors', { domain: 'acme.test', exclude: ['gusto'], include: [], reason: 'a different reason for the same set' })).status).toBe(400)
    expect((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_documents WHERE kind = 'competitor-override'`)).rows).toEqual([{ n: 1 }])
    session.user = TWO
    expect((await post(competitorsPost, 'competitors', { domain: 'acme.test', exclude: ['gusto'], include: [], reason: 'our integration partner, not a rival' })).status).toBe(404)
    expect((await get(promptsGet, 'custom-prompts?domain=acme.test')).status).toBe(404)
  })

  it('the per-domain cap is the workspace\'s: six corrections of one host in Two do not block One\'s owner (B4 audit, MAJOR 2)', async () => {
    await storeOf(TWO).documents.put('category-record', 'acme.test', RECORD, 0)
    session.user = TWO
    // Six applied corrections of acme.test in Two (the cap's default), each a real change, then the seventh is the cap.
    const slugs = ['hr-payroll-software', 'crm-software', 'hr-payroll-software', 'crm-software', 'hr-payroll-software', 'crm-software', 'seo-tools']
    const statuses: number[] = []
    for (const slug of slugs) statuses.push((await post(categoryPost, 'category', { domain: 'acme.test', slug, reason: 'a reason long enough to pass the check' })).status)
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429])
    // One is not capped by Two's activity (its member files against the same cap, keyed by One), and the 429 above named nothing of One's.
    session.user = MEMBER
    const res = await post(categoryPost, 'category', { domain: 'acme.test', slug: 'seo-tools', reason: 'a reason long enough to pass the check' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { request: { slug: string } }).request.slug).toBe('seo-tools')
  })

  it('a member\'s token cannot apply even with the application gate bypassed: the store\'s write and resolve are refused at the database (B3c item 8)', async () => {
    const member = storeOf(MEMBER)
    await expect(member.documents.put('category-record', 'acme.test', { ...RECORD, slug: 'seo-tools' }, 2)).rejects.toThrow(/only an owner or admin applies a decision; this session is member/)
    const pending = await member.requests.pending<{ slug: string }>('category', 'acme.test')
    expect(pending).not.toBeNull()
    await expect(member.requests.resolve('category', 'acme.test', pending!.requestedAt, { status: 'applied', by: 'member' })).rejects.toThrow(/only an owner or admin/)
    // The member still reads the workspace, and nothing of the refused writes landed.
    expect((await member.documents.latest('category-record', 'acme.test'))?.version).toBe(2)
    expect((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_documents WHERE workspace_id = $1 AND kind = 'category-record' AND host = 'acme.test'`, [ws[ONE.id]!.workspace])).rows).toEqual([{ n: 2 }])
    expect((await pg.query<{ status: string }>(`SELECT status FROM workspace_requests WHERE workspace_id = $1 AND kind = 'category' AND host = 'acme.test' AND status = 'pending'`, [ws[ONE.id]!.workspace])).rows).toEqual([{ status: 'pending' }])
  })

  it('a member\'s preview or scan of a domain with no record is refused before anything is fetched, authored or charged; with a record on file it is served (B3c tenancy audit, MAJOR 3)', async () => {
    session.user = MEMBER
    pages.fetched.length = 0
    const pv = await post(preview, 'preview', { domain: 'fresh.test' })
    expect(pv.status).toBe(403)
    expect(await pv.json()).toEqual({ kind: 'operator-only', message: FIRST_RECORD_NEEDS_OPERATOR })
    expect(pages.fetched).toEqual([])
    Object.assign(process.env, { COLLECTION_ENABLED: 'true', GRADER_LIVE_SCAN: 'true', OPENWEBNINJA_API_KEY: 'test-key-never-used' })
    const fetchSpy = vi.fn(async () => {
      throw new Error('the test never reaches a network')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const text = await (await post(scan, 'scan', { domain: 'fresh.test' })).text()
    const err = /^event: error\ndata: (.*)$/m.exec(text)
    expect(JSON.parse(err![1]!)).toEqual({ kind: 'operator-only', message: FIRST_RECORD_NEEDS_OPERATOR })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_documents WHERE host = 'fresh.test'`)).rows).toEqual([{ n: 0 }])
    // With the owner's record on file the member's preview reads it: rung 0, nothing fetched or authored.
    await storeOf(ONE).documents.put('category-record', 'fresh.test', RECORD, 0)
    const again = await post(preview, 'preview', { domain: 'fresh.test' })
    expect(again.status).toBe(200)
    expect(pages.fetched).toEqual([])
  })

  it('a correction that loses the version race is a 409 read-again, nothing of it lands, and read again it applies (B3c item 7)', async () => {
    await storeOf(ONE).documents.put('category-record', 'race.test', RECORD, 0)
    session.user = ONE
    race.armed = true
    const body = { domain: 'race.test', slug: 'hr-payroll-software', reason: 'the site sells payroll software, not CRM' }
    const res = await post(categoryPost, 'category', body)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ kind: 'read-again', message: READ_AGAIN })
    expect(race.armed).toBe(false)
    // The transaction the race ran in is rolled back whole: version 1 stands, and no request of race.test was filed or applied.
    expect((await pg.query<{ version: number }>(`SELECT version FROM workspace_documents WHERE kind = 'category-record' AND host = 'race.test' ORDER BY version`)).rows).toEqual([{ version: 1 }])
    expect((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_requests WHERE host = 'race.test'`)).rows).toEqual([{ n: 0 }])
    // Read again, the same decision against what stands now applies.
    const again = await post(categoryPost, 'category', body)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ applied: true, version: 2 })
  })

  it('the burst-cap refusal names no host another workspace scanned: the ledger is the deployment\'s, the sentence is the visitor\'s (B3c item 1)', async () => {
    // Both collection flags on and a key present, so the scan reaches the gate;
    // the network is stubbed shut, and the gate must refuse before it is asked.
    Object.assign(process.env, { COLLECTION_ENABLED: 'true', GRADER_LIVE_SCAN: 'true', OPENWEBNINJA_API_KEY: 'test-key-never-used', GRADER_MAX_NEW_SCANS_PER_DAY: '1' })
    const fetchSpy = vi.fn(async () => {
      throw new Error('the test never reaches a network')
    })
    vi.stubGlobal('fetch', fetchSpy)
    // Two's client was scanned today, on the ledger every workspace of this deployment shares.
    const ledgers = ledgerStores(dir, process.env)
    await recordScan('client-of-two.test', defaultGateConfig(dir, process.env, ledgers), new Date())
    session.user = ONE
    const text = await (await post(scan, 'scan', { domain: 'newco.test' })).text()
    const err = /^event: error\ndata: (.*)$/m.exec(text)
    expect(err).not.toBeNull()
    const data = JSON.parse(err![1]!) as { kind: string; message: string }
    expect(data.kind).toBe('burst-cap')
    expect(data.message).toContain('has been reached')
    expect(text).not.toContain('client-of-two.test')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_cycles WHERE host = 'newco.test'`)).rows).toEqual([{ n: 0 }])
  })

  it('the per-domain cycle ceiling is the workspace\'s: Two\'s two hand-started cycles of acme.test do not refuse One a new cycle, and Two is refused on its own (B3d item 1)', async () => {
    Object.assign(process.env, { COLLECTION_ENABLED: 'true', GRADER_LIVE_SCAN: 'true', OPENWEBNINJA_API_KEY: 'test-key-never-used' })
    const fetchSpy = vi.fn(async () => {
      throw new Error('the test never reaches a network')
    })
    vi.stubGlobal('fetch', fetchSpy)
    // Two's month on the deployment-wide ledger: two hand-started cycles of acme.test, the default ceiling.
    const cfg = defaultDomainCeilingConfig(dir, process.env, ledgerStores(dir, process.env))
    for (let i = 0; i < cfg.maxCyclesPerMonth; i++) await recordDomainCycle({ workspaceId: ws[TWO.id]!.workspace, host: 'acme.test' }, 85, cfg, new Date())
    const errorOf = (text: string) => JSON.parse(/^event: error\ndata: (.*)$/m.exec(text)![1]!) as { kind: string; message: string }
    // One holds cycles and a record of acme.test, so a new cycle passes every check up to the provider gate, whose fetch is shut: the refusal is the gate's, not the ceiling's.
    session.user = ONE
    const one = errorOf(await (await post(scan, 'scan', { domain: 'acme.test', cycle: 'new' })).text())
    expect(one.kind).toBe('unreadable')
    expect(fetchSpy).toHaveBeenCalled()
    // Two, at its own ceiling, is refused before the gate is asked, and the sentence names only its own count.
    fetchSpy.mockClear()
    session.user = TWO
    const two = errorOf(await (await post(scan, 'scan', { domain: 'acme.test', cycle: 'new' })).text())
    expect(two.kind).toBe('domain-ceiling')
    expect(two.message).toContain('This workspace has started its 2 hand-started cycles of acme.test')
    expect(two.message).not.toContain(ws[ONE.id]!.workspace)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the per-domain gap-report cap is the workspace\'s: Two reading acme.test to its cap does not cap One (B3c item 2)', async () => {
    process.env['GRADER_MAX_GAP_REPORTS_PER_DOMAIN_PER_HOUR'] = '2'
    await storeOf(ONE).cycles.put({ host: 'acme.test', day: '2026-09-11', algoVersion: 'det-3', comparisonBasis: 'b', result: CYCLE('2026-09-11') })
    await storeOf(TWO).cycles.put({ host: 'acme.test', day: '2026-09-12', algoVersion: 'det-3', comparisonBasis: 'b', result: CYCLE('2026-09-12') })
    pages.fetched.length = 0
    session.user = TWO
    const statuses: number[] = []
    for (let i = 0; i < 3; i++) statuses.push((await get(gaps, 'gaps?domain=acme.test')).status)
    expect(statuses).toEqual([200, 200, 429])
    // One's read of the same host is its own workspace's first: served, and the page is read for it.
    session.user = ONE
    const res = await get(gaps, 'gaps?domain=acme.test')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { day: string }).day).toBe('2026-09-11')
    expect(pages.fetched).toEqual(['acme.test', 'acme.test', 'acme.test'])
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
