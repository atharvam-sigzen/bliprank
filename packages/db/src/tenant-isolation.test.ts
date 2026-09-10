/**
 * Behavioural tenant isolation: two seeded tenants, real reads and writes, row
 * sets asserted disjoint.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE CATALOG CHECKS.
 *
 * The deploy-time gate asserts things ABOUT the
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
 * THE RULE: every relation the tenant role can read at all gets a case here
 * that establishes two real tenant contexts and asserts the visible row sets
 * do not intersect, unless it is on the shared allowlist by decision. The
 * subject is derived from what app_rw can SELECT, never from what a policy
 * says, so a new readable relation fails the first test below until a case is
 * written for it — a `USING (true)` policy included.
 */

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS } from './testing.js'

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
  for (const m of MIGRATIONS) {
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
    INSERT INTO workspace_cycles (workspace_id,host,day,algo_version,comparison_basis,result) VALUES
      ('${WS1}','one.example','2026-09-01','det-2','b','{}'), ('${WS2}','two.example','2026-09-01','det-2','b','{}');
    INSERT INTO workspace_documents (workspace_id,kind,host,version,body) VALUES
      ('${WS1}','category-record','one.example',1,'{}'), ('${WS2}','category-record','two.example',1,'{}');
    INSERT INTO workspace_requests (workspace_id,kind,host,body) VALUES
      ('${WS1}','category','one.example','{}'), ('${WS2}','category','two.example','{}');
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

/**
 * The relations exercised below, and the column used to identify a row in each.
 * Declared once, at the top, because the coverage guard derives from THIS —
 * an earlier version compared the manifest against a second hand-written list,
 * so adding a name to that list satisfied the guard while exercising nothing.
 */
const CASES: readonly (readonly [string, string])[] = [
  ['workspaces', 'id'],
  ['workspace_members', 'account_id'],
  ['workspace_brands', 'brand_id'],
  ['workspace_subscriptions', 'workspace_id'],
  ['accounts', 'id'],
  ['brands', 'id'],
  ['score_rows', 'brand_id'],
  ['score_aggregates', 'brand_id'],
  ['workspace_cycles', 'host'],
  ['workspace_documents', 'host'],
  ['workspace_requests', 'host'],
]

/**
 * The shared-corpus allowlist: relations every tenant may read in full, by
 * decision. Anything else the tenant role can read must have a disjointness
 * case below. Adding a name here is a product decision, not a test fix.
 */
const SHARED = new Set(['public.prompt_banks'])

/**
 * THE INVERSE (oversight review 2026-09-10, B3r item 3). The subject used to be
 * derived from pg_policies — "every relation whose policy mentions
 * current_workspace_id" — which asked the policy whether it needed checking.
 * A table with `USING (true)`, or a policy written through a wrapper function,
 * mentioned nothing and so was never required to have a case: it passed this
 * guard and the deploy gate while returning every tenant's rows. The subject
 * is now everything the tenant role can read at all — every schema, every
 * relation kind, any column — minus the shared allowlist. What a policy says
 * is irrelevant; that a case proves the row sets disjoint is the property.
 */
async function uncovered(): Promise<string[]> {
  const COVERED = new Set(CASES.map(([r]) => (r.includes('.') ? r : `public.${r}`)))
  const readable = (
    (
      await db.query(`
        SELECT ns.nspname || '.' || c.relname AS rel
          FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
           -- partitions are exercised through their parent, which owns the case
           AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
           AND (has_any_column_privilege('app_rw', c.oid, 'SELECT') OR has_any_column_privilege('public', c.oid, 'SELECT'))
         ORDER BY 1`)
    ).rows as { rel: string }[]
  ).map((r) => r.rel)
  // If the derivation comes back short, the sweep is asserting nothing.
  expect(readable.length).toBeGreaterThanOrEqual(CASES.length + SHARED.size)
  return readable.filter((r) => !SHARED.has(r) && !COVERED.has(r))
}

describe('every relation the tenant role can read has a disjointness case here, or is shared by decision', () => {
  it('nothing the tenant can read is left unexercised', async () => {
    expect(await uncovered()).toEqual([])
  })
})

describe('two real tenants, disjoint row sets', () => {
  const cases = CASES

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

describe('the capability column is not readable by the tenant (2026-09-10 audit, BLOCKER-1)', () => {
  it('accounts.auth_uid is permission denied for app_rw even inside a verified context, and the other columns are not', async () => {
    await asTenant(WS1, U1, async (q) => {
      await db.exec('SAVEPOINT s')
      await expect(db.query(`SELECT auth_uid FROM accounts`)).rejects.toThrow(/permission denied/)
      await db.exec('ROLLBACK TO SAVEPOINT s')
      await expect(db.query(`SELECT * FROM accounts`)).rejects.toThrow(/permission denied/)
      await db.exec('ROLLBACK TO SAVEPOINT s')
      expect(await q(`SELECT email, kind FROM accounts`)).toEqual([{ email: 'a@one.test', kind: 'brand' }])
    })
  })
})

describe('writes are scoped too, not only reads', () => {
  it('a tenant holds no write privilege on any scoped relation', async () => {
    // The catalog gate declares this; here it is exercised. A DELETE or TRUNCATE
    // grant is what audit 4 used to destroy the other tenant's rows from a
    // fully authenticated session, and neither is restrainable by a policy.
    // Derived the same way the gate derives it: every schema, every relkind a
    // tenant can read, column-level grants included, and every role that can
    // reach app_rw — not `has_table_privilege('app_rw', …)` over public tables,
    // which would pass a database the gate refuses.
    const held = await db.query(`
      SELECT DISTINCT ns.nspname || '.' || c.relname AS rel, p.priv, g.rolname
        FROM pg_class c
        JOIN pg_namespace ns ON ns.oid = c.relnamespace
       CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) AS p(priv)
       CROSS JOIN LATERAL (
         SELECT rolname FROM pg_roles
          WHERE rolname NOT LIKE 'pg\_%' AND NOT rolsuper
            AND (rolname = 'app_rw' OR pg_has_role(rolname, 'app_rw', 'MEMBER'))
         UNION ALL SELECT 'public'
       ) g
       WHERE ns.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
         AND c.relkind IN ('r','p','v','m','f')
         AND (has_table_privilege(g.rolname, c.oid, p.priv)
              OR (p.priv NOT IN ('TRUNCATE','DELETE') AND has_any_column_privilege(g.rolname, c.oid, p.priv)))`)
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

  // The case asserting that prompt_banks stops being shared the moment it gains
  // a workspace column lives with the deploy gate, on fix/tenancy-deploy-gate:
  // `shared-columns-changed` is a fault kind of tenancy_exposure_faults(), which
  // does not merge here (ADR-0007).
})

describe('the guard bites: a readable relation that no case covers is caught, whatever its policy says (B3r item 3)', () => {
  afterAll(async () => {
    await db.exec(`DROP TABLE IF EXISTS leaky_open, leaky_wrapped, leaky_required; DROP FUNCTION IF EXISTS ws_wrap()`)
  })

  it('a USING (true) table the tenant can read is uncovered', async () => {
    await db.exec(`
      CREATE TABLE leaky_open (workspace_id uuid NOT NULL);
      ALTER TABLE leaky_open ENABLE ROW LEVEL SECURITY; ALTER TABLE leaky_open FORCE ROW LEVEL SECURITY;
      GRANT SELECT ON leaky_open TO app_rw;
      CREATE POLICY open ON leaky_open FOR SELECT USING (true);
      INSERT INTO leaky_open VALUES ('${WS1}'), ('${WS2}')`)
    expect(await uncovered()).toContain('public.leaky_open')
    // And the case it would need is the one that fails: both tenants see both rows.
    expect(await visible(WS1, U1, 'leaky_open', 'workspace_id')).toEqual([WS1, WS2])
  })

  it('a policy through a wrapper that never names current_workspace_id is uncovered too', async () => {
    await db.exec(`
      CREATE FUNCTION ws_wrap() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT current_workspace_id() $$;
      CREATE TABLE leaky_wrapped (workspace_id uuid NOT NULL);
      ALTER TABLE leaky_wrapped ENABLE ROW LEVEL SECURITY; ALTER TABLE leaky_wrapped FORCE ROW LEVEL SECURITY;
      GRANT SELECT ON leaky_wrapped TO app_rw;
      CREATE POLICY wrapped ON leaky_wrapped FOR SELECT USING (workspace_id = ws_wrap())`)
    // The old derivation (qual LIKE '%current_workspace_id%') would not have listed this relation at all.
    expect(await uncovered()).toContain('public.leaky_wrapped')
  })

  it('ws_required() is not the tenant role to call: a policy through it fails closed rather than scoping (B3r item 2)', async () => {
    expect((await db.query(`SELECT has_function_privilege('app_rw', 'ws_required()', 'EXECUTE') AS x`)).rows).toEqual([{ x: false }])
    await db.exec(`
      CREATE TABLE leaky_required (workspace_id uuid NOT NULL);
      ALTER TABLE leaky_required ENABLE ROW LEVEL SECURITY; ALTER TABLE leaky_required FORCE ROW LEVEL SECURITY;
      GRANT SELECT ON leaky_required TO app_rw;
      CREATE POLICY required ON leaky_required FOR SELECT USING (workspace_id = ws_required());
      INSERT INTO leaky_required VALUES ('${WS1}')`)
    await expect(visible(WS1, U1, 'leaky_required', 'workspace_id')).rejects.toThrow(/permission denied for function ws_required/)
    expect(await uncovered()).toContain('public.leaky_required')
  })
})
