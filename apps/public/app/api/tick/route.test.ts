import type { Db } from '@bliprank/db/client'
import { migratedPglite, pgliteDb, TEST_KEY } from '@bliprank/db/testing'
import { mintWorkspaceToken } from '@bliprank/db/token'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryKV } from '../../../../../services/collector/src/cache-index.js'
import { signQStashToken } from '../../../../../services/collector/src/qstash-verify.js'
import { ENGINES } from '@bliprank/contracts'
import type { AuthUser } from '@/lib/auth/supabase'

/**
 * THE TICK ROUTE, END TO END, WITHOUT QSTASH, WITHOUT A PROVIDER (ADR-0018,
 * MVP_PLAN C2). Every request below is signed the way QStash signs, with
 * `signQStashToken` over the raw body, and answered by the real route
 * handler; the global fetch is stubbed so the only "network" is a recorder of
 * what the fan-out would have published, and anything else thrown.
 *
 * Two worlds. With identity OFF, over a scratch data directory and file
 * ledgers, in FIXTURE mode: the real runner collects through the fixture
 * adapter, so the whole path — verify, fan-out, publish, the domain job,
 * reserve, run, file, settle — is exercised with nothing faked but QStash.
 * With identity ON, over PGlite and the in-memory KV double, ARMED (live):
 * the runner and the provider-quota gate are the two things mocked, and
 * what is proven is the tenancy of the jobs — a domain job files its cycle
 * in the workspace its tracked entry names, through a token minted for the
 * account that switched it on, and an entry naming an account that is not a
 * member is refused by the database with nothing collected.
 *
 * ⚠️ NOTHING HERE IS ARMED FOR REAL AND NOTHING SPENDS: the environment is
 * this test's own object, the key is a string, the runner is the fixture
 * adapter or a fake, and the quota gate is a fake.
 */
const pgHolder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/auth/db', () => ({ appDb: () => pgHolder.db }))
vi.mock('@/lib/auth/supabase', () => ({ currentUser: async () => null }))

// The runner: real (fixture mode, identity off) or a fake (live mode, identity on).
const runner = vi.hoisted(() => ({ real: true, calls: [] as { domain: string; day: string; mode: string }[], fail: new Set<string>() }))
vi.mock('../../../../../services/grader/src/run.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../../services/grader/src/run.js')>()
  return {
    ...actual,
    runGrader: vi.fn(async (o: Parameters<typeof actual.runGrader>[0]) => {
      runner.calls.push({ domain: o.domain, day: o.day, mode: o.mode })
      if (runner.real) return actual.runGrader(o)
      if (runner.fail.has(o.domain)) throw new Error('socket hung up')
      const w = { value: 0.3, ci_low: 0.21, ci_high: 0.41, n: 85 }
      return {
        status: 'scanned',
        domain: o.domain,
        category: 'crm-software',
        categoryName: 'CRM software',
        classification: { status: 'classified', slug: 'crm-software', signal: 'site-content', evidence: 'x' },
        subjectSource: 'domain-label',
        comparisonBasis: 'grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|crm-software@1|unprompted=17|runs=1',
        algoVersion: 'det-3',
        collectedAt: `${o.day}T10:00:00.000Z`,
        counts: { cellsRequested: 85, cacheHits: 0, collected: 85, failed: 0, answersScored: 85, providerCalls: 85 },
        brands: [{ id: `domain:${o.domain}`, name: o.domain, isSubject: true, mentions: 25, citations: 0, metric: { ...w, algo_version: 'det-3', collection_path: 'third-party-grounded', comparison_basis: 'b' } }],
        promptRows: [],
        run: { mode: 'live', plan: 'payg', day: o.day, engines: [...ENGINES], spentUsd: 0.41, capUsd: 300, at: `${o.day}T10:01:00.000Z` },
      } as unknown as Awaited<ReturnType<typeof actual.runGrader>>
    }),
  }
})

// The provider-quota gate, for the live world: no HTTP leaves the machine.
vi.mock('../../../../../services/grader/src/live-gate.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../../services/grader/src/live-gate.js')>()
  return { ...actual, checkGate: vi.fn(async () => ({ ok: true, quota: [] })) }
})

// The ledgers: the deployment's KV double when a test sets one, else the real choice (file ledgers over the scratch directory).
const kvHolder = vi.hoisted(() => ({ kv: null as unknown }))
vi.mock('../../../../../services/grader/src/ledger-stores.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../../services/grader/src/ledger-stores.js')>()
  return { ...actual, ledgerStores: (dataDir: string, env: NodeJS.ProcessEnv) => (kvHolder.kv ? actual.kvLedgerStores(kvHolder.kv as MemoryKV) : actual.ledgerStores(dataDir, env)) }
})

import { POST } from './route'
import { kvLedgerStores } from '../../../../../services/grader/src/ledger-stores.js'
import { readDailyLedger } from '../../../../../services/grader/src/daily-loop.js'
import { setTracked } from '../../../../../services/grader/src/due.js'
import { listCycles } from '../../../../../services/grader/src/cycles.js'
import { recordCategory } from '../../../../../services/grader/src/resolve-category.js'
import { sessionWorkspaceStore } from '../../../../../services/grader/src/store/pg-store.js'
import { LEDGER_UNAVAILABLE, NOT_A_JOB, NOT_CONFIGURED, NOT_QSTASH } from '@/lib/tick'

const KEY = 'sig_current_key'
const NEXT = 'sig_next_key'
const SITE = 'https://bliprank.test'
const URL_ = `${SITE}/api/tick`
const today = () => new Date().toISOString().slice(0, 10)

/** What the fan-out published, as QStash would have received it. Anything that is not a publish to QStash is refused: no other network exists here. */
const published: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
const realFetch = globalThis.fetch
beforeAll(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith('https://qstash.upstash.io/v2/publish/')) throw new Error(`the tick route reached the network: ${url}`)
    published.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return new Response(JSON.stringify({ messageId: `msg_${published.length}` }), { status: 200 })
  })
})
afterAll(() => {
  vi.stubGlobal('fetch', realFetch)
})

const signed = (body: string, key = KEY, url = URL_) => signQStashToken({ key, url, body })
const post = async (body: unknown, opts: { readonly signature?: string; readonly raw?: string } = {}) => {
  const raw = opts.raw ?? JSON.stringify(body)
  const res = await POST(new Request(`http://localhost${'/api/tick'}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(opts.signature === undefined ? { 'upstash-signature': signed(raw) } : opts.signature ? { 'upstash-signature': opts.signature } : {}) }, body: raw }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const FAN_OUT = { v: 1, kind: 'fan-out' }
const domainJob = (host: string, workspaceId = 'local', day = today()) => ({ v: 1, kind: 'domain', day, workspaceId, host })

let dir: string
const originalEnv = { ...process.env }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-tick-route-'))
  published.length = 0
  runner.calls.length = 0
  runner.real = true
  runner.fail.clear()
  kvHolder.kv = null
  process.env = { ...originalEnv, GRADER_DATA_DIR: dir, COLLECTOR_TOPOLOGY: 'single-process', SITE_URL: SITE, QSTASH_CURRENT_SIGNING_KEY: KEY, QSTASH_NEXT_SIGNING_KEY: NEXT, QSTASH_TOKEN: 'qs_tok' }
  delete process.env['GRADER_DAILY_LOOP']
})
afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(dir, { recursive: true, force: true })
})

describe('before anything: configuration, then the signature over the raw bytes, then the shape', () => {
  it('no signing key or no SITE_URL: 503, nothing read, nothing touched', async () => {
    delete process.env['QSTASH_CURRENT_SIGNING_KEY']
    expect(await post(FAN_OUT)).toEqual({ status: 503, body: { ok: false, error: NOT_CONFIGURED } })
    process.env['QSTASH_CURRENT_SIGNING_KEY'] = KEY
    process.env['SITE_URL'] = 'not a url'
    expect(await post(FAN_OUT)).toEqual({ status: 503, body: { ok: false, error: NOT_CONFIGURED } })
    expect(published).toEqual([])
    expect(existsSync(join(dir, 'daily-spend.json'))).toBe(false)
  })

  it('unsigned, signed with another key, signed for another URL, or a token whose body hash is for another body: 401 and nothing touched, even when armed', async () => {
    process.env['GRADER_DAILY_LOOP'] = 'fixture'
    expect(await post(FAN_OUT, { signature: '' })).toEqual({ status: 401, body: { ok: false, error: NOT_QSTASH } })
    expect(await post(FAN_OUT, { signature: signed(JSON.stringify(FAN_OUT), 'attacker_key') })).toEqual({ status: 401, body: { ok: false, error: NOT_QSTASH } })
    expect(await post(FAN_OUT, { signature: signed(JSON.stringify(FAN_OUT), KEY, 'https://bliprank.test/api/scan') })).toEqual({ status: 401, body: { ok: false, error: NOT_QSTASH } })
    expect(await post(FAN_OUT, { signature: signed(JSON.stringify(domainJob('acme.test'))) })).toEqual({ status: 401, body: { ok: false, error: NOT_QSTASH } })
    expect(published).toEqual([])
    expect(runner.calls).toEqual([])
    expect(existsSync(join(dir, 'daily-spend.json'))).toBe(false)
  })

  it('the NEXT signing key verifies during a rotation', async () => {
    const raw = JSON.stringify(FAN_OUT)
    const r = await post(FAN_OUT, { signature: signed(raw, NEXT) })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ outcome: 'not-armed' })
  })

  it('a signed body that is not JSON, or not one of the two jobs, is 400', async () => {
    expect(await post(null, { raw: '{ not json' })).toEqual({ status: 400, body: { ok: false, error: NOT_A_JOB } })
    expect(await post({ v: 1, kind: 'collect' })).toEqual({ status: 400, body: { ok: false, error: NOT_A_JOB } })
    expect(await post({ v: 1, kind: 'domain', day: 'today', workspaceId: 'local', host: 'acme.test' })).toEqual({ status: 400, body: { ok: false, error: NOT_A_JOB } })
    expect(await post({ ...domainJob('acme.test'), v: 2 })).toEqual({ status: 400, body: { ok: false, error: NOT_A_JOB } })
  })

  it('not armed: a verified fan-out and a verified domain job are both answered 200 and do nothing — no publish, no runner, no ledger', async () => {
    recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-09-01T00:00:00.000Z', generated: false })
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r' })
    for (const value of [undefined, 'true', 'ARMED', 'yes']) {
      if (value === undefined) delete process.env['GRADER_DAILY_LOOP']
      else process.env['GRADER_DAILY_LOOP'] = value
      expect(await post(FAN_OUT)).toMatchObject({ status: 200, body: { ok: false, kind: 'fan-out', outcome: 'not-armed' } })
      expect(await post(domainJob('acme.test'))).toMatchObject({ status: 200, body: { ok: false, kind: 'domain', outcome: 'not-armed' } })
    }
    expect(published).toEqual([])
    expect(runner.calls).toEqual([])
    expect(existsSync(join(dir, 'daily-spend.json'))).toBe(false)
  })
})

describe('identity off, fixture mode: the whole path through the real route and the real runner, offline', () => {
  beforeEach(() => {
    process.env['GRADER_DAILY_LOOP'] = 'fixture'
    process.env['GRADER_PROMPTS_PER_SCAN'] = '2'
    // A tracked leader domain: rung 1 resolves it without a fetch, the record is written by hand here.
    recordCategory(dir, { host: 'pipedrive.com', slug: 'crm-software', source: 'leader-domain', evidence: 'pipedrive.com', decidedAt: '2026-09-01T00:00:00.000Z', generated: false })
    setTracked(dir, 'pipedrive.com', true, { by: 'operator', reason: 'reference domain' })
  })

  it('the fan-out publishes one signed-for domain job per due domain with its deduplication id and the destination timeout, after opening the day; the domain job collects, files a cycle marked fixture, and settles; the retries do nothing', async () => {
    const fan = await post(FAN_OUT)
    expect(fan).toMatchObject({ status: 200, body: { ok: true, kind: 'fan-out', outcome: 'fanned-out', day: today(), published: 1, failed: 0, due: 1, notDue: 0, refusedEntries: 0 } })
    expect(published).toHaveLength(1)
    expect(published[0]!.url).toBe(`https://qstash.upstash.io/v2/publish/${encodeURIComponent(URL_)}`)
    expect(published[0]!.headers['authorization']).toBe('Bearer qs_tok')
    expect(published[0]!.headers['upstash-deduplication-id']).toBe(`tick:${today()}:local:pipedrive.com`)
    expect(published[0]!.headers['upstash-timeout']).toBe('300s')
    expect(published[0]!.headers['upstash-retries']).toBe('2')
    expect(published[0]!.body).toEqual(domainJob('pipedrive.com'))
    let day = (await readDailyLedger(dir))[today()]!
    expect(day).toMatchObject({ spentUsd: 0, domains: {}, fanOut: { published: 1 } })
    expect(day.fanOut?.publishedAt).toEqual(expect.any(String))
    expect(runner.calls).toEqual([])

    // The published job, posted back as QStash would deliver it.
    const ran = await post(published[0]!.body)
    expect(ran).toMatchObject({ status: 200, body: { ok: true, kind: 'domain', outcome: 'ran', host: 'pipedrive.com', day: today(), run: { host: 'pipedrive.com', status: 'scanned', calls: 2 * ENGINES.length, spentUsd: 0 } } })
    expect(runner.calls).toEqual([{ domain: 'pipedrive.com', day: today(), mode: 'fixture' }])
    const cycles = listCycles(dir, 'pipedrive.com')
    expect(cycles.map((c) => c.day)).toEqual([today()])
    expect((JSON.parse(readFileSync(cycles[0]!.file, 'utf8')) as { run: { mode: string } }).run.mode).toBe('fixture')
    day = (await readDailyLedger(dir))[today()]!
    expect(day.domains['pipedrive.com']).toMatchObject({ status: 'scanned', calls: 2 * ENGINES.length, spentUsd: 0 })

    // The retry of the domain job: today's cycle is filed, nothing runs again.
    expect(await post(published[0]!.body)).toMatchObject({ status: 200, body: { ok: false, outcome: 'not-due', reason: expect.stringContaining('cycle-today') } })
    // A second fan-out the same day: nothing published again.
    expect(await post(FAN_OUT)).toMatchObject({ status: 200, body: { ok: true, outcome: 'already-fanned-out', day: today() } })
    expect(published).toHaveLength(1)
    expect(runner.calls).toHaveLength(1)
  })

  it('a domain job before any fan-out, for yesterday, or for a host that is not tracked: 200, named, nothing collected', async () => {
    expect(await post(domainJob('pipedrive.com'))).toMatchObject({ status: 200, body: { ok: false, outcome: 'no-fan-out' } })
    expect(await post(domainJob('pipedrive.com', 'local', '2026-09-01'))).toMatchObject({ status: 200, body: { ok: false, outcome: 'day-passed' } })
    expect(await post(domainJob('nobody.test'))).toMatchObject({ status: 200, body: { ok: false, outcome: 'not-tracked' } })
    // An entry that names a workspace on a machine with identity off is refused as such.
    expect(await post(domainJob('pipedrive.com', '11111111-0000-4000-8000-000000000001'))).toMatchObject({ status: 200, body: { ok: false, outcome: 'not-tracked' } })
    expect(runner.calls).toEqual([])
  })

  it('a fan-out without the QStash token is 503 and opens no day; a fan-out while the lease is held is 503', async () => {
    delete process.env['QSTASH_TOKEN']
    expect(await post(FAN_OUT)).toEqual({ status: 503, body: { ok: false, error: NOT_CONFIGURED } })
    expect(existsSync(join(dir, 'daily-spend.json'))).toBe(false)
    process.env['QSTASH_TOKEN'] = 'qs_tok'
    const { ledgerStores } = await vi.importActual<typeof import('../../../../../services/grader/src/ledger-stores.js')>('../../../../../services/grader/src/ledger-stores.js')
    await ledgerStores(dir, process.env).doc('tick-lock.json').update(() => ({ holder: 'someone-else', pid: 1, at: new Date().toISOString() }))
    expect(await post(FAN_OUT)).toMatchObject({ status: 503, body: { ok: false, outcome: 'lease-held' } })
    expect(published).toEqual([])
  })

  it('a domain job re-decides the end of the instruction: a host tracked until yesterday collects nothing, however the job reached the route (C3 tenancy re-check)', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    setTracked(dir, 'pipedrive.com', true, { by: 'operator', reason: 'a week that has ended', until: yesterday })
    // The fan-out honours it: the day is opened, nothing is due, nothing is published.
    expect(await post(FAN_OUT)).toMatchObject({ status: 200, body: { ok: true, outcome: 'fanned-out', published: 0, due: 0, notDue: 1 } })
    expect(published).toEqual([])
    // And a job that arrives anyway (a replayed body, a held token) meets the same decision in the job itself.
    expect(await post(domainJob('pipedrive.com'))).toMatchObject({ status: 200, body: { ok: false, outcome: 'not-due', reason: expect.stringContaining('expired') } })
    expect(runner.calls).toEqual([])
  })

  it('a corrupt daily ledger: 503 with a fixed sentence, nothing collected', async () => {
    const { ledgerStores } = await vi.importActual<typeof import('../../../../../services/grader/src/ledger-stores.js')>('../../../../../services/grader/src/ledger-stores.js')
    await ledgerStores(dir, process.env).doc('daily-spend.json').update(() => 'not a ledger')
    expect(await post(FAN_OUT)).toEqual({ status: 503, body: { ok: false, kind: 'fan-out', error: LEDGER_UNAVAILABLE } })
    expect(published).toEqual([])
    expect(runner.calls).toEqual([])
  })
})

describe('identity on, over PGlite and the KV double, armed: a job runs in the workspace its entry names, as the account that switched the domain on', () => {
  let pg: Awaited<ReturnType<typeof migratedPglite>>
  let app: Db
  const ONE: AuthUser = { id: '77777777-0000-4000-8000-000000000001', email: 'one@brand.test' }
  const TWO: AuthUser = { id: '77777777-0000-4000-8000-000000000002', email: 'two@brand.test' }
  const MEMBER: AuthUser = { id: '77777777-0000-4000-8000-000000000003', email: 'member@brand.test' }
  const ws: Record<string, { account: string; workspace: string }> = {}
  const IDENTITY = { SUPABASE_URL: 'https://x.supabase.test', SUPABASE_PUBLISHABLE_KEY: 'pk', DATABASE_URL: 'postgres://app_rw@pooler.test/db', AUTH_SIGNING_KID: TEST_KEY.kid, AUTH_SIGNING_SECRET: TEST_KEY.secret, AUTH_ISSUER: TEST_KEY.issuer, AUTH_AUDIENCE: TEST_KEY.audience }
  const ARMED = { GRADER_DAILY_LOOP: 'armed', COLLECTION_ENABLED: 'true', GRADER_LIVE_SCAN: 'true', OPENWEBNINJA_API_KEY: 'test-key-never-used', OPENWEBNINJA_PLAN: 'payg', COLLECTION_BUDGET_USD_DAILY: '100' }
  const storeOf = (u: AuthUser, role: 'owner' | 'member' = 'owner') => sessionWorkspaceStore(app, mintWorkspaceToken(TEST_KEY, { sub: ws[u.id]!.account, workspaceId: ws[u.id]!.workspace, role }))
  let kv: MemoryKV

  beforeAll(async () => {
    pg = await migratedPglite()
    app = pgliteDb(pg)
    pgHolder.db = app
    for (const [u, name] of [[ONE, 'One'], [TWO, 'Two']] as const) {
      await app.query('SELECT ensure_account($1, $2, $3)', [u.id, u.email, 'brand'])
      await app.query('SELECT create_workspace($1, $2)', [u.id, name])
      const [row] = await app.query<{ account_id: string; workspace_id: string }>('SELECT account_id, workspace_id FROM workspaces_of($1)', [u.id])
      ws[u.id] = { account: row!.account_id, workspace: row!.workspace_id }
    }
    // A member of One's workspace: an account with no workspace of its own, added by the onboarding role.
    const [m] = await app.query<{ id: string }>('SELECT ensure_account($1, $2, $3) AS id', [MEMBER.id, MEMBER.email, 'brand'])
    await pgliteDb(pg, 'svc_onboard').query('INSERT INTO workspace_members (workspace_id, account_id, role) VALUES ($1, $2, $3)', [ws[ONE.id]!.workspace, m!.id, 'member'])
    ws[MEMBER.id] = { account: m!.id, workspace: ws[ONE.id]!.workspace }
    // Each workspace's own category record for its host: a first scan's precondition, written here by hand.
    for (const [u, host] of [[ONE, 'acme.test'], [TWO, 'beta.test'], [ONE, 'gamma.test'], [ONE, 'delta.test'], [ONE, 'echo.test']] as const) {
      await storeOf(u).documents.put('category-record', host, { host, slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-09-01T00:00:00.000Z', generated: false }, 0)
    }
  })
  afterAll(async () => {
    await pg.close()
  })
  beforeEach(async () => {
    runner.real = false
    kv = new MemoryKV()
    kvHolder.kv = kv
    Object.assign(process.env, IDENTITY, ARMED)
    // The deployment's tracked list: two owners' hosts, and one entry that names an account which is not a member of the workspace it claims.
    await kvLedgerStores(kv)
      .doc('tracked.json')
      .update(() => [
        { host: 'acme.test', since: '2026-09-15T00:00:00.000Z', by: ws[ONE.id]!.account, role: 'owner', reason: 'paying', workspaceId: ws[ONE.id]!.workspace },
        { host: 'beta.test', since: '2026-09-15T00:00:00.000Z', by: ws[TWO.id]!.account, role: 'owner', reason: 'paying', workspaceId: ws[TWO.id]!.workspace },
        { host: 'gamma.test', since: '2026-09-15T00:00:00.000Z', by: ws[TWO.id]!.account, role: 'owner', reason: 'forged', workspaceId: ws[ONE.id]!.workspace },
        // A member's standing instruction (ws_put_cycle is open to members); a host whose runner will throw; an entry with no role; an entry whose account is the parser's default word.
        { host: 'delta.test', since: '2026-09-15T00:00:00.000Z', by: ws[MEMBER.id]!.account, role: 'member', reason: 'member tracks', workspaceId: ws[ONE.id]!.workspace },
        { host: 'echo.test', since: '2026-09-15T00:00:00.000Z', by: ws[ONE.id]!.account, role: 'owner', reason: 'will fail', workspaceId: ws[ONE.id]!.workspace },
        { host: 'foxtrot.test', since: '2026-09-15T00:00:00.000Z', by: ws[ONE.id]!.account, reason: 'no role', workspaceId: ws[ONE.id]!.workspace },
        { host: 'golf.test', since: '2026-09-15T00:00:00.000Z', by: 'operator', role: 'owner', reason: 'no account', workspaceId: ws[ONE.id]!.workspace },
      ])
  })

  it('fixture mode is refused with identity on: a deployment holding workspaces never files a fixture cycle', async () => {
    process.env['GRADER_DAILY_LOOP'] = 'fixture'
    expect(await post(FAN_OUT)).toMatchObject({ status: 200, body: { ok: false, outcome: 'refused', reason: expect.stringContaining('identity off') } })
    expect(published).toEqual([])
    expect(await readDailyLedger(dir, kvLedgerStores(kv))).toEqual({})
  })

  it('the fan-out opens the day in the KV ledger and publishes one job per due domain in its own workspace; the entries whose account is not a member, has no role, or is not an account are refused and not published; the answer carries counts, the hosts go to the server log', async () => {
    const fan = await post(FAN_OUT)
    expect(fan.status).toBe(200)
    expect(fan.body).toEqual({ ok: true, kind: 'fan-out', outcome: 'fanned-out', day: today(), capUsd: expect.any(Number), published: 4, failed: 0, due: 4, notDue: 0, refusedEntries: 3 })
    expect(JSON.stringify(fan.body)).not.toContain('acme.test')
    const bodies = published.map((p) => p.body).sort((a, b) => String(a['host']).localeCompare(String(b['host'])))
    expect(bodies).toEqual([domainJob('acme.test', ws[ONE.id]!.workspace), domainJob('beta.test', ws[TWO.id]!.workspace), domainJob('delta.test', ws[ONE.id]!.workspace), domainJob('echo.test', ws[ONE.id]!.workspace)])
    const day = (await readDailyLedger(dir, kvLedgerStores(kv)))[today()]!
    expect(day.fanOut).toMatchObject({ published: 4, failed: 0 })
    expect(day.capUsd).toBeGreaterThan(0)
    expect(runner.calls).toEqual([])
    expect(existsSync(join(dir, 'daily-spend.json'))).toBe(false)
  })

  it('a domain job files its cycle in the workspace its entry names and in no other; a forged job naming another workspace for the host is not tracked; the entry whose account is not a member is refused at the database; the retry runs nothing; not armed is not armed', async () => {
    await post(FAN_OUT)
    const jobFor = (host: string) => published.find((p) => p.body['host'] === host)!.body
    const acme = await post(jobFor('acme.test'))
    expect(acme).toMatchObject({ status: 200, body: { ok: true, outcome: 'ran', host: 'acme.test', run: { status: 'scanned', calls: 85, spentUsd: 0.41 } } })
    expect(runner.calls).toEqual([{ domain: 'acme.test', day: today(), mode: 'live' }])
    // In One's workspace, through One's own token; nothing in Two's.
    expect((await storeOf(ONE).cycles.latest('acme.test'))?.day).toBe(today())
    expect(await storeOf(TWO).cycles.latest('acme.test')).toBeNull()
    expect(await storeOf(ONE).cycles.latest('beta.test')).toBeNull()
    const day = (await readDailyLedger(dir, kvLedgerStores(kv)))[today()]!
    // The day's line is the workspace's and the host's (the per-domain ceiling's key), never the bare host on a deployment.
    expect(day.domains[`${ws[ONE.id]!.workspace}:acme.test`]).toMatchObject({ status: 'scanned', spentUsd: 0.41, calls: 85 })
    expect(day.domains['acme.test']).toBeUndefined()
    expect(day.spentUsd).toBeCloseTo(0.41, 6)
    // Nothing on this instance's disk: no cycle file, no file ledger.
    expect(existsSync(join(dir, 'results'))).toBe(false)
    expect(existsSync(join(dir, 'daily-spend.json'))).toBe(false)

    // The host in a workspace it is not tracked for: no entry, nothing runs.
    expect(await post(domainJob('acme.test', ws[TWO.id]!.workspace))).toMatchObject({ status: 200, body: { ok: false, outcome: 'not-tracked' } })
    // The entry that names an account which is not a member of the workspace: refused by the database, nothing collected.
    expect(await post(domainJob('gamma.test', ws[ONE.id]!.workspace))).toMatchObject({ status: 200, body: { ok: false, outcome: 'refused', reason: expect.stringContaining('not a member') } })
    // The retry: today's cycle stands, nothing runs.
    expect(await post(jobFor('acme.test'))).toMatchObject({ status: 200, body: { ok: false, outcome: 'not-due' } })
    expect(runner.calls).toHaveLength(1)
    // Disarmed between the fan-out and a delivery: the job does nothing.
    delete process.env['GRADER_DAILY_LOOP']
    expect(await post(jobFor('beta.test'))).toMatchObject({ status: 200, body: { ok: false, outcome: 'not-armed' } })
    expect(runner.calls).toHaveLength(1)
  })

  it('a member\'s standing instruction files a cycle (ws_put_cycle is open to members); a job whose runner threw is settled and its retry is already-booked under the workspace\'s line; a role changed after tracking refuses the entry at the database with nothing collected', async () => {
    await post(FAN_OUT)
    const jobFor = (host: string) => published.find((p) => p.body['host'] === host)!.body
    // The member's entry: the token is minted with role member, the database agrees, and the cycle is filed in One's workspace.
    expect(await post(jobFor('delta.test'))).toMatchObject({ status: 200, body: { ok: true, outcome: 'ran', host: 'delta.test', run: { status: 'scanned' } } })
    expect((await storeOf(MEMBER, 'member').cycles.latest('delta.test'))?.day).toBe(today())
    expect(await storeOf(TWO).cycles.latest('delta.test')).toBeNull()
    // The runner throws for echo.test: settled at the expected cost, answered 200, and the retry meets the line — guard 2 at the route, keyed by the workspace.
    runner.fail.add('echo.test')
    const first = await post(jobFor('echo.test'))
    expect(first).toMatchObject({ status: 200, body: { ok: true, outcome: 'ran', host: 'echo.test', run: { status: expect.stringContaining('failed: socket hung up') } } })
    expect(await post(jobFor('echo.test'))).toMatchObject({ status: 200, body: { ok: false, outcome: 'already-booked', reason: expect.stringContaining(`${ws[ONE.id]!.workspace}:echo.test`) } })
    expect(runner.calls.filter((c) => c.domain === 'echo.test')).toHaveLength(1)
    const day = (await readDailyLedger(dir, kvLedgerStores(kv)))[today()]!
    expect(Object.keys(day.domains).sort()).toEqual([`${ws[ONE.id]!.workspace}:delta.test`, `${ws[ONE.id]!.workspace}:echo.test`])
    // The tracking account's role changes after tracking: the entry's snapshot disagrees with membership and the database refuses the token; nothing is collected.
    await pg.query('UPDATE workspace_members SET role = $1 WHERE account_id = $2 AND workspace_id = $3', ['admin', ws[MEMBER.id]!.account, ws[ONE.id]!.workspace])
    try {
      runner.calls.length = 0
      expect(await post(jobFor('delta.test'))).toMatchObject({ status: 200, body: { ok: false, outcome: 'refused', reason: expect.stringContaining('role does not match') } })
      expect(runner.calls).toEqual([])
    } finally {
      await pg.query('UPDATE workspace_members SET role = $1 WHERE account_id = $2 AND workspace_id = $3', ['member', ws[MEMBER.id]!.account, ws[ONE.id]!.workspace])
    }
  })
})
