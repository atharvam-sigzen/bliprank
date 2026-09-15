import { withWorkspace } from '@bliprank/db/client'
import { migratedPglite, pgliteDb, TEST_KEY } from '@bliprank/db/testing'
import { mintWorkspaceToken } from '@bliprank/db/token'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pgWorkspaceStore, type WorkspaceStore } from './pg-store.js'

/**
 * The Postgres store against the real migrations on PGlite, inside real
 * workspace contexts: what a route will do once it holds a token. Two
 * workspaces, so every read is also an isolation check.
 */
let pg: Awaited<ReturnType<typeof migratedPglite>>
const UID_A = '44444444-0000-4000-8000-000000000001'
const UID_B = '44444444-0000-4000-8000-000000000002'
let tokenA: string
let tokenB: string

const inA = <T,>(fn: (s: WorkspaceStore) => Promise<T>) => withWorkspace(pgliteDb(pg), tokenA, (tx) => fn(pgWorkspaceStore(tx)))
const inB = <T,>(fn: (s: WorkspaceStore) => Promise<T>) => withWorkspace(pgliteDb(pg), tokenB, (tx) => fn(pgWorkspaceStore(tx)))

beforeAll(async () => {
  pg = await migratedPglite()
  const app = pgliteDb(pg)
  for (const [uid, email, name] of [[UID_A, 'a@a.test', 'A'], [UID_B, 'b@b.test', 'B']] as const) {
    await app.query('SELECT ensure_account($1, $2, $3)', [uid, email, 'brand'])
    await app.query('SELECT create_workspace($1, $2)', [uid, name])
  }
  const [a] = await app.query<{ account_id: string; workspace_id: string }>('SELECT account_id, workspace_id FROM workspaces_of($1)', [UID_A])
  const [b] = await app.query<{ account_id: string; workspace_id: string }>('SELECT account_id, workspace_id FROM workspaces_of($1)', [UID_B])
  tokenA = mintWorkspaceToken(TEST_KEY, { sub: a!.account_id, workspaceId: a!.workspace_id })
  tokenB = mintWorkspaceToken(TEST_KEY, { sub: b!.account_id, workspaceId: b!.workspace_id })
})
afterAll(async () => {
  await pg.close()
})

const result = (day: string, extra: Record<string, unknown> = {}) => ({ status: 'scanned', domain: 'acme.example', run: { day }, ...extra })

describe('cycles', () => {
  it('lists oldest first, reads one day, and the latest is the newest day', async () => {
    await inA(async (s) => {
      await s.cycles.put({ host: 'acme.example', day: '2026-09-02', algoVersion: 'det-2', comparisonBasis: 'b', result: result('2026-09-02') })
      await s.cycles.put({ host: 'acme.example', day: '2026-09-01', algoVersion: 'det-2', comparisonBasis: 'b', result: result('2026-09-01') })
    })
    const days = await inA((s) => s.cycles.list('acme.example'))
    expect(days.map((c) => c.day)).toEqual(['2026-09-01', '2026-09-02'])
    expect((await inA((s) => s.cycles.latest('acme.example')))?.day).toBe('2026-09-02')
    expect((await inA((s) => s.cycles.read('acme.example', '2026-09-01')))?.result).toEqual(result('2026-09-01'))
    expect(await inA((s) => s.cycles.read('acme.example', '2026-09-03'))).toBeNull()
  })

  it('a re-score is a new version of the same day, and the reader sees the newest', async () => {
    await inA((s) => s.cycles.put({ host: 'acme.example', day: '2026-09-01', algoVersion: 'det-3', comparisonBasis: 'b', result: result('2026-09-01', { rescored: true }) }))
    const got = await inA((s) => s.cycles.read('acme.example', '2026-09-01'))
    expect(got?.algoVersion).toBe('det-3')
    expect(got?.result).toMatchObject({ rescored: true })
    expect((await inA((s) => s.cycles.list('acme.example'))).map((c) => `${c.day}@${c.algoVersion}`)).toEqual(['2026-09-01@det-3', '2026-09-02@det-2'])
  })

  it('the other workspace holds none of it, and a malformed day never reaches the database', async () => {
    expect(await inB((s) => s.cycles.list('acme.example'))).toEqual([])
    expect(await inB((s) => s.cycles.latest('acme.example'))).toBeNull()
    await expect(inA((s) => s.cycles.read('acme.example', '2026/09/01'))).rejects.toThrow(/YYYY-MM-DD/)
  })
})

describe('documents', () => {
  it('versions climb, history is reassembled newest first, and `at` reads a version back with its own history', async () => {
    const v1 = await inA((s) => s.documents.put('category-record', 'acme.example', { slug: 'crm' }, 0))
    const v2 = await inA((s) => s.documents.put('category-record', 'acme.example', { slug: 'erp' }, 1))
    const v3 = await inA((s) => s.documents.put('category-record', 'acme.example', { slug: 'hr' }, 2))
    expect([v1, v2, v3]).toEqual([1, 2, 3])
    const latest = await inA((s) => s.documents.latest<{ slug: string }>('category-record', 'acme.example'))
    expect(latest?.version).toBe(3)
    expect(latest?.body).toEqual({ slug: 'hr' })
    expect(latest?.superseded.map((r) => [r.version, r.body.slug])).toEqual([[2, 'erp'], [1, 'crm']])
    const at2 = await inA((s) => s.documents.at<{ slug: string }>('category-record', 'acme.example', 2))
    expect(at2?.body).toEqual({ slug: 'erp' })
    expect(at2?.superseded.map((r) => r.version)).toEqual([1])
    expect(await inA((s) => s.documents.at('category-record', 'acme.example', 9))).toBeNull()
  })

  it('kinds and workspaces are separate sequences', async () => {
    expect(await inA((s) => s.documents.put('custom-prompts', 'acme.example', { prompts: ['x'] }, 0))).toBe(1)
    expect(await inB((s) => s.documents.put('category-record', 'acme.example', { slug: 'crm' }, 0))).toBe(1)
    expect((await inB((s) => s.documents.latest('category-record', 'acme.example')))?.superseded).toEqual([])
  })
})

describe('requests', () => {
  const T1 = '2026-09-10T10:00:00.000Z'
  const T2 = '2026-09-10T11:00:00.000Z'

  it('filing replaces the pending one; resolving is optimistic; history stays', async () => {
    await inA((s) => s.requests.file('category', 'acme.example', { slug: 'erp', reason: 'first' }, T1))
    await inA((s) => s.requests.file('category', 'acme.example', { slug: 'hr', reason: 'second' }, T2))
    const pending = await inA((s) => s.requests.pending<{ reason: string }>('category', 'acme.example'))
    expect(pending?.body.reason).toBe('second')
    expect(pending?.requestedAt).toBe(T2)
    expect(await inA((s) => s.requests.resolve('category', 'acme.example', T1, { status: 'applied', by: 'op' }))).toBe(false)
    expect(await inA((s) => s.requests.resolve('category', 'acme.example', T2, { status: 'applied', by: 'op', note: 'done' }))).toBe(true)
    expect(await inA((s) => s.requests.pending('category', 'acme.example'))).toBeNull()
    const all = await inA((s) => s.requests.forHost('category', 'acme.example'))
    expect(all.map((r) => [r.status, r.resolvedBy, r.note])).toEqual([['applied', 'op', 'done']])
  })

  it('allPending lists the kind across hosts, in this workspace only', async () => {
    await inA((s) => s.requests.file('competitors', 'one.example', { exclude: ['x'] }, T1))
    await inA((s) => s.requests.file('competitors', 'two.example', { exclude: ['y'] }, T2))
    await inB((s) => s.requests.file('competitors', 'three.example', { exclude: ['z'] }, T1))
    expect((await inA((s) => s.requests.allPending('competitors'))).map((r) => r.host)).toEqual(['one.example', 'two.example'])
    expect((await inB((s) => s.requests.allPending('competitors'))).map((r) => r.host)).toEqual(['three.example'])
  })
})
