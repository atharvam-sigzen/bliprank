import type { Db } from '@bliprank/db/client'
import { migratedPglite, pgliteDb, TEST_KEY } from '@bliprank/db/testing'
import { mintWorkspaceToken } from '@bliprank/db/token'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryKV } from '../../../../../services/collector/src/cache-index.js'
import type { AuthUser } from '@/lib/auth/supabase'

/**
 * Tracking as a workspace action (MVP_PLAN C3, ADR-0018 D6), over PGlite and
 * the collector's in-memory KV double: the route derives the workspace, the
 * account and the role from the session and from nothing in the body; the
 * tracked list stays the deployment's ledger document; the fan-out reads the
 * result; and the database, not the route, is what refuses a job whose
 * tracker's role has since changed.
 *
 * Nothing here spends: the fan-out's publish is a fake, the runner is a fake,
 * the provider gate is a fake, and no HTTP leaves the process.
 */
const session = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock('@/lib/auth/supabase', () => ({ currentUser: async () => session.user }))
const pgHolder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/auth/db', () => ({ appDb: () => pgHolder.db }))
// The deployment's ledgers: the KV double, so the tracked list is the Upstash-shaped document, never a file on this instance's disk.
const kvHolder = vi.hoisted(() => ({ kv: null as unknown }))
vi.mock('../../../../../services/grader/src/ledger-stores.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../../services/grader/src/ledger-stores.js')>()
  return { ...actual, ledgerStores: (dataDir: string, env: NodeJS.ProcessEnv) => (kvHolder.kv ? actual.kvLedgerStores(kvHolder.kv as MemoryKV) : actual.ledgerStores(dataDir, env)) }
})
const runner = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../../../../../services/grader/src/run.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../../services/grader/src/run.js')>()
  return {
    ...actual,
    runGrader: vi.fn(async (o: Parameters<typeof actual.runGrader>[0]) => {
      runner.calls.push(o.domain)
      throw new Error('the fake runner ran, which this test never expects')
    }),
  }
})
vi.mock('../../../../../services/grader/src/live-gate.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../../services/grader/src/live-gate.js')>()
  return { ...actual, checkGate: vi.fn(async () => ({ ok: true, quota: [] })) }
})

import { GET, POST } from './route'
import { ONLY_OWNER_OR_ADMIN, daysLeftOn, positiveIntOr, untilDay } from '@/lib/tracked'
import { kvLedgerStores } from '../../../../../services/grader/src/ledger-stores.js'
import { readTrackedIn, setTrackedIn, TrackedCeilingReached } from '../../../../../services/grader/src/due.js'
import { runFanOut, runDomainJob, readDailyLedger } from '../../../../../services/grader/src/daily-loop.js'
import { sessionWorkspaceStore } from '../../../../../services/grader/src/store/pg-store.js'
import { jobStoreFor } from '@/lib/tick'
import { identityConfig } from '@/lib/auth/config'

let pg: Awaited<ReturnType<typeof migratedPglite>>
let app: Db
let dir: string
let kv: MemoryKV
const ONE: AuthUser = { id: '88888888-0000-4000-8000-000000000001', email: 'one@brand.test' }
const TWO: AuthUser = { id: '88888888-0000-4000-8000-000000000002', email: 'two@brand.test' }
const MEMBER: AuthUser = { id: '88888888-0000-4000-8000-000000000003', email: 'member@brand.test' }
const ws: Record<string, { account: string; workspace: string; role: 'owner' | 'member' }> = {}
const originalEnv = { ...process.env }
const IDENTITY = { SUPABASE_URL: 'https://x.supabase.test', SUPABASE_PUBLISHABLE_KEY: 'pk', DATABASE_URL: 'postgres://app_rw@pooler.test/db', AUTH_SIGNING_KID: TEST_KEY.kid, AUTH_SIGNING_SECRET: TEST_KEY.secret, AUTH_ISSUER: TEST_KEY.issuer, AUTH_AUDIENCE: TEST_KEY.audience, SITE_URL: 'https://bliprank.test' }
const ARMED = { GRADER_DAILY_LOOP: 'armed', COLLECTION_ENABLED: 'true', GRADER_LIVE_SCAN: 'true', OPENWEBNINJA_API_KEY: 'test-key-never-used', OPENWEBNINJA_PLAN: 'payg', COLLECTION_BUDGET_USD_DAILY: '100' }

const storeOf = (u: AuthUser) => sessionWorkspaceStore(app, mintWorkspaceToken(TEST_KEY, { sub: ws[u.id]!.account, workspaceId: ws[u.id]!.workspace, role: ws[u.id]!.role }))
const today = () => new Date().toISOString().slice(0, 10)

beforeAll(async () => {
  pg = await migratedPglite()
  app = pgliteDb(pg)
  pgHolder.db = app
  for (const [u, name] of [[ONE, 'One'], [TWO, 'Two']] as const) {
    await app.query('SELECT ensure_account($1, $2, $3)', [u.id, u.email, 'brand'])
    await app.query('SELECT create_workspace($1, $2)', [u.id, name])
    const [row] = await app.query<{ account_id: string; workspace_id: string }>('SELECT account_id, workspace_id FROM workspaces_of($1)', [u.id])
    ws[u.id] = { account: row!.account_id, workspace: row!.workspace_id, role: 'owner' }
  }
  const [m] = await app.query<{ id: string }>('SELECT ensure_account($1, $2, $3) AS id', [MEMBER.id, MEMBER.email, 'brand'])
  await pgliteDb(pg, 'svc_onboard').query('INSERT INTO workspace_members (workspace_id, account_id, role) VALUES ($1, $2, $3)', [ws[ONE.id]!.workspace, m!.id, 'member'])
  ws[MEMBER.id] = { account: m!.id, workspace: ws[ONE.id]!.workspace, role: 'member' }
  // A category record in One's workspace for acme.test and beta.test, and in Two's for beta.test only: the precondition of tracking.
  for (const [u, host] of [[ONE, 'acme.test'], [ONE, 'beta.test'], [ONE, 'gamma.test'], [ONE, 'delta.test'], [TWO, 'beta.test']] as const) {
    await storeOf(u).documents.put('category-record', host, { host, slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-09-01T00:00:00.000Z', generated: false }, 0)
  }
})
afterAll(async () => {
  await pg.close()
})
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-tracked-'))
  kv = new MemoryKV()
  kvHolder.kv = kv
  runner.calls = []
  Object.assign(process.env, { GRADER_DATA_DIR: dir, TRUSTED_PROXY: 'cloudflare' }, IDENTITY)
  delete process.env['COLLECTION_ENABLED']
  delete process.env['GRADER_LIVE_SCAN']
  delete process.env['GRADER_MAX_TRACKED_PER_WORKSPACE']
  session.user = null
})
afterEach(() => {
  process.env = { ...originalEnv }
  kvHolder.kv = null
  rmSync(dir, { recursive: true, force: true })
})

const get = async (domain: string) => {
  const res = await GET(new Request(`http://local/api/tracked?domain=${domain}`))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const post = async (body: unknown) => {
  const res = await POST(new Request('http://local/api/tracked', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const tracked = () => readTrackedIn(kvLedgerStores(kv))

describe('tracking as a workspace action, identity on, over PGlite and the KV double', () => {
  it('nobody signed in is 401 and writes nothing', async () => {
    expect((await post({ domain: 'acme.test', on: true, days: 7 })).status).toBe(401)
    expect(await tracked()).toEqual([])
  })

  it('a member is refused, and the list is unchanged', async () => {
    session.user = MEMBER
    expect(await post({ domain: 'acme.test', on: true, days: 7 })).toMatchObject({ status: 403, body: { kind: 'role', message: ONLY_OWNER_OR_ADMIN } })
    expect(await tracked()).toEqual([])
    // A member reads the state and is told who may switch it.
    expect(await get('acme.test')).toMatchObject({ status: 200, body: { domain: 'acme.test', tracked: false, may: false } })
  })

  it('a host with no record in THIS workspace is refused; the same host recorded in another workspace does not count', async () => {
    session.user = TWO
    // acme.test is recorded in One's workspace only.
    expect(await post({ domain: 'acme.test', on: true, days: 7 })).toMatchObject({ status: 404, body: { kind: 'no-record' } })
    expect(await tracked()).toEqual([])
  })

  it("an owner's entry carries the session's workspace, account and role and nothing from the body; the fan-out's due list reads it back; another workspace cannot see or remove it", async () => {
    session.user = ONE
    const on = await post({ domain: 'acme.test', on: true, days: 7, reason: 'paying customer', workspaceId: ws[TWO.id]!.workspace, by: 'someone-else', role: 'owner' })
    expect(on).toMatchObject({ status: 200, body: { domain: 'acme.test', tracked: true, may: true, trackedInWorkspace: 1, reason: 'paying customer' } })
    const entries = await tracked()
    expect(entries).toEqual([{ host: 'acme.test', since: expect.any(String), until: expect.any(String), by: ws[ONE.id]!.account, role: 'owner', reason: 'paying customer', workspaceId: ws[ONE.id]!.workspace }])

    // Two's view: not tracked, and switching it off from Two changes nothing of One's.
    session.user = TWO
    expect(await get('acme.test')).toMatchObject({ status: 200, body: { domain: 'acme.test', tracked: false, trackedInWorkspace: 0 } })
    expect(await post({ domain: 'acme.test', on: false })).toMatchObject({ status: 200, body: { tracked: false, trackedInWorkspace: 0 } })
    expect(await tracked()).toEqual(entries)
    // Two tracking its own recorded host is its own entry, beside One's; neither sees the other's count.
    expect(await post({ domain: 'beta.test', on: true, days: 7 })).toMatchObject({ status: 200, body: { tracked: true, trackedInWorkspace: 1 } })
    session.user = ONE
    expect(await get('acme.test')).toMatchObject({ status: 200, body: { tracked: true, trackedInWorkspace: 1 } })

    // The fan-out reads what the route wrote: one domain job per entry, each in its own workspace, under a fake publish.
    Object.assign(process.env, ARMED)
    const published: { host: string; workspaceId: string }[] = []
    const ledgers = kvLedgerStores(kv)
    const identity = identityConfig(process.env)
    const out = await runFanOut(
      { dataDir: dir, env: process.env, ledgers, mode: 'live', storeFor: (entry) => jobStoreFor(entry, identity, dir), publish: async (job) => void published.push({ host: job.host, workspaceId: job.workspaceId }) },
      { now: () => new Date() },
    )
    expect(out).toMatchObject({ outcome: 'fanned-out', published: 2, failed: 0, refusedEntries: [] })
    expect(published.sort((a, b) => a.host.localeCompare(b.host))).toEqual([
      { host: 'acme.test', workspaceId: ws[ONE.id]!.workspace },
      { host: 'beta.test', workspaceId: ws[TWO.id]!.workspace },
    ])
    expect(runner.calls).toEqual([])

    // Off removes One's entry and only One's.
    expect(await post({ domain: 'acme.test', on: false })).toMatchObject({ status: 200, body: { tracked: false, trackedInWorkspace: 0 } })
    expect((await tracked()).map((t) => t.host)).toEqual(['beta.test'])
  })

  it("the role is re-read from the session at every write, and a role change after tracking refuses the job at the database and collects nothing", async () => {
    session.user = ONE
    expect((await post({ domain: 'gamma.test', on: true, days: 7 })).status).toBe(200)
    expect((await tracked())[0]).toMatchObject({ host: 'gamma.test', role: 'owner' })

    // One is demoted to member after tracking. The entry still says owner; the database refuses the mismatch (migration 0005).
    await pgliteDb(pg, 'svc_onboard').query('UPDATE workspace_members SET role = $1 WHERE workspace_id = $2 AND account_id = $3', ['member', ws[ONE.id]!.workspace, ws[ONE.id]!.account])
    try {
      Object.assign(process.env, ARMED)
      const ledgers = kvLedgerStores(kv)
      const identity = identityConfig(process.env)
      const [entry] = await tracked()
      const store = await jobStoreFor(entry!, identity, dir)
      expect(store).toMatchObject({ refuse: expect.stringMatching(/role|member/i) })
      // Through the fan-out: the entry is reported refused and no job is published.
      const published: unknown[] = []
      const fan = await runFanOut({ dataDir: dir, env: process.env, ledgers, mode: 'live', storeFor: (e) => jobStoreFor(e, identity, dir), publish: async (j) => void published.push(j) }, { now: () => new Date() })
      expect(fan).toMatchObject({ outcome: 'fanned-out', published: 0, refusedEntries: [{ host: 'gamma.test', workspaceId: ws[ONE.id]!.workspace }] })
      expect(published).toEqual([])
      // And a domain job for it, delivered anyway, finds no store to run in: the day is booked by the fan-out, but the job never reaches the runner.
      const job = { v: 1 as const, kind: 'domain' as const, day: today(), workspaceId: ws[ONE.id]!.workspace, host: 'gamma.test' }
      const again = await jobStoreFor(entry!, identity, dir)
      expect('refuse' in again).toBe(true)
      expect(runner.calls).toEqual([])
      expect((await readDailyLedger(dir, ledgers))[today()]!.domains).toEqual({})
      void runDomainJob
      void job

      // Re-tracking as the member One now is: refused as a member, so the entry cannot be refreshed to a role the session does not hold.
      session.user = ONE
      expect((await post({ domain: 'gamma.test', on: true, days: 7 })).status).toBe(403)
    } finally {
      await pgliteDb(pg, 'svc_onboard').query('UPDATE workspace_members SET role = $1 WHERE workspace_id = $2 AND account_id = $3', ['owner', ws[ONE.id]!.workspace, ws[ONE.id]!.account])
    }
  })

  it('the interim per-workspace ceiling refuses a fourth host until D2 gates the count by plan, and the environment raises it', async () => {
    session.user = ONE
    for (const host of ['acme.test', 'beta.test', 'gamma.test']) expect((await post({ domain: host, on: true, days: 7 })).status).toBe(200)
    expect(await post({ domain: 'delta.test', on: true, days: 7 })).toMatchObject({ status: 422, body: { kind: 'ceiling' } })
    // Re-saving a tracked host is not a fourth.
    expect((await post({ domain: 'acme.test', on: true, days: 7 })).status).toBe(200)
    process.env['GRADER_MAX_TRACKED_PER_WORKSPACE'] = '4'
    expect((await post({ domain: 'delta.test', on: true, days: 7 })).status).toBe(200)
    expect((await tracked()).filter((t) => t.workspaceId === ws[ONE.id]!.workspace)).toHaveLength(4)
  })

  it('the ceiling is decided under the same lock as the write: two concurrent switches for two new hosts cannot both pass it (C3 cost review, MAJOR 1)', async () => {
    const ledgers = kvLedgerStores(kv)
    const where = 'the tracked.json ledger document'
    const w = (host: string) => ({ host, workspaceId: 'ws-race', by: 'acct', role: 'owner' as const, reason: 'r', at: '2026-09-16T00:00:00.000Z' })
    // Measured before the fix: a read-then-write pair let both land, one over the ceiling, and neither caller was told.
    const results = await Promise.allSettled([setTrackedIn(ledgers, where, w('a.test'), true, { max: 1 }), setTrackedIn(ledgers, where, w('b.test'), true, { max: 1 })])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!
    expect(rejected.reason).toBeInstanceOf(TrackedCeilingReached)
    const own = (await readTrackedIn(ledgers)).filter((t) => t.workspaceId === 'ws-race')
    expect(own).toHaveLength(1)
    // Re-saving the host already tracked is not a second host; another workspace's count is its own.
    await setTrackedIn(ledgers, where, w(own[0]!.host), true, { max: 1 })
    await setTrackedIn(ledgers, where, { ...w('c.test'), workspaceId: 'ws-other' }, true, { max: 1 })
    expect((await readTrackedIn(ledgers)).filter((t) => t.workspaceId === 'ws-race')).toHaveLength(1)
  })

  it('an instruction that has ended holds no slot: three lapsed entries do not block a fourth host, and the count the ceiling enforces is the count the status reports (C3 tenancy re-check)', async () => {
    session.user = ONE
    const lapsed = (host: string) => ({ host, since: '2026-01-01T00:00:00.000Z', until: '2026-01-08', by: ws[ONE.id]!.account, role: 'owner', reason: 'a week in January', workspaceId: ws[ONE.id]!.workspace })
    await kvLedgerStores(kv).doc('tracked.json').update(() => [lapsed('beta.test'), lapsed('gamma.test'), lapsed('delta.test')])
    expect((await get('acme.test')).body).toMatchObject({ tracked: false, trackedInWorkspace: 0 })
    expect(await post({ domain: 'acme.test', on: true, days: 7 })).toMatchObject({ status: 200, body: { tracked: true, trackedInWorkspace: 1 } })
    // The lapsed entries are still in the document (nothing reaps another day's record); they simply count for nothing.
    expect(await tracked()).toHaveLength(4)
    // A lapsed host switched on again is a new instruction in its own slot.
    expect(await post({ domain: 'beta.test', on: true, days: 7 })).toMatchObject({ status: 200, body: { tracked: true, trackedInWorkspace: 2 } })
  })

  it('a limit that is not a positive integer keeps its default, never lifts the limit: the ceiling and both throttles (C3 tenancy re-check)', async () => {
    expect([positiveIntOr(undefined, 3), positiveIntOr('', 3), positiveIntOr('ten', 3), positiveIntOr('0', 3), positiveIntOr('-2', 3), positiveIntOr('2.5', 3), positiveIntOr('7', 3)]).toEqual([3, 3, 3, 3, 3, 3, 7])
    // Through the route: NaN compares false with everything, so a typo read with Number() switched the per-domain throttle off. The default of twelve still holds.
    session.user = ONE
    process.env['GRADER_MAX_TRACK_SWITCHES_PER_DOMAIN_PER_HOUR'] = 'ten'
    process.env['GRADER_MAX_TRACK_SWITCHES_PER_VISITOR_PER_HOUR'] = '100' // this test sends no client address, so every call is one visitor; lifted so the per-domain limit is the one met
    for (let i = 0; i < 12; i++) expect((await post({ domain: 'acme.test', on: i % 2 === 0, days: 7 })).status).toBe(200)
    expect((await post({ domain: 'acme.test', on: true, days: 7 })).status).toBe(429)
  })

  it('other workspaces\u2019 entries pass through a write verbatim: a field this build does not know is kept, and a malformed entry is neither dropped nor repaired by a stranger\u2019s switch (C3 tenancy review, MAJOR 3)', async () => {
    session.user = ONE
    const doc = kvLedgerStores(kv).doc('tracked.json')
    const theirs = { host: 'beta.test', since: '2026-09-01T00:00:00.000Z', by: ws[TWO.id]!.account, role: 'owner', reason: 'theirs', workspaceId: ws[TWO.id]!.workspace, plan: 'a field a later build wrote' }
    const malformed = { host: 'not a host at all', workspaceId: ws[TWO.id]!.workspace, since: 7 }
    await doc.update(() => [theirs, malformed, 'a bare string from an older form'])
    expect((await post({ domain: 'acme.test', on: true, days: 7 })).status).toBe(200)
    const after = (await doc.read()) as unknown[]
    // The three foreign values are there exactly as they were, in order, ahead of One's new entry.
    expect(after.slice(0, 3)).toEqual([theirs, malformed, 'a bare string from an older form'])
    expect(after).toHaveLength(4)
    expect(after[3]).toMatchObject({ host: 'acme.test', workspaceId: ws[ONE.id]!.workspace })
    // Switching off again removes One's entry and leaves the rest untouched.
    expect((await post({ domain: 'acme.test', on: false })).status).toBe(200)
    expect(await doc.read()).toEqual([theirs, malformed, 'a bare string from an older form'])
  })

  it('a corrupt tracked document is 503 on read and on write, and nothing is written over it', async () => {
    session.user = ONE
    await kv.set('ledger:tracked', 'not a list')
    expect((await get('acme.test')).status).toBe(503)
    expect((await post({ domain: 'acme.test', on: true, days: 7 })).status).toBe(503)
    expect(await kv.get('ledger:tracked')).toBe('not a list')
  })

  it('bad input: no domain, no direction, no or an impossible number of days', async () => {
    session.user = ONE
    expect((await post({ on: true, days: 7 })).status).toBe(400)
    expect((await post({ domain: 'acme.test' })).status).toBe(400)
    for (const days of [undefined, 0, -1, 91, 2.5, '7']) expect([days, (await post({ domain: 'acme.test', on: true, days })).status]).toEqual([days, 400])
    expect((await GET(new Request('http://local/api/tracked'))).status).toBe(400)
    expect(await tracked()).toEqual([])
  })

  it('the instruction has an end: the days set `until`, GET says how many are left, and the set version in force is recorded with it (C3)', async () => {
    session.user = ONE
    const today = new Date().toISOString().slice(0, 10)
    const on = await post({ domain: 'acme.test', on: true, days: 3 })
    expect(on).toMatchObject({ status: 200, body: { tracked: true, until: untilDay(today, 3), daysLeft: 3 } })
    expect((on.body as { prompts?: unknown }).prompts).toBeUndefined() // no set in force: the bank's, and the entry says nothing
    expect((await tracked())[0]).toMatchObject({ host: 'acme.test', until: untilDay(today, 3) })
    expect((await get('acme.test')).body).toMatchObject({ tracked: true, until: untilDay(today, 3), daysLeft: 3, trackedInWorkspace: 1 })
    // Days left is a count of UTC days, `until` included; past it the entry is expired and no longer counted as tracked.
    expect(daysLeftOn(today, untilDay(today, 3)!)).toBe(3)
    expect(daysLeftOn(untilDay(today, 4)!, untilDay(today, 3)!)).toBe(-1)
    // Switching on again with another number moves the end, one entry standing.
    expect(await post({ domain: 'acme.test', on: true, days: 10 })).toMatchObject({ status: 200, body: { until: untilDay(today, 10), daysLeft: 10, trackedInWorkspace: 1 } })
    expect(await tracked()).toHaveLength(1)
  })
})

describe('identity off: the machine\'s own store writes the CLI\'s form', () => {
  it('writes an entry with no workspace and no role, as pnpm grader:track would, and refuses a host with no record', async () => {
    kvHolder.kv = null
    for (const k of Object.keys(IDENTITY)) delete process.env[k]
    process.env['COLLECTOR_TOPOLOGY'] = 'single-process'
    const { recordCategory } = await import('../../../../../services/grader/src/resolve-category.js')
    recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-08-01', generated: false })
    expect(await post({ domain: 'nobody.test', on: true, days: 7 })).toMatchObject({ status: 404, body: { kind: 'no-record' } })
    expect(await post({ domain: 'acme.test', on: true, days: 7, reason: 'local' })).toMatchObject({ status: 200, body: { tracked: true, may: true } })
    const { readTracked } = await import('../../../../../services/grader/src/due.js')
    expect(readTracked(dir)).toEqual([{ host: 'acme.test', since: expect.any(String), until: expect.any(String), by: 'local', reason: 'local' }])
    expect(await get('acme.test')).toMatchObject({ status: 200, body: { tracked: true } })
  })
})
