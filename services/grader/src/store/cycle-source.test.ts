import { withWorkspace } from '@bliprank/db/client'
import { migratedPglite, pgliteDb, TEST_KEY } from '@bliprank/db/testing'
import { mintWorkspaceToken } from '@bliprank/db/token'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { listCycles } from '../cycles.js'
import { fileWorkspaceStore } from './file-store.js'
import { pgWorkspaceStore, runSourceOf, withSource, type WorkspaceStore } from './pg-store.js'

/**
 * Who started a cycle (migration 0009, MVP_PLAN C3): the loop when the
 * caller says so, a person otherwise. The column and the result's run stamp
 * say the same thing on the Postgres store, the file carries the same stamp
 * on the file store, and the database refuses a word that is neither and a
 * same-day re-write from the other source.
 */
let pg: Awaited<ReturnType<typeof migratedPglite>>
const UID = '55555555-0000-4000-8000-000000000001'
let token: string
const inA = <T,>(fn: (s: WorkspaceStore) => Promise<T>) => withWorkspace(pgliteDb(pg), token, (tx) => fn(pgWorkspaceStore(tx)))

beforeAll(async () => {
  pg = await migratedPglite()
  const app = pgliteDb(pg)
  await app.query('SELECT ensure_account($1, $2, $3)', [UID, 'a@a.test', 'brand'])
  await app.query('SELECT create_workspace($1, $2)', [UID, 'A'])
  const [a] = await app.query<{ account_id: string; workspace_id: string }>('SELECT account_id, workspace_id FROM workspaces_of($1)', [UID])
  token = mintWorkspaceToken(TEST_KEY, { sub: a!.account_id, workspaceId: a!.workspace_id, role: 'owner' })
})
afterAll(async () => {
  await pg.close()
})

const result = (host: string, day: string, run: Record<string, unknown> = {}) => ({ status: 'scanned', domain: host, run: { day, ...run } })
const put = (s: WorkspaceStore, host: string, day: string, extra: { source?: 'hand' | 'loop'; run?: Record<string, unknown>; algo?: string } = {}) =>
  s.cycles.put({ host, day, algoVersion: extra.algo ?? 'det-3', comparisonBasis: 'b', result: result(host, day, extra.run), ...(extra.source ? { source: extra.source } : {}) })

describe('the Postgres store', () => {
  it("the caller's word is the column and the stamp; no word is a person's; the runner's own stamp is honoured", async () => {
    await inA((s) => put(s, 'loop.example', '2026-09-10', { source: 'loop' }))
    await inA((s) => put(s, 'hand.example', '2026-09-10'))
    await inA((s) => put(s, 'stamped.example', '2026-09-10', { run: { source: 'loop' } }))
    const loop = await inA((s) => s.cycles.read('loop.example', '2026-09-10'))
    expect(loop?.source).toBe('loop')
    expect(runSourceOf(loop!.result)).toBe('loop')
    expect((await inA((s) => s.cycles.read('hand.example', '2026-09-10')))?.source).toBe('hand')
    expect((await inA((s) => s.cycles.read('stamped.example', '2026-09-10')))?.source).toBe('loop')
    // The column itself, read by the onboarding role that owns the rows.
    const rows = await pgliteDb(pg, 'svc_onboard').query<{ host: string; source: string }>('SELECT host, source FROM workspace_cycles WHERE host LIKE $1 ORDER BY host', ['%.example'])
    expect(rows).toEqual([
      { host: 'hand.example', source: 'hand' },
      { host: 'loop.example', source: 'loop' },
      { host: 'stamped.example', source: 'loop' },
    ])
    // `list` and `latest` carry it too.
    expect((await inA((s) => s.cycles.list('loop.example'))).map((c) => c.source)).toEqual(['loop'])
    expect((await inA((s) => s.cycles.latest('loop.example')))?.source).toBe('loop')
  })

  it('a word that is neither is refused at the database, and the store never sends one', async () => {
    // Straight at the writer, past the store's normalisation.
    await expect(
      withWorkspace(pgliteDb(pg), token, (tx) => tx.query('SELECT ws_put_cycle($1, $2::date, $3, $4, $5::jsonb)', ['robot.example', '2026-09-10', 'det-3', 'b', JSON.stringify(result('robot.example', '2026-09-10', { source: 'robot' }))])),
    ).rejects.toThrow(/started by hand or by the loop, not by robot/)
    // Through the store, an unknown stamp is not a source: the store writes `hand`.
    await inA((s) => put(s, 'robot.example', '2026-09-10', { run: { source: 'robot' } }))
    expect((await inA((s) => s.cycles.read('robot.example', '2026-09-10')))?.source).toBe('hand')
    expect(runSourceOf(withSource({}, 'loop'))).toBe('loop')
  })

  it('a same-day re-write from the other source is not the same measurement and is refused; from the same source it is a re-write', async () => {
    await inA((s) => put(s, 'rewrite.example', '2026-09-11', { source: 'loop' }))
    await expect(inA((s) => put(s, 'rewrite.example', '2026-09-11', { source: 'hand' }))).rejects.toThrow(/another basis or from another source/)
    await inA((s) => put(s, 'rewrite.example', '2026-09-11', { source: 'loop', run: { source: 'loop', again: true } }))
    const again = await inA((s) => s.cycles.read('rewrite.example', '2026-09-11'))
    expect(again?.source).toBe('loop')
    expect(again?.result['run']).toMatchObject({ again: true })
    // A re-score under a new algorithm version is a new row and may say who ran it.
    await inA((s) => put(s, 'rewrite.example', '2026-09-11', { source: 'hand', algo: 'det-4' }))
    expect((await inA((s) => s.cycles.read('rewrite.example', '2026-09-11')))?.source).toBe('hand')
  })
})

describe('the file store', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bliprank-cycle-source-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes the same stamp into the file and reads it back; no word is a person\'s', async () => {
    const s = fileWorkspaceStore(dir)
    await put(s, 'acme.example', '2026-09-10', { source: 'loop' })
    await put(s, 'acme.example', '2026-09-11')
    const cycles = await s.cycles.list('acme.example')
    expect(cycles.map((c) => [c.day, c.source])).toEqual([
      ['2026-09-10', 'loop'],
      ['2026-09-11', 'hand'],
    ])
    const onDisk = listCycles(dir, 'acme.example').map((c) => (JSON.parse(readFileSync(c.file, 'utf8')) as { run: { source?: string } }).run.source)
    expect(onDisk).toEqual(['loop', 'hand'])
    expect((await s.cycles.latest('acme.example'))?.source).toBe('hand')
  })
})
