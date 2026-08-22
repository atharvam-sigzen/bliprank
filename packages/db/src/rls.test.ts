/**
 * RLS policy suite — CLAUDE.md rule R7: tenancy is verified mechanically.
 * PGlite (real Postgres in-process), synthetic rows only. `pnpm test:rls`.
 *
 * Covers the hardened model: authority in roles not GUCs, entitlement granted
 * not self-declared, FORCE RLS on every table incl. partitions, transaction-
 * stamped tenant context that fails closed on a leaked GUC.
 */

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'

let db: PGlite

const WS1 = '00000000-0000-4000-8000-000000000001'
const WS2 = '00000000-0000-4000-8000-000000000002'
const ACME = '00000000-0000-4000-8000-00000000000a' // entitled to ws1 (own)
const BRIT = '00000000-0000-4000-8000-00000000000b' // entitled to ws2 (own)
const COMP = '00000000-0000-4000-8000-00000000000c' // ws1's competitor; ws2 has NO entitlement
const USER1 = '00000000-0000-4000-8000-0000000000f1'
const USER2 = '00000000-0000-4000-8000-0000000000f2'
const k = (c: string) => c.repeat(64)

const KID = 'k1'
const SECRET = 'test-signing-secret-not-a-real-one'
const OWNER_OF: Record<string, string> = { [WS1]: USER1, [WS2]: USER2 }

/** Mint an HS256 token the way the web app's session layer will. */
function mint(claims: Record<string, unknown>, opts: { secret?: string; kid?: string; alg?: string } = {}): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: opts.alg ?? 'HS256', typ: 'JWT', kid: opts.kid ?? KID })
  const body = b64({ exp: Math.floor(Date.now() / 1000) + 300, ...claims })
  const sig = createHmac('sha256', opts.secret ?? SECRET).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

const tokenFor = (ws: string, account = OWNER_OF[ws]) => mint({ sub: account, workspace_id: ws })

type Role = 'app_rw' | 'svc_scorer' | 'svc_onboard'

/** Run `fn` in one transaction as `role`, with the tenant context stamped via set_workspace(). */
async function as<T>(role: Role, ctx: { workspace?: string; leakStaleWs?: string }, fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: unknown[] }>) => Promise<T>): Promise<T> {
  await db.exec('BEGIN')
  try {
    // Simulate a leaked session GUC from a *previous* transaction: set it with is_local=false
    // BEFORE stamping this txn, so its app.workspace_at timestamp is stale.
    if (ctx.leakStaleWs) {
      await db.exec('COMMIT')
      await db.exec(`SELECT set_config('app.workspace_id', '${ctx.leakStaleWs}', false)`)
      await db.exec(`SELECT set_config('app.workspace_at', '1999-01-01 00:00:00+00', false)`)
      await db.exec('BEGIN')
    }
    await db.exec(`SET LOCAL ROLE ${role}`)
    if (ctx.workspace) {
      // app_rw has no EXECUTE on set_workspace() any more: the only way it gets a
      // tenant context is a token the database verifies for itself (0001).
      if (role === 'app_rw') await db.query(`SELECT set_workspace_jwt($1)`, [tokenFor(ctx.workspace)])
      else await db.query(`SELECT set_workspace($1)`, [ctx.workspace])
    }
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
    await db.exec(`RESET ROLE`)
    await db.exec(`SELECT set_config('app.workspace_id', '', false)`)
    await db.exec(`SELECT set_config('app.account_id', '', false)`)
    await db.exec(`SELECT set_config('app.workspace_at', '', false)`)
  }
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(readFileSync(new URL('../migrations/0000_init.sql', import.meta.url), 'utf8'))
  await db.exec(readFileSync(new URL('../migrations/0001_tenancy_identity.sql', import.meta.url), 'utf8'))
  await db.exec(`INSERT INTO auth_signing_keys (kid, secret) VALUES ('${KID}', '${SECRET}')`)
  // Seed as svc_onboard (identity + entitlements) and svc_scorer (corpus) — the roles that may write.
  await db.exec(`SET ROLE svc_onboard`)
  await db.exec(`
    INSERT INTO accounts (id, email) VALUES ('${USER1}','a@ws1.test'), ('${USER2}','b@ws2.test');
    INSERT INTO workspaces (id, name) VALUES ('${WS1}','Agency One'), ('${WS2}','Brand Two');
    INSERT INTO workspace_members (workspace_id, account_id, role) VALUES ('${WS1}','${USER1}','owner'), ('${WS2}','${USER2}','owner');
    INSERT INTO brands (id, name, category) VALUES ('${ACME}','AcmeCRM','crm'), ('${BRIT}','BritCRM','crm'), ('${COMP}','CompCRM','crm');
    INSERT INTO workspace_subscriptions (workspace_id, plan, status, brand_limit, current_period_end) VALUES
      ('${WS1}','growth','active',5,'2099-01-01'), ('${WS2}','starter','active',2,'2099-01-01');
    INSERT INTO workspace_brands (workspace_id, brand_id, relation) VALUES ('${WS1}','${ACME}','own'), ('${WS1}','${COMP}','competitor'), ('${WS2}','${BRIT}','own');
  `)
  await db.exec(`RESET ROLE`)
  await db.exec(`SET ROLE svc_scorer`)
  await db.exec(`
    INSERT INTO score_rows (cell_key,day,engine,locale,geo,brand_id,algo_version,runs,mentions,citations) VALUES
      ('${k('1')}','2026-08-15','chatgpt','en-US','US','${ACME}','0.1.0',10,4,1),
      ('${k('2')}','2026-08-15','chatgpt','en-US','US','${BRIT}','0.1.0',10,7,2),
      ('${k('3')}','2026-08-15','gemini','en-US','US','${COMP}','0.1.0',10,2,0),
      ('${k('4')}','2026-09-02','chatgpt','en-US','US','${ACME}','0.1.0',10,5,2);
    INSERT INTO score_aggregates VALUES
      ('${ACME}','chatgpt','2026-08-11','week','0.1.0','mention',24,70,false),
      ('${BRIT}','chatgpt','2026-08-11','week','0.1.0','mention',40,70,false);
  `)
  await db.exec(`RESET ROLE`)
})

afterAll(async () => {
  await db.close()
})

describe('the standing sweep that catches the next migration', () => {
  it('every public table forces RLS', async () => {
    const r = await db.query(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`)
    expect(r.rows).toEqual([])
  })

  it('every table reachable by the tenant role scopes its reads on the workspace (RLS-on is not enough)', async () => {
    // Genuinely shared, deliberately unscoped-for-tenant reads. Anything else that
    // app_rw/PUBLIC can SELECT must reference current_workspace_id in its qual.
    const SHARED = new Set(['prompt_banks'])
    // Tables app_rw can SELECT from:
    const readable = (await db.query(`
      SELECT DISTINCT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p')
        AND has_table_privilege('app_rw', c.oid, 'SELECT')`)).rows as { relname: string }[]
    const badly: string[] = []
    for (const { relname } of readable) {
      if (SHARED.has(relname)) continue
      // a SELECT/ALL policy applying to PUBLIC or app_rw must mention current_workspace_id
      const pols = (await db.query(`
        SELECT qual FROM pg_policies
        WHERE schemaname='public' AND tablename=$1 AND cmd IN ('SELECT','ALL')
          AND (roles = '{public}' OR 'app_rw' = ANY(roles))`, [relname])).rows as { qual: string | null }[]
      const scoped = pols.length > 0 && pols.every((p) => (p.qual ?? '').includes('current_workspace_id'))
      if (!scoped) badly.push(relname)
    }
    expect(badly).toEqual([])
  })

  it('no login-capable role is a member of more than one service group (MAJOR-C invariant)', async () => {
    // In this migration there are no login roles; the assertion is the standing
    // check that a deploy-time GRANT never puts one in two groups.
    const r = await db.query(`
      SELECT m.rolname, count(*)::int AS groups
      FROM pg_auth_members am
      JOIN pg_roles g ON g.oid = am.roleid
      JOIN pg_roles m ON m.oid = am.member
      WHERE g.rolname IN ('app_rw','svc_scorer','svc_onboard')
      GROUP BY m.rolname HAVING count(*) > 1`)
    expect(r.rows).toEqual([])
  })
})

describe('partitioning', () => {
  it('rows route to monthly partitions through the parent', async () => {
    expect((await db.query(`SELECT count(*)::int n FROM score_rows_2026_08`)).rows[0]).toEqual({ n: 3 })
    expect((await db.query(`SELECT count(*)::int n FROM score_rows_2026_09`)).rows[0]).toEqual({ n: 1 })
  })
  it('there is no default partition (a stray day fails loudly, never poisons pruning)', async () => {
    expect((await db.query(`SELECT count(*)::int n FROM pg_partition_tree('score_rows') WHERE isleaf AND relid::regclass::text LIKE '%default%'`)).rows[0]).toEqual({ n: 0 })
    await db.exec(`SET ROLE svc_scorer`)
    await expect(db.query(`INSERT INTO score_rows (cell_key,day,engine,locale,geo,brand_id,algo_version,runs,mentions,citations) VALUES ('${k('7')}','2199-01-01','chatgpt','en-US','US','${ACME}','0.1.0',1,0,0)`)).rejects.toThrow(/no partition/)
    await db.exec(`RESET ROLE`)
  })
})

describe('rule R7 — tenancy is mechanical and fails closed', () => {
  it('a workspace sees only itself, its members, its entitlements, its entitled brands', async () => {
    await as('app_rw', { workspace: WS1 }, async (q) => {
      expect((await q('SELECT id FROM workspaces')).rows).toEqual([{ id: WS1 }])
      expect((await q('SELECT account_id FROM workspace_members')).rows).toEqual([{ account_id: USER1 }])
      expect((await q('SELECT brand_id FROM workspace_brands ORDER BY brand_id')).rows).toHaveLength(2)
      expect((await q('SELECT id FROM brands ORDER BY id')).rows).toEqual([{ id: ACME }, { id: COMP }]) // NOT BritCRM
      expect((await q('SELECT email FROM accounts')).rows).toEqual([{ email: 'a@ws1.test' }])
    })
  })

  it('score rows are a filtered join over entitlements; another tenant sees nothing of yours', async () => {
    await as('app_rw', { workspace: WS1 }, async (q) => {
      const b = (await q('SELECT DISTINCT brand_id FROM score_rows ORDER BY brand_id')).rows as { brand_id: string }[]
      expect(b.map((r) => r.brand_id).sort()).toEqual([ACME, COMP].sort())
    })
    await as('app_rw', { workspace: WS2 }, async (q) => {
      expect((await q('SELECT DISTINCT brand_id FROM score_rows')).rows).toEqual([{ brand_id: BRIT }])
      expect((await q(`SELECT * FROM score_rows WHERE brand_id='${ACME}'`)).rows).toEqual([])
      expect((await q(`SELECT * FROM score_aggregates WHERE brand_id='${ACME}'`)).rows).toEqual([])
      expect((await q(`SELECT * FROM brands WHERE id='${ACME}'`)).rows).toEqual([]) // can't even see the brand exists
      expect((await q(`SELECT * FROM workspaces WHERE id='${WS1}'`)).rows).toEqual([])
    })
  })

  it('no tenant context = no rows anywhere', async () => {
    await as('app_rw', {}, async (q) => {
      for (const t of ['workspaces', 'workspace_members', 'workspace_brands', 'brands', 'score_rows', 'score_aggregates', 'accounts']) {
        // prompt_banks is deliberately shared (category reference data), so it is excluded here.
        expect((await q(`SELECT count(*)::int n FROM ${t}`)).rows).toEqual([{ n: 0 }])
      }
    })
  })

  it('a leaked session GUC from a prior transaction fails closed (transaction-stamped context)', async () => {
    await as('app_rw', { leakStaleWs: WS1 }, async (q) => {
      // the stale GUC names WS1 but its timestamp is from another txn → resolves to NULL → 0 rows
      expect((await q('SELECT count(*)::int n FROM score_rows')).rows).toEqual([{ n: 0 }])
      expect((await q('SELECT count(*)::int n FROM workspaces')).rows).toEqual([{ n: 0 }])
    })
  })
})

describe('authority is in roles, not GUCs', () => {
  it('a tenant CANNOT self-issue an entitlement to read the whole corpus', async () => {
    await as('app_rw', { workspace: WS2 }, async (q) => {
      // no INSERT grant on workspace_brands for app_rw at all
      await expect(q(`INSERT INTO workspace_brands (workspace_id, brand_id, relation) VALUES ('${WS2}','${ACME}','competitor')`)).rejects.toThrow(/permission denied/)
      // and even brute-forcing every brand id is moot — app_rw can't see brand ids it isn't entitled to
      expect((await q(`SELECT id FROM brands`)).rows).toEqual([{ id: BRIT }])
    })
  })

  it('a tenant setting app.service=scorer achieves nothing — writes are role-gated', async () => {
    await as('app_rw', { workspace: WS2 }, async (q) => {
      await q(`SELECT set_config('app.service','scorer',true)`) // self-asserted, meaningless
      await expect(
        q(`INSERT INTO score_rows (cell_key,day,engine,locale,geo,brand_id,algo_version,runs,mentions,citations) VALUES ('${k('9')}','2026-08-15','chatgpt','en-US','US','${ACME}','0.1.0',1000,0,0)`),
      ).rejects.toThrow(/permission denied|row-level security/)
    })
    // the scorer role (different DSN) is the only writer
    await as('svc_scorer', {}, async (q) => {
      await q(`INSERT INTO score_rows (cell_key,day,engine,locale,geo,brand_id,algo_version,runs,mentions,citations) VALUES ('${k('9')}','2026-08-15','chatgpt','en-US','US','${ACME}','0.1.0',5,1,0)`)
    })
  })

  it('the tenant role cannot mutate identity, entitlements, brands, or scores', async () => {
    await as('app_rw', { workspace: WS1 }, async (q) => {
      for (const sql of [
        `UPDATE accounts SET email='x@evil.test' WHERE id='${USER1}'`,
        `DELETE FROM accounts WHERE id='${USER1}'`,
        `UPDATE workspace_members SET role='owner'`,
        `DELETE FROM workspace_brands WHERE brand_id='${ACME}'`,
        `UPDATE brands SET name='Hijacked' WHERE id='${ACME}'`,
        `UPDATE score_rows SET mentions=999 WHERE brand_id='${ACME}'`,
        `DELETE FROM score_rows WHERE brand_id='${ACME}'`,
        `UPDATE score_aggregates SET successes=0`,
      ]) {
        await expect(q(sql)).rejects.toThrow(/permission denied/)
      }
    })
  })

  it('partitions are unreachable directly by the tenant role', async () => {
    await as('app_rw', { workspace: WS1 }, async (q) => {
      await expect(q('SELECT count(*) FROM score_rows_2026_08')).rejects.toThrow(/permission denied/)
    })
  })

  it('even with a direct grant, a partition still enforces the entitlement policy (FORCE + own policy)', async () => {
    // grant SELECT on the partition as the owner, then read it as a wrong tenant: RLS must still hold
    await db.exec(`GRANT SELECT ON score_rows_2026_08 TO app_rw`)
    try {
      await as('app_rw', { workspace: WS2 }, async (q) => {
        expect((await q(`SELECT * FROM score_rows_2026_08 WHERE brand_id='${ACME}'`)).rows).toEqual([])
      })
    } finally {
      await db.exec(`REVOKE SELECT ON score_rows_2026_08 FROM app_rw`)
    }
  })
})

describe('ensure_score_partition builds a safe partition (MAJOR-B)', () => {
  it('a newly provisioned month is forced-RLS, entitlement-scoped, and scorer-writable', async () => {
    await db.exec(`SELECT ensure_score_partition('2026-10-01')`)
    // the FORCE sweep still passes (new partition included)
    const unforced = await db.query(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`)
    expect(unforced.rows).toEqual([])
    // scorer writes October (persisted — not inside the auto-rollback helper); a wrong tenant reads nothing
    await db.exec(`SET ROLE svc_scorer`)
    await db.exec(`INSERT INTO score_rows (cell_key,day,engine,locale,geo,brand_id,algo_version,runs,mentions,citations) VALUES ('${k('a')}','2026-10-05','chatgpt','en-US','US','${ACME}','0.1.0',5,2,0)`)
    await db.exec(`RESET ROLE`)
    await as('app_rw', { workspace: WS2 }, async (q) => {
      expect((await q(`SELECT * FROM score_rows WHERE day='2026-10-05'`)).rows).toEqual([])
    })
    await as('app_rw', { workspace: WS1 }, async (q) => {
      expect((await q(`SELECT mentions FROM score_rows WHERE day='2026-10-05' AND brand_id='${ACME}'`)).rows).toEqual([{ mentions: 2 }])
    })
  })
})

describe('the scorer reads back what it writes (MINOR fix)', () => {
  it('svc_scorer can SELECT score_rows without tripping the entitlement policy', async () => {
    await as('svc_scorer', {}, async (q) => {
      const r = await q(`INSERT INTO score_rows (cell_key,day,engine,locale,geo,brand_id,algo_version,runs,mentions,citations) VALUES ('${k('b')}','2026-08-15','copilot','en-US','US','${BRIT}','0.1.0',5,3,1) RETURNING mentions`)
      expect(r.rows).toEqual([{ mentions: 3 }])
      expect(((await q(`SELECT count(*)::int n FROM score_rows`)).rows[0] as { n: number }).n).toBeGreaterThan(0)
    })
  })
})

describe('schema constraints on synthetic rows', () => {
  it('rejects impossible counts, bad cell keys, unknown enums', async () => {
    await as('svc_scorer', {}, async (q) => {
      await expect(q(`INSERT INTO score_rows (cell_key,day,engine,locale,geo,brand_id,algo_version,runs,mentions,citations) VALUES ('${k('6')}','2026-08-16','chatgpt','en-US','US','${ACME}','0.1.0',5,6,0)`)).rejects.toThrow(/check constraint|violates/)
      await expect(q(`INSERT INTO score_rows (cell_key,day,engine,locale,geo,brand_id,algo_version,runs,mentions,citations) VALUES ('not-a-hash','2026-08-16','chatgpt','en-US','US','${ACME}','0.1.0',5,1,0)`)).rejects.toThrow(/check constraint|violates/)
    })
    await as('svc_onboard', {}, async (q) => {
      await expect(q(`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES ('${WS1}','${USER1}','superuser')`)).rejects.toThrow(/check constraint|violates/)
    })
  })
})

describe('(D) the tenant cannot name a workspace — it presents a token the DB verifies', () => {
  async function asTenantRaw<T>(fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: unknown[] }>) => Promise<T>): Promise<T> {
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
    }
  }

  it('THE FINDING: app_rw has no way to call the unverified setter at all', async () => {
    // This is what made the web app the authorization boundary in 0000: any
    // app_rw connection could name any workspace, so one SQL injection in the
    // shared role was a full cross-tenant read.
    await asTenantRaw(async (q) => {
      await expect(q(`SELECT set_workspace('${WS1}')`)).rejects.toThrow(/permission denied/)
    })
  })

  it('a valid token reads exactly its own workspace', async () => {
    await asTenantRaw(async (q) => {
      expect((await q(`SELECT set_workspace_jwt($1) AS ws`, [tokenFor(WS1)])).rows).toEqual([{ ws: WS1 }])
      expect((await q('SELECT id FROM workspaces')).rows).toEqual([{ id: WS1 }])
    })
  })

  it('a token signed with the wrong secret is refused', async () => {
    await asTenantRaw(async (q) => {
      const forged = mint({ sub: USER1, workspace_id: WS1 }, { secret: 'attacker' })
      await expect(q(`SELECT set_workspace_jwt($1)`, [forged])).rejects.toThrow(/bad signature/)
    })
  })

  it('alg=none and an unknown kid are both refused (algorithm confusion)', async () => {
    await asTenantRaw(async (q) => {
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
      const none = `${b64({ alg: 'none', typ: 'JWT', kid: KID })}.${b64({ sub: USER1, workspace_id: WS1, exp: 4102444800 })}.`
      await expect(q(`SELECT set_workspace_jwt($1)`, [none])).rejects.toThrow(/unsupported alg/)
      const wrongKid = mint({ sub: USER1, workspace_id: WS1 }, { kid: 'k-nope' })
      await expect(q(`SELECT set_workspace_jwt($1)`, [wrongKid])).rejects.toThrow(/unknown or retired key/)
    })
  })

  it('a correctly signed token for a workspace you are NOT in is refused', async () => {
    // The signature proves who; membership decides what. USER2 holds a real
    // session, mints a real token, and asks for the other tenant's workspace.
    await asTenantRaw(async (q) => {
      const crossTenant = mint({ sub: USER2, workspace_id: WS1 })
      await expect(q(`SELECT set_workspace_jwt($1)`, [crossTenant])).rejects.toThrow(/not a member/)
    })
  })

  it('an expired token, a future token and a token with no expiry are all refused', async () => {
    await asTenantRaw(async (q) => {
      const past = Math.floor(Date.now() / 1000) - 60
      const future = Math.floor(Date.now() / 1000) + 3600
      await expect(q(`SELECT set_workspace_jwt($1)`, [mint({ sub: USER1, workspace_id: WS1, exp: past })])).rejects.toThrow(/expired/)
      await expect(q(`SELECT set_workspace_jwt($1)`, [mint({ sub: USER1, workspace_id: WS1, nbf: future })])).rejects.toThrow(/not yet valid/)
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
      const head = b64({ alg: 'HS256', typ: 'JWT', kid: KID })
      const body = b64({ sub: USER1, workspace_id: WS1 })
      const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')
      await expect(q(`SELECT set_workspace_jwt($1)`, [`${head}.${body}.${sig}`])).rejects.toThrow(/no expiry/)
    })
  })

  it('a retired key stops working, so rotation is a row update and not a flag day', async () => {
    await db.exec(`INSERT INTO auth_signing_keys (kid, secret) VALUES ('k2','second-secret')`)
    const k2 = mint({ sub: USER1, workspace_id: WS1 }, { kid: 'k2', secret: 'second-secret' })
    await asTenantRaw(async (q) => {
      expect((await q(`SELECT set_workspace_jwt($1) AS ws`, [k2])).rows).toEqual([{ ws: WS1 }])
    })
    await db.exec(`UPDATE auth_signing_keys SET retired_at = now() WHERE kid = 'k2'`)
    await asTenantRaw(async (q) => {
      await expect(q(`SELECT set_workspace_jwt($1)`, [k2])).rejects.toThrow(/unknown or retired key/)
    })
    await db.exec(`DELETE FROM auth_signing_keys WHERE kid = 'k2'`)
  })

  it('the tenant role cannot read the signing secret it would need to forge one', async () => {
    await asTenantRaw(async (q) => {
      await expect(q(`SELECT secret FROM auth_signing_keys`)).rejects.toThrow(/permission denied/)
    })
  })

  it('the verified context also carries the account, and it is transaction-scoped', async () => {
    await asTenantRaw(async (q) => {
      await q(`SELECT set_workspace_jwt($1)`, [tokenFor(WS1)])
      expect((await q(`SELECT current_account_id() AS a`)).rows).toEqual([{ a: USER1 }])
    })
    // Outside any stamped transaction it resolves to NULL, like the workspace.
    expect((await db.query(`SELECT current_account_id() AS a`)).rows).toEqual([{ a: null }])
  })
})

describe('(C) role exclusivity is asserted at deploy time, not only in this suite', () => {
  it('passes on a clean database', async () => {
    await db.exec(`SELECT assert_role_exclusivity()`)
  })

  it('fails loudly when a login role is granted two authority groups', async () => {
    await db.exec(`CREATE ROLE deploy_oops LOGIN`)
    await db.exec(`GRANT app_rw TO deploy_oops`)
    await db.exec(`GRANT svc_onboard TO deploy_oops`)
    try {
      await expect(db.query(`SELECT assert_role_exclusivity()`)).rejects.toThrow(/role exclusivity violated: deploy_oops/)
    } finally {
      await db.exec(`REVOKE app_rw FROM deploy_oops`)
      await db.exec(`REVOKE svc_onboard FROM deploy_oops`)
      await db.exec(`DROP ROLE deploy_oops`)
    }
  })

  it('fails loudly when an application role can borrow the JWT verifier', async () => {
    await db.exec(`GRANT auth_verifier TO app_rw`)
    try {
      await expect(db.query(`SELECT assert_role_exclusivity()`)).rejects.toThrow(/may read the JWT signing secret/)
    } finally {
      await db.exec(`REVOKE auth_verifier FROM app_rw`)
    }
  })
})

describe('(B) the billing gate blocks before it creates', () => {
  const WS3 = '00000000-0000-4000-8000-000000000003'
  const DELTA = '00000000-0000-4000-8000-00000000000d'

  beforeAll(async () => {
    await db.exec(`SET ROLE svc_onboard`)
    await db.exec(`INSERT INTO workspaces (id, name) VALUES ('${WS3}','Unpaid Three')`)
    await db.exec(`INSERT INTO brands (id, name, category) VALUES ('${DELTA}','DeltaCRM','crm')`)
    await db.exec(`RESET ROLE`)
  })

  it('an unsubscribed workspace gets no entitlement, and no row is left behind', async () => {
    await as('svc_onboard', {}, async (q) => {
      const sql = `INSERT INTO workspace_brands (workspace_id, brand_id, relation) VALUES ('${WS3}','${DELTA}','own')`
      await expect(q(sql)).rejects.toThrow(/has no subscription/)
    })
    // The distinction from create-then-check-then-delete: there was never a row.
    expect((await db.query(`SELECT count(*)::int n FROM workspace_brands WHERE workspace_id='${WS3}'`)).rows).toEqual([{ n: 0 }])
  })

  it('a cancelled subscription and a lapsed period are both refused', async () => {
    await db.exec(`SET ROLE svc_onboard`)
    await db.exec(`INSERT INTO workspace_subscriptions (workspace_id, plan, status, brand_limit, current_period_end)
                   VALUES ('${WS3}','starter','cancelled',5,'2099-01-01')`)
    await db.exec(`RESET ROLE`)
    const sql = `INSERT INTO workspace_brands (workspace_id, brand_id, relation) VALUES ('${WS3}','${DELTA}','own')`
    await as('svc_onboard', {}, async (q) => {
      await expect(q(sql)).rejects.toThrow(/is cancelled/)
    })

    await db.exec(`SET ROLE svc_onboard`)
    await db.exec(`UPDATE workspace_subscriptions SET status='active', current_period_end='2020-01-01' WHERE workspace_id='${WS3}'`)
    await db.exec(`RESET ROLE`)
    await as('svc_onboard', {}, async (q) => {
      await expect(q(sql)).rejects.toThrow(/lapsed/)
    })
  })

  it('the plan brand limit holds, and the refusal names the numbers', async () => {
    // WS2 is on starter: brand_limit 2, already holding 1.
    await as('svc_onboard', {}, async (q) => {
      await q(`INSERT INTO workspace_brands (workspace_id, brand_id, relation) VALUES ('${WS2}','${COMP}','competitor')`) // 2/2, allowed
      const over = `INSERT INTO workspace_brands (workspace_id, brand_id, relation) VALUES ('${WS2}','${DELTA}','competitor')`
      await expect(q(over)).rejects.toThrow(/holds 2\/2 brands on plan starter/)
    })
  })

  it('an active, in-period subscription with room admits the entitlement', async () => {
    await db.exec(`SET ROLE svc_onboard`)
    await db.exec(`UPDATE workspace_subscriptions SET status='active', current_period_end='2099-01-01' WHERE workspace_id='${WS3}'`)
    await db.exec(`RESET ROLE`)
    await as('svc_onboard', {}, async (q) => {
      await q(`INSERT INTO workspace_brands (workspace_id, brand_id, relation) VALUES ('${WS3}','${DELTA}','own')`)
      expect((await q(`SELECT count(*)::int n FROM workspace_brands WHERE workspace_id='${WS3}'`)).rows).toEqual([{ n: 1 }])
    })
  })

  it('the tenant cannot buy its own entitlement by writing a subscription', async () => {
    await as('app_rw', { workspace: WS2 }, async (q) => {
      await expect(q(`UPDATE workspace_subscriptions SET brand_limit = 9999 WHERE workspace_id='${WS2}'`)).rejects.toThrow(/permission denied/)
      const buy = `INSERT INTO workspace_subscriptions (workspace_id, plan, status, brand_limit, current_period_end) VALUES ('${WS2}','scale','active',9999,'2099-01-01')`
      await expect(q(buy)).rejects.toThrow(/permission denied/)
      // It can read its own plan, and only its own.
      expect((await q(`SELECT plan FROM workspace_subscriptions`)).rows).toEqual([{ plan: 'starter' }])
    })
  })
})
