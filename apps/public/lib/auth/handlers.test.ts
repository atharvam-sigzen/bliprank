import { migratedPglite, pgliteDb } from '@bliprank/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BRAND_OWNS_ONE, NOT_SIGNED_IN, NO_ACCOUNT, WORKSPACE_NAME, confirmAccount, createWorkspace, me, type Deps } from './handlers'
import type { AuthUser } from './supabase'

/**
 * The handlers against the real migrations on PGlite, as the tenant role.
 * The session is the one thing faked, because it is the one thing the
 * database does not verify (migration 0003's header: the trust boundary).
 */
let pg: Awaited<ReturnType<typeof migratedPglite>>
const BRAND: AuthUser = { id: '33333333-0000-4000-8000-000000000001', email: 'owner@brand.test' }
const AGENCY: AuthUser = { id: '33333333-0000-4000-8000-000000000002', email: 'ops@agency.test' }
const deps = (user: AuthUser | null): Deps => ({ user: async () => user, db: pgliteDb(pg) })

beforeAll(async () => {
  pg = await migratedPglite()
})
afterAll(async () => {
  await pg.close()
})

describe('the sign-in flow, end to end against the database', () => {
  it('no session: me is 401, creating a workspace is 401, confirm yields nothing', async () => {
    expect(await me(deps(null))).toEqual({ status: 401, body: { message: NOT_SIGNED_IN } })
    expect(await createWorkspace(deps(null), 'x')).toEqual({ status: 401, body: { message: NOT_SIGNED_IN } })
    expect(await confirmAccount(deps(null), 'brand')).toBeNull()
  })

  it('a session with no account yet is told so, and confirm creates the account with the chosen kind', async () => {
    expect(await me(deps(BRAND))).toEqual({ status: 404, body: { message: NO_ACCOUNT } })
    expect(await confirmAccount(deps(BRAND), 'brand')).toEqual({ kind: 'brand' })
    const got = await me(deps(BRAND))
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ account: { email: 'owner@brand.test', kind: 'brand' }, workspaces: [] })
  })

  it('a second confirm with another kind does not relabel the account', async () => {
    expect(await confirmAccount(deps(BRAND), 'agency')).toEqual({ kind: 'brand' })
    expect(await confirmAccount(deps(BRAND), 'nonsense')).toEqual({ kind: 'brand' })
  })

  it('a brand account creates one workspace, is refused a second with a sentence, and the name is bounded', async () => {
    expect(await createWorkspace(deps(BRAND), '   ')).toEqual({ status: 400, body: { message: WORKSPACE_NAME } })
    expect(await createWorkspace(deps(BRAND), 'x'.repeat(81))).toEqual({ status: 400, body: { message: WORKSPACE_NAME } })
    const made = await createWorkspace(deps(BRAND), '  Brand HQ ')
    expect(made.status).toBe(201)
    expect(made.body).toMatchObject({ name: 'Brand HQ' })
    expect(await createWorkspace(deps(BRAND), 'Second')).toEqual({ status: 409, body: { message: BRAND_OWNS_ONE } })
    const got = await me(deps(BRAND))
    expect(got.body).toMatchObject({ workspaces: [{ name: 'Brand HQ', role: 'owner' }] })
  })

  it('an agency account creates several, and each account lists only its own', async () => {
    expect(await confirmAccount(deps(AGENCY), 'agency')).toEqual({ kind: 'agency' })
    expect((await createWorkspace(deps(AGENCY), 'Client One')).status).toBe(201)
    expect((await createWorkspace(deps(AGENCY), 'Client Two')).status).toBe(201)
    const agency = await me(deps(AGENCY))
    expect((agency.body as { workspaces: { name: string }[] }).workspaces.map((w) => w.name)).toEqual(['Client One', 'Client Two'])
    const brand = await me(deps(BRAND))
    expect((brand.body as { workspaces: { name: string }[] }).workspaces.map((w) => w.name)).toEqual(['Brand HQ'])
  })

  it('an unexpected database failure is a fixed sentence and a log line, never the cause', async () => {
    const logged: unknown[] = []
    const broken: Deps = { user: async () => BRAND, db: { query: () => Promise.reject(new Error('connection refused at 10.0.0.9')), transaction: () => Promise.reject(new Error('no')) } }
    const r = await createWorkspace(broken, 'x', (e) => logged.push(e))
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.body)).not.toMatch(/10\.0\.0\.9/)
    expect(logged).toHaveLength(1)
  })
})
