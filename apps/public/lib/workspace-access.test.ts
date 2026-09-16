import { migratedPglite, pgliteDb } from '@bliprank/db/testing'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthUser } from './auth/supabase'

/**
 * How a route reaches workspace state (MVP_PLAN B3b): the file store with
 * identity off, refused on a fleet, and with identity on the ONE workspace
 * the verified session's account has — through the real migrations on
 * PGlite, with the session the only thing faked.
 */
const session = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock('./auth/supabase', () => ({ currentUser: async () => session.user }))
const pgHolder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('./auth/db', () => ({ appDb: () => pgHolder.db }))

import { NO_STORE, NO_WORKSPACE, SEVERAL_WORKSPACES, workspaceAccess } from './workspace-access'

let pg: Awaited<ReturnType<typeof migratedPglite>>
let dir: string
const BRAND: AuthUser = { id: '55555555-0000-4000-8000-000000000001', email: 'b@brand.test' }
const AGENCY: AuthUser = { id: '55555555-0000-4000-8000-000000000002', email: 'a@agency.test' }
const NOBODY: AuthUser = { id: '55555555-0000-4000-8000-000000000003', email: 'n@nobody.test' }
const IDENTITY = {
  SUPABASE_URL: 'https://x.supabase.test',
  SUPABASE_PUBLISHABLE_KEY: 'pk',
  DATABASE_URL: 'postgres://app_rw@pooler.test/db',
  AUTH_SIGNING_KID: 'k1',
  AUTH_SIGNING_SECRET: 'a-secret-long-enough-to-satisfy-the-constraint',
  AUTH_ISSUER: 'iss',
  AUTH_AUDIENCE: 'aud',
  SITE_URL: 'https://bliprank.test',
}

beforeAll(async () => {
  pg = await migratedPglite()
  pgHolder.db = pgliteDb(pg)
  const app = pgliteDb(pg)
  await app.query('SELECT ensure_account($1, $2, $3)', [BRAND.id, BRAND.email, 'brand'])
  await app.query('SELECT create_workspace($1, $2)', [BRAND.id, 'Brand HQ'])
  await app.query('SELECT ensure_account($1, $2, $3)', [AGENCY.id, AGENCY.email, 'agency'])
  await app.query('SELECT create_workspace($1, $2)', [AGENCY.id, 'Client One'])
  await app.query('SELECT create_workspace($1, $2)', [AGENCY.id, 'Client Two'])
})
afterAll(async () => {
  await pg.close()
})
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-access-'))
  session.user = null
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('identity off', () => {
  it('a machine that declares itself one process gets the file store over its data directory, and file ledgers', async () => {
    const a = await workspaceAccess({ NODE_ENV: 'test', GRADER_DATA_DIR: dir, COLLECTOR_TOPOLOGY: 'single-process' })
    expect(a.ok && a.backend).toBe('file')
    expect(a.ok && a.ledgers.backend).toBe('file')
    expect(a.ok && a.who).toBe('local')
  })

  it('a fleet runtime is refused the file store outright, by marker or by declaration (B3c item 4)', async () => {
    expect(await workspaceAccess({ NODE_ENV: 'test', GRADER_DATA_DIR: dir, VERCEL: '1' }, () => {})).toEqual({ ok: false, status: 503, message: NO_STORE })
    expect(await workspaceAccess({ NODE_ENV: 'test', GRADER_DATA_DIR: dir, COLLECTOR_TOPOLOGY: 'fleet' }, () => {})).toEqual({ ok: false, status: 503, message: NO_STORE })
    // A route never declares single-process for itself: a marker set beside the declaration is still a fleet.
    expect(await workspaceAccess({ NODE_ENV: 'test', GRADER_DATA_DIR: dir, VERCEL: '1', COLLECTOR_TOPOLOGY: 'single-process' }, () => {})).toEqual({ ok: false, status: 503, message: NO_STORE })
  })
})

describe('identity on: the workspace is the session\'s, and only the session\'s', () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', ...IDENTITY, GRADER_DATA_DIR: '', COLLECTOR_TOPOLOGY: 'single-process' }
  beforeEach(() => {
    env.GRADER_DATA_DIR = dir
  })

  it('no session is 401', async () => {
    const a = await workspaceAccess(env)
    expect(a).toMatchObject({ ok: false, status: 401 })
  })

  it('a session with no account is 404', async () => {
    session.user = NOBODY
    expect(await workspaceAccess(env)).toMatchObject({ ok: false, status: 404 })
  })

  it('an account with no workspace is told to create one', async () => {
    const app = pgliteDb(pg)
    const LONE: AuthUser = { id: '55555555-0000-4000-8000-000000000004', email: 'l@lone.test' }
    await app.query('SELECT ensure_account($1, $2, $3)', [LONE.id, LONE.email, 'brand'])
    session.user = LONE
    expect(await workspaceAccess(env)).toEqual({ ok: false, status: 409, message: NO_WORKSPACE })
  })

  it('an agency with several workspaces is refused until choosing one is built (D1), never silently given one', async () => {
    session.user = AGENCY
    expect(await workspaceAccess(env)).toEqual({ ok: false, status: 409, message: SEVERAL_WORKSPACES })
  })

  it('a brand account gets the Postgres store scoped to its one workspace, and reads only its own rows', async () => {
    session.user = BRAND
    const a = await workspaceAccess(env)
    expect(a.ok && a.backend).toBe('postgres')
    if (!a.ok) return
    expect(await a.store.documents.put('category-record', 'acme.test', { slug: 'crm-software' }, 0)).toBe(1)
    expect((await a.store.documents.latest('category-record', 'acme.test'))?.version).toBe(1)
    // The row landed in the brand's workspace and nowhere else.
    const rows = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_documents d JOIN workspace_members m ON m.workspace_id = d.workspace_id JOIN accounts acc ON acc.id = m.account_id WHERE acc.auth_uid = $1`, [BRAND.id])
    expect(rows.rows).toEqual([{ n: 1 }])
    expect((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_documents`)).rows).toEqual([{ n: 1 }])
  })
})
