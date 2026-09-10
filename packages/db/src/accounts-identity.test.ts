/**
 * Migration 0003 — accounts bound to a verified auth user, the account kind,
 * the one-workspace rule for brand accounts, and the three onboarding
 * functions the tenant role may call. PGlite, synthetic rows. `pnpm test:rls`.
 *
 * The properties MVP_PLAN B2 names: an account reads only its workspaces (the
 * existing token mechanism, re-asserted here through the new listing
 * function), and a brand account cannot create a second workspace.
 */

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const migration = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8')

const UID_B = '11111111-0000-4000-8000-000000000001' // a brand owner's Supabase auth id
const UID_A = '11111111-0000-4000-8000-000000000002' // an agency's
const UID_P = '11111111-0000-4000-8000-000000000003' // a pre-provisioned account's
const UID_X = '11111111-0000-4000-8000-00000000000f' // nobody
const SECRET = 'a-secret-long-enough-to-satisfy-the-constraint'

let db: PGlite

function token(ws: string, sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const h = b64({ alg: 'HS256', typ: 'JWT', kid: 'k1' })
  const p = b64({ sub, workspace_id: ws, exp: Math.floor(Date.now() / 1000) + 300, iss: 'iss', aud: 'aud' })
  return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`
}

/** Run `fn` as the tenant role in one transaction, always rolled back. */
async function asApp<T>(fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: unknown[] }>) => Promise<T>): Promise<T> {
  await db.exec('BEGIN')
  try {
    await db.exec('SET LOCAL ROLE app_rw')
    const q = async (sql: string, p?: unknown[]) => {
      await db.exec('SAVEPOINT s')
      try {
        return await db.query(sql, p)
      } catch (e) {
        await db.exec('ROLLBACK TO SAVEPOINT s')
        throw e
      }
    }
    return await fn(q)
  } finally {
    await db.exec('ROLLBACK')
    await db.exec('RESET ROLE')
    await db.exec('DELETE FROM auth_tenant_context')
  }
}

/** The same, committed: onboarding writes have to persist across cases. */
async function asAppCommitted<T>(sql: string, p?: unknown[]): Promise<T[]> {
  await db.exec('BEGIN')
  try {
    await db.exec('SET LOCAL ROLE app_rw')
    const r = await db.query(sql, p)
    await db.exec('COMMIT')
    return r.rows as T[]
  } catch (e) {
    await db.exec('ROLLBACK')
    throw e
  } finally {
    await db.exec('RESET ROLE')
  }
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } })
  for (const m of ['0000_init.sql', '0001_tenancy_identity.sql', '0002_tenancy_context.sql', '0003_accounts_identity.sql']) {
    await db.exec(migration(m))
  }
  await db.exec(`INSERT INTO auth_signing_keys (kid, secret, issuer, audience) VALUES ('k1','${SECRET}','iss','aud')`)
  // Two accounts provisioned by hand before their people ever signed in: one
  // inside an adoption window, one with none (never adoptable).
  await db.exec(`SET ROLE svc_onboard`)
  await db.exec(`INSERT INTO accounts (email, kind, adoptable_until) VALUES ('pre@agency.test', 'agency', now() + interval '1 day')`)
  await db.exec(`INSERT INTO accounts (email, kind) VALUES ('closed@agency.test', 'agency')`)
  await db.exec(`RESET ROLE`)
})

afterAll(async () => {
  await db.close()
})

describe('ensure_account — one account per verified auth user', () => {
  it('creates the account once and returns the same id on every later call, kind fixed at creation', async () => {
    const [first] = await asAppCommitted<{ id: string }>(`SELECT ensure_account($1, $2, $3) AS id`, [UID_B, 'owner@brand.test', 'brand'])
    const [again] = await asAppCommitted<{ id: string }>(`SELECT ensure_account($1, $2, $3) AS id`, [UID_B, 'owner@brand.test', 'agency'])
    expect(again!.id).toBe(first!.id)
    const rows = (await db.query(`SELECT kind, email FROM accounts WHERE auth_uid = $1`, [UID_B])).rows
    expect(rows).toEqual([{ kind: 'brand', email: 'owner@brand.test' }])
  })

  it('adopts a pre-provisioned account by email inside its window, once, and closes the window', async () => {
    const [got] = await asAppCommitted<{ id: string }>(`SELECT ensure_account($1, $2, $3) AS id`, [UID_P, 'pre@agency.test', 'brand'])
    const rows = (await db.query(`SELECT id, kind, auth_uid, adoptable_until FROM accounts WHERE email = 'pre@agency.test'`)).rows as { id: string; kind: string; auth_uid: string; adoptable_until: unknown }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ id: got!.id, kind: 'agency', auth_uid: UID_P, adoptable_until: null }) // the provisioned kind wins
  })

  it('a provisioned account with no window, and an email bound to another sign-in, are explicit refusals (audit MAJOR-1, MINOR-1)', async () => {
    await asApp(async (q) => {
      await expect(q(`SELECT ensure_account($1, 'closed@agency.test', 'brand')`, [UID_X])).rejects.toThrow(/already belongs to another sign-in/)
      await expect(q(`SELECT ensure_account($1, 'pre@agency.test', 'brand')`, [UID_X])).rejects.toThrow(/already belongs to another sign-in/)
    })
    expect((await db.query(`SELECT auth_uid FROM accounts WHERE email = 'closed@agency.test'`)).rows).toEqual([{ auth_uid: null }])
  })

  it('the tenant role cannot read auth_uid, the capability the functions are keyed on (audit BLOCKER-1)', async () => {
    await asApp(async (q) => {
      await expect(q(`SELECT auth_uid FROM accounts`)).rejects.toThrow(/permission denied/)
    })
  })

  it('owner writes refuse REPEATABLE READ, where the lock cannot serialise the recount (audit MAJOR-2)', async () => {
    await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ')
    try {
      await db.exec('SET LOCAL ROLE svc_onboard')
      await expect(db.query(`INSERT INTO workspaces (name) VALUES ('rr') RETURNING id`)).resolves.toBeDefined()
      const ws = (await db.query(`SELECT id FROM workspaces WHERE name = 'rr'`)).rows[0] as { id: string }
      const acct = (await db.query(`SELECT id FROM accounts WHERE email = 'closed@agency.test'`)).rows[0] as { id: string }
      await expect(db.query(`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES ($1, $2, 'owner')`, [ws.id, acct.id])).rejects.toThrow(/not safe at REPEATABLE READ/)
    } finally {
      await db.exec('ROLLBACK')
      await db.exec('RESET ROLE')
    }
  })

  it('refuses a missing uid, a missing email and an unknown kind', async () => {
    await asApp(async (q) => {
      await expect(q(`SELECT ensure_account(NULL, 'x@y.test', 'brand')`)).rejects.toThrow(/identity: ensure_account needs/)
      await expect(q(`SELECT ensure_account($1, '', 'brand')`, [UID_X])).rejects.toThrow(/identity: ensure_account needs/)
      await expect(q(`SELECT ensure_account($1, 'x@y.test', 'reseller')`, [UID_X])).rejects.toThrow(/identity: kind must be/)
    })
  })

  it('the tenant role still cannot write accounts directly — only through the function', async () => {
    await asApp(async (q) => {
      await expect(q(`INSERT INTO accounts (email) VALUES ('direct@x.test')`)).rejects.toThrow(/permission denied/)
      await expect(q(`UPDATE accounts SET kind = 'agency'`)).rejects.toThrow(/permission denied/)
    })
  })
})

describe('the one-workspace rule — brand = one, agency = many', () => {
  it('a brand account creates one workspace and is refused a second, with nothing left behind', async () => {
    const [ws] = await asAppCommitted<{ id: string }>(`SELECT create_workspace($1, $2) AS id`, [UID_B, '  Brand HQ '])
    expect(ws!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect((await db.query(`SELECT name FROM workspaces WHERE id = $1`, [ws!.id])).rows).toEqual([{ name: 'Brand HQ' }])
    const before = (await db.query(`SELECT count(*)::int AS n FROM workspaces`)).rows
    await expect(asAppCommitted(`SELECT create_workspace($1, $2)`, [UID_B, 'Second'])).rejects.toThrow(/brand account owns one workspace/)
    expect((await db.query(`SELECT count(*)::int AS n FROM workspaces`)).rows).toEqual(before)
  })

  it('an agency account creates several', async () => {
    await asAppCommitted(`SELECT ensure_account($1, $2, $3)`, [UID_A, 'ops@agency.test', 'agency'])
    await asAppCommitted(`SELECT create_workspace($1, $2)`, [UID_A, 'Client One'])
    await asAppCommitted(`SELECT create_workspace($1, $2)`, [UID_A, 'Client Two'])
    const rows = (await db.query(`SELECT workspace_name FROM workspaces_of($1) ORDER BY 1`, [UID_A])).rows
    expect(rows).toEqual([{ workspace_name: 'Client One' }, { workspace_name: 'Client Two' }])
  })

  it('the rule is the trigger\'s, so a direct owner insert by the onboarding role obeys it too', async () => {
    const brand = (await db.query(`SELECT id FROM accounts WHERE auth_uid = $1`, [UID_B])).rows[0] as { id: string }
    await db.exec('BEGIN')
    try {
      await db.exec('SET LOCAL ROLE svc_onboard')
      const ws = (await db.query(`INSERT INTO workspaces (name) VALUES ('Sneaky') RETURNING id`)).rows[0] as { id: string }
      await expect(db.query(`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES ($1, $2, 'owner')`, [ws.id, brand.id])).rejects.toThrow(/brand account owns one workspace/)
    } finally {
      await db.exec('ROLLBACK')
      await db.exec('RESET ROLE')
    }
  })

  it('a non-owner membership is not counted: a brand owner may be a member elsewhere', async () => {
    const brand = (await db.query(`SELECT id FROM accounts WHERE auth_uid = $1`, [UID_B])).rows[0] as { id: string }
    const other = (await db.query(`SELECT workspace_id FROM workspaces_of($1) WHERE workspace_name = 'Client One'`, [UID_A])).rows[0] as { workspace_id: string }
    await db.exec('BEGIN')
    try {
      await db.exec('SET LOCAL ROLE svc_onboard')
      await db.query(`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES ($1, $2, 'member')`, [other.workspace_id, brand.id])
      expect((await db.query(`SELECT count(*)::int AS n FROM workspace_members WHERE account_id = $1`, [brand.id])).rows).toEqual([{ n: 2 }])
    } finally {
      await db.exec('ROLLBACK')
      await db.exec('RESET ROLE')
    }
  })

  it('moving an owner membership to another workspace re-runs the rule (audit MINOR-3)', async () => {
    const brand = (await db.query(`SELECT account_id AS id, workspace_id FROM workspaces_of($1)`, [UID_B])).rows[0] as { id: string; workspace_id: string }
    const other = (await db.query(`SELECT workspace_id FROM workspaces_of($1) WHERE workspace_name = 'Client Two'`, [UID_A])).rows[0] as { workspace_id: string }
    await db.exec('BEGIN')
    try {
      await db.exec('SET LOCAL ROLE svc_onboard')
      // The brand keeps exactly one owned workspace either way; the move itself is allowed and re-checked.
      await db.query(`UPDATE workspace_members SET workspace_id = $1 WHERE account_id = $2 AND workspace_id = $3`, [other.workspace_id, brand.id, brand.workspace_id])
      expect((await db.query(`SELECT count(*)::int AS n FROM workspace_members WHERE account_id = $1 AND role = 'owner'`, [brand.id])).rows).toEqual([{ n: 1 }])
    } finally {
      await db.exec('ROLLBACK')
      await db.exec('RESET ROLE')
    }
  })

  it('an agency is bounded too: the fiftieth owned workspace is the last (audit MINOR-2)', async () => {
    await asAppCommitted(`SELECT ensure_account($1, $2, $3)`, ['11111111-0000-4000-8000-000000000050', 'big@agency.test', 'agency'])
    for (let i = 0; i < 50; i++) await asAppCommitted(`SELECT create_workspace($1, $2)`, ['11111111-0000-4000-8000-000000000050', `Client ${i}`])
    await expect(asAppCommitted(`SELECT create_workspace($1, $2)`, ['11111111-0000-4000-8000-000000000050', 'One too many'])).rejects.toThrow(/the ceiling/)
  })

  it('an agency that owns several cannot be relabelled a brand', async () => {
    await db.exec('BEGIN')
    try {
      await db.exec('SET LOCAL ROLE svc_onboard')
      await expect(db.query(`UPDATE accounts SET kind = 'brand' WHERE auth_uid = $1`, [UID_A])).rejects.toThrow(/cannot become a brand account/)
    } finally {
      await db.exec('ROLLBACK')
      await db.exec('RESET ROLE')
    }
  })
})

describe('an account reads only its workspaces', () => {
  it('the listing names exactly its own memberships, and nobody for an unknown uid', async () => {
    const mine = (await asApp(async (q) => q(`SELECT workspace_name, role, kind FROM workspaces_of($1)`, [UID_B]))).rows
    expect(mine).toEqual([{ workspace_name: 'Brand HQ', role: 'owner', kind: 'brand' }])
    const nobody = (await asApp(async (q) => q(`SELECT * FROM workspaces_of($1)`, [UID_X]))).rows
    expect(nobody).toEqual([])
  })

  it('an account with no workspace yet is still listed, with an empty workspace side', async () => {
    const rows = (await asApp(async (q) => q(`SELECT email, kind, workspace_id FROM workspaces_of($1)`, [UID_P]))).rows
    expect(rows).toEqual([{ email: 'pre@agency.test', kind: 'agency', workspace_id: null }])
  })

  it('a workspace is still read only through a verified token, and only by its member', async () => {
    const brand = (await db.query(`SELECT account_id AS id, workspace_id FROM workspaces_of($1)`, [UID_B])).rows[0] as { id: string; workspace_id: string }
    const agencyAcct = (await db.query(`SELECT account_id FROM workspaces_of($1)`, [UID_A])).rows[0] as { account_id: string }
    await asApp(async (q) => {
      // No token: nothing, even though the listing function answered above.
      expect((await q(`SELECT count(*)::int AS n FROM workspaces`)).rows).toEqual([{ n: 0 }])
      await q(`SELECT set_workspace_jwt($1)`, [token(brand.workspace_id, brand.id)])
      expect((await q(`SELECT id FROM workspaces`)).rows).toEqual([{ id: brand.workspace_id }])
    })
    await asApp(async (q) => {
      // The agency's account, signed correctly, naming the brand's workspace: refused.
      await expect(q(`SELECT set_workspace_jwt($1)`, [token(brand.workspace_id, agencyAcct.account_id)])).rejects.toThrow(/not a member/)
    })
  })

  it('the tenant role cannot read the identity tables around the functions', async () => {
    await asApp(async (q) => {
      expect((await q(`SELECT count(*)::int AS n FROM accounts`)).rows).toEqual([{ n: 0 }])
      expect((await q(`SELECT count(*)::int AS n FROM workspace_members`)).rows).toEqual([{ n: 0 }])
    })
  })
})

describe('what the migration leaves behind', () => {
  it('the three functions are definer-owned by svc_onboard and executable by app_rw only', async () => {
    const rows = (await db.query(`
      SELECT p.proname, o.rolname AS owner, p.prosecdef,
             has_function_privilege('app_rw', p.oid, 'EXECUTE') AS app_rw,
             has_function_privilege('svc_scorer', p.oid, 'EXECUTE') AS scorer
        FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
       WHERE p.proname IN ('ensure_account','create_workspace','workspaces_of') ORDER BY 1`)).rows
    expect(rows).toEqual([
      { proname: 'create_workspace', owner: 'svc_onboard', prosecdef: true, app_rw: true, scorer: false },
      { proname: 'ensure_account', owner: 'svc_onboard', prosecdef: true, app_rw: true, scorer: false },
      { proname: 'workspaces_of', owner: 'svc_onboard', prosecdef: true, app_rw: true, scorer: false },
    ])
  })

  it('the migration owner is not left a member of svc_onboard', async () => {
    // Read the catalog, not pg_has_role(): PGlite's owner is a superuser, for whom pg_has_role() is always true.
    const r = await db.query(`SELECT count(*)::int AS n FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member WHERE g.rolname = 'svc_onboard' AND m.rolname = current_user`)
    expect(r.rows).toEqual([{ n: 0 }])
  })
})
