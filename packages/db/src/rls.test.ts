/**
 * RLS policy suite — CLAUDE.md rule R7: tenancy is verified mechanically.
 * PGlite (real Postgres in-process), synthetic rows only. `pnpm test:rls`.
 *
 * Covers the hardened model: authority in roles not GUCs, entitlement granted
 * not self-declared, FORCE RLS on every table incl. partitions, transaction-
 * stamped tenant context that fails closed on a leaked GUC.
 */

import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
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
    if (ctx.workspace) await db.query(`SELECT set_workspace($1)`, [ctx.workspace])
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
    await db.exec(`SELECT set_config('app.workspace_at', '', false)`)
  }
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(readFileSync(new URL('../migrations/0000_init.sql', import.meta.url), 'utf8'))
  // Seed as svc_onboard (identity + entitlements) and svc_scorer (corpus) — the roles that may write.
  await db.exec(`SET ROLE svc_onboard`)
  await db.exec(`
    INSERT INTO accounts (id, email) VALUES ('${USER1}','a@ws1.test'), ('${USER2}','b@ws2.test');
    INSERT INTO workspaces (id, name) VALUES ('${WS1}','Agency One'), ('${WS2}','Brand Two');
    INSERT INTO workspace_members (workspace_id, account_id, role) VALUES ('${WS1}','${USER1}','owner'), ('${WS2}','${USER2}','owner');
    INSERT INTO brands (id, name, category) VALUES ('${ACME}','AcmeCRM','crm'), ('${BRIT}','BritCRM','crm'), ('${COMP}','CompCRM','crm');
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

describe('every table in public forces RLS (the sweep that catches the next migration)', () => {
  it('no table has RLS unset', async () => {
    const r = await db.query(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`)
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
