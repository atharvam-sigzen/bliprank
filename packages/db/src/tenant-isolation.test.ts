/**
 * Behavioural tenant isolation: two seeded tenants, real reads and writes, row
 * sets asserted disjoint.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE CATALOG CHECKS.
 *
 * `check-deploy.sql` and `tenancy_exposure_faults()` assert things ABOUT the
 * configuration: that a relation is declared, that RLS is forced, that a policy
 * mentions `current_workspace_id`. Every one of those is a proxy for the thing
 * customers actually pay for, which is that tenant A's rows never appear in
 * tenant B's result set.
 *
 * Audit 4 demonstrated the gap precisely. Both of these passed every static
 * assertion, and both returned another tenant's rows:
 *
 *   CREATE POLICY r ON t FOR SELECT USING (current_workspace_id() IS NOT NULL);
 *   CREATE POLICY r ON t FOR SELECT USING (workspace_id = current_workspace_id()
 *                                          OR workspace_id IS NULL);
 *
 * The first is the "authenticated means allowed" mistake; the second is the
 * "global rows are shared" convention. `qual LIKE '%current_workspace_id%'` is
 * true of both. A substring is not a scope, and no amount of catalog inspection
 * turns one into the other — which is why this file drives data rather than
 * reading pg_policies.
 *
 * THE RULE: every relation the manifest declares `scoped` gets a case here that
 * establishes two real tenant contexts and asserts the visible row sets do not
 * intersect. When a scoped relation is added to the manifest, add it here in the
 * same commit; the first test below fails if you do not.
 */

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const migration = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8')

const WS1 = '00000000-0000-4000-8000-000000000001'
const WS2 = '00000000-0000-4000-8000-000000000002'
const U1 = '00000000-0000-4000-8000-0000000000f1'
const U2 = '00000000-0000-4000-8000-0000000000f2'
const B1 = '00000000-0000-4000-8000-00000000000a' // WS1's brand
const B2 = '00000000-0000-4000-8000-00000000000b' // WS2's brand
const SECRET = 'a-secret-long-enough-to-satisfy-the-constraint'
const k = (c: string) => c.repeat(64)

let db: PGlite

function token(ws: string, sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const h = b64({ alg: 'HS256', typ: 'JWT', kid: 'k1' })
  const p = b64({ sub, workspace_id: ws, exp: Math.floor(Date.now() / 1000) + 300, iss: 'iss', aud: 'aud' })
  return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`
}

/** Run `fn` inside a real tenant session for `ws`, always rolled back. */
async function asTenant<T>(ws: string, sub: string, fn: (q: (sql: string) => Promise<unknown[]>) => Promise<T>): Promise<T> {
  await db.exec('BEGIN')
  try {
    await db.exec('SET LOCAL ROLE app_rw')
    await db.query(`SELECT set_workspace_jwt($1)`, [token(ws, sub)])
    return await fn(async (sql) => (await db.query(sql)).rows)
  } finally {
    await db.exec('ROLLBACK')
    await db.exec('RESET ROLE')
    await db.exec(`DELETE FROM auth_tenant_context`)
  }
}

/** Everything `app_rw` can see in `relation`, as a sorted list of one column. */
const visible = async (ws: string, sub: string, relation: string, col: string) =>
  asTenant(ws, sub, async (q) => ((await q(`SELECT ${col} AS v FROM ${relation} ORDER BY 1`)) as { v: unknown }[]).map((r) => r.v))

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } })
  for (const m of ['0000_init.sql', '0001_tenancy_identity.sql', '0002_tenancy_context.sql', '0003_tenancy_exposure_manifest.sql']) {
    await db.exec(migration(m))
  }
  await db.exec(`SET bliprank.rls_bypass_allowed = 'postgres'`)
  await db.exec(`INSERT INTO auth_signing_keys (kid, secret, issuer, audience) VALUES ('k1','${SECRET}','iss','aud')`)
  await db.exec(`SET ROLE svc_onboard`)
  await db.exec(`
    INSERT INTO accounts (id,email) VALUES ('${U1}','a@one.test'), ('${U2}','b@two.test');
    INSERT INTO workspaces (id,name) VALUES ('${WS1}','Client One'), ('${WS2}','Client Two');
    INSERT INTO workspace_members (workspace_id,account_id,role) VALUES ('${WS1}','${U1}','owner'), ('${WS2}','${U2}','owner');
    INSERT INTO brands (id,name,category) VALUES ('${B1}','OneCRM','crm'), ('${B2}','TwoCRM','crm');
    INSERT INTO workspace_subscriptions (workspace_id,plan,status,brand_limit,current_period_end)
      VALUES ('${WS1}','growth','active',5,'2099-01-01'), ('${WS2}','growth','active',5,'2099-01-01');
    INSERT INTO workspace_brands (workspace_id,brand_id,relation) VALUES ('${WS1}','${B1}','own'), ('${WS2}','${B2}','own');
  `)
  await db.exec(`RESET ROLE`)
  await db.exec(`SET ROLE svc_scorer`)
  await db.exec(`
    INSERT INTO score_rows (cell_key,day,engine,locale,geo,brand_id,algo_version,runs,mentions,citations) VALUES
      ('${k('1')}','2026-08-15','chatgpt','en-US','US','${B1}','0.1.0',10,4,1),
      ('${k('1')}','2026-08-15','chatgpt','en-US','US','${B2}','0.1.0',10,9,3);
    INSERT INTO score_aggregates VALUES
      ('${B1}','chatgpt','2026-08-11','week','0.1.0','mention',24,70,false),
      ('${B2}','chatgpt','2026-08-11','week','0.1.0','mention',61,70,false);
  `)
  await db.exec(`RESET ROLE`)
})

afterAll(async () => {
  await db.close()
})

describe('every scoped relation in the manifest has a disjointness case here', () => {
  /** Kept in step with the manifest by the test below, not by memory. */
  const COVERED = new Set([
    'workspaces',
    'workspace_members',
    'workspace_brands',
    'workspace_subscriptions',
    'accounts',
    'brands',
    'score_rows',
    'score_aggregates',
  ])

  it('the manifest declares nothing scoped that this file does not exercise', async () => {
    const declared = (
      (await db.query(`SELECT DISTINCT relation FROM tenancy_exposure_manifest WHERE disposition = 'scoped' ORDER BY 1`))
        .rows as { relation: string }[]
    ).map((r) => r.relation)
    // Partitions are exercised through their parent; everything else must have
    // its own case. A new scoped relation fails here until one is written.
    const missing = declared.filter((r) => !COVERED.has(r) && !r.startsWith('score_rows_'))
    expect(missing).toEqual([])
  })
})

describe('two real tenants, disjoint row sets', () => {
  const cases: [string, string][] = [
    ['workspaces', 'id'],
    ['workspace_members', 'account_id'],
    ['workspace_brands', 'brand_id'],
    ['workspace_subscriptions', 'workspace_id'],
    ['accounts', 'id'],
    ['brands', 'id'],
    ['score_rows', 'brand_id'],
    ['score_aggregates', 'brand_id'],
  ]

  for (const [relation, col] of cases) {
    it(`${relation}: what One sees and what Two sees do not intersect`, async () => {
      const one = await visible(WS1, U1, relation, col)
      const two = await visible(WS2, U2, relation, col)
      expect(one.length).toBeGreaterThan(0)
      expect(two.length).toBeGreaterThan(0)
      expect(one.filter((v) => two.includes(v))).toEqual([])
    })
  }

  it('score_rows: two brands share a cell_key, and neither tenant sees the other half', async () => {
    // The sharpest case for a filtered join: identical cache key, different
    // brand. A policy that scoped on the cell rather than the entitlement would
    // pass every catalog check and fail here.
    expect(await visible(WS1, U1, 'score_rows', 'mentions')).toEqual([4])
    expect(await visible(WS2, U2, 'score_rows', 'mentions')).toEqual([9])
  })

  it('an unentitled brand is not merely filtered — its existence is invisible', async () => {
    await asTenant(WS1, U1, async (q) => {
      expect(await q(`SELECT id FROM brands WHERE id = '${B2}'`)).toEqual([])
      expect(await q(`SELECT count(*)::int AS v FROM brands`)).toEqual([{ v: 1 }])
    })
  })

  it('no context sees nothing at all, on every scoped relation', async () => {
    await db.exec('BEGIN')
    try {
      await db.exec('SET LOCAL ROLE app_rw')
      for (const [relation] of cases) {
        expect([relation, (await db.query(`SELECT count(*)::int AS v FROM ${relation}`)).rows]).toEqual([relation, [{ v: 0 }]])
      }
    } finally {
      await db.exec('ROLLBACK')
      await db.exec('RESET ROLE')
    }
  })
})

describe('writes are scoped too, not only reads', () => {
  it('a tenant holds no write privilege on any scoped relation', async () => {
    // The catalog gate declares this; here it is exercised. A DELETE or TRUNCATE
    // grant is what audit 4 used to destroy the other tenant's rows from a
    // fully authenticated session, and neither is restrainable by a policy.
    const held = await db.query(`
      SELECT c.relname, p.priv FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) AS p(priv)
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND has_table_privilege('app_rw', c.oid, p.priv)`)
    expect(held.rows).toEqual([])
  })

  it('a legitimate session cannot write, update or delete through any scoped relation', async () => {
    await asTenant(WS1, U1, async (q) => {
      for (const sql of [
        `INSERT INTO workspace_brands (workspace_id, brand_id, relation) VALUES ('${WS1}','${B2}','competitor')`,
        `UPDATE workspace_subscriptions SET brand_limit = 9999`,
        `DELETE FROM workspace_brands`,
        `UPDATE score_rows SET mentions = 999`,
        `DELETE FROM score_rows`,
      ]) {
        await db.exec('SAVEPOINT s')
        await expect(db.query(sql)).rejects.toThrow(/permission denied/)
        await db.exec('ROLLBACK TO SAVEPOINT s')
      }
      void q
    })
  })
})

describe('the shared relation is genuinely shared, and stays that way', () => {
  it('prompt_banks returns the same rows to both tenants and to no-one', async () => {
    await db.exec(`SET ROLE svc_onboard`)
    await db.exec(`INSERT INTO prompt_banks (category,locale,geo,prompts) VALUES ('crm','en-GB','GB','["shared"]')`)
    await db.exec(`RESET ROLE`)
    const one = await visible(WS1, U1, 'prompt_banks', 'category')
    const two = await visible(WS2, U2, 'prompt_banks', 'category')
    expect(one).toEqual(two)
    expect(one.length).toBeGreaterThan(0)
  })

  it('it stops being shared the moment it can carry a tenant identity — with or without a foreign key', async () => {
    // The FK test alone was evaded by exactly the mistake its own comment named:
    // `workspace_id uuid` with no REFERENCES clause, holding two tenants'
    // private banks, passing every assertion.
    await db.exec(`ALTER TABLE prompt_banks ADD COLUMN workspace_id uuid`)
    try {
      const faults = (await db.query(`SELECT kind, detail FROM tenancy_exposure_faults()`)).rows as { kind: string }[]
      expect(faults.map((f) => f.kind)).toContain('shared-with-tenant-column')
    } finally {
      await db.exec(`ALTER TABLE prompt_banks DROP COLUMN workspace_id`)
    }
  })
})
