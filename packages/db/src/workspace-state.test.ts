/**
 * Migration 0004 — the grader's per-domain state, scoped by workspace, written
 * only through definer functions that take the workspace from the verified
 * context. PGlite, synthetic rows. `pnpm test:rls`.
 *
 * Two tenants with real tokens; every write goes through the token path and
 * every read is what the policies allow. A caller with no context cannot
 * write at all, and a caller in one workspace cannot see or touch the other's.
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
const SECRET = 'a-secret-long-enough-to-satisfy-the-constraint'

let db: PGlite

function token(ws: string, sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const h = b64({ alg: 'HS256', typ: 'JWT', kid: 'k1' })
  const p = b64({ sub, workspace_id: ws, exp: Math.floor(Date.now() / 1000) + 300, iss: 'iss', aud: 'aud' })
  return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`
}

type Q = (sql: string, p?: unknown[]) => Promise<unknown[]>

/** One transaction as the tenant role in `ws`'s verified context; committed unless `fn` throws. */
async function inWorkspace<T>(ws: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
  await db.exec('BEGIN')
  try {
    await db.exec('SET LOCAL ROLE app_rw')
    if (ws) await db.query(`SELECT set_workspace_jwt($1)`, [token(ws, ws === WS1 ? U1 : U2)])
    const q: Q = async (sql, p) => {
      await db.exec('SAVEPOINT s')
      try {
        return (await db.query(sql, p)).rows
      } catch (e) {
        await db.exec('ROLLBACK TO SAVEPOINT s')
        throw e
      }
    }
    const out = await fn(q)
    await db.exec('COMMIT')
    return out
  } catch (e) {
    await db.exec('ROLLBACK')
    throw e
  } finally {
    await db.exec('RESET ROLE')
    await db.exec('DELETE FROM auth_tenant_context')
  }
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } })
  for (const m of MIGRATIONS) {
    await db.exec(migration(m))
  }
  await db.exec(`INSERT INTO auth_signing_keys (kid, secret, issuer, audience) VALUES ('k1','${SECRET}','iss','aud')`)
  await db.exec(`SET ROLE svc_onboard`)
  await db.exec(`
    INSERT INTO accounts (id,email) VALUES ('${U1}','a@one.test'), ('${U2}','b@two.test');
    INSERT INTO workspaces (id,name) VALUES ('${WS1}','One'), ('${WS2}','Two');
    INSERT INTO workspace_members (workspace_id,account_id,role) VALUES ('${WS1}','${U1}','owner'), ('${WS2}','${U2}','owner');
  `)
  await db.exec(`RESET ROLE`)
})

afterAll(async () => {
  await db.close()
})

const RESULT = { status: 'scanned', domain: 'acme.example', brands: [] }

describe('the workspace comes from the verified context, never from the caller', () => {
  it('with no context every writer refuses and nothing is written', async () => {
    await inWorkspace(null, async (q) => {
      await expect(q(`SELECT ws_put_cycle('acme.example', '2026-09-01', 'det-2', 'b', $1)`, [RESULT])).rejects.toThrow(/no verified tenant context/)
      await expect(q(`SELECT ws_put_document('category-record', 'acme.example', '{"slug":"crm"}')`)).rejects.toThrow(/no verified tenant context/)
      await expect(q(`SELECT ws_file_request('category', 'acme.example', '{"slug":"x"}', now())`)).rejects.toThrow(/no verified tenant context/)
      await expect(q(`SELECT ws_resolve_request('category', 'acme.example', now(), 'applied', 'op', null)`)).rejects.toThrow(/no verified tenant context/)
    })
    expect((await db.query(`SELECT count(*)::int AS n FROM workspace_cycles`)).rows).toEqual([{ n: 0 }])
    expect((await db.query(`SELECT count(*)::int AS n FROM workspace_documents`)).rows).toEqual([{ n: 0 }])
    expect((await db.query(`SELECT count(*)::int AS n FROM workspace_requests`)).rows).toEqual([{ n: 0 }])
  })

  it('the tenant role holds no direct write on any of the three tables', async () => {
    await inWorkspace(WS1, async (q) => {
      await expect(q(`INSERT INTO workspace_cycles (workspace_id, host, day, algo_version, comparison_basis, result) VALUES ('${WS1}','x.example','2026-09-01','det-2','b','{}')`)).rejects.toThrow(/permission denied/)
      await expect(q(`INSERT INTO workspace_documents (workspace_id, kind, host, version, body) VALUES ('${WS1}','category-record','x.example',1,'{}')`)).rejects.toThrow(/permission denied/)
      await expect(q(`INSERT INTO workspace_requests (workspace_id, kind, host, body) VALUES ('${WS1}','category','x.example','{}')`)).rejects.toThrow(/permission denied/)
      await expect(q(`DELETE FROM workspace_requests`)).rejects.toThrow(/permission denied/)
    })
  })
})

describe('cycles: one row per (host, day, algo_version); same version re-writes, new version adds', () => {
  it('writes land in the caller\'s workspace and only that workspace reads them', async () => {
    await inWorkspace(WS1, async (q) => {
      await q(`SELECT ws_put_cycle('acme.example', '2026-09-01', 'det-2', 'basis-a', $1)`, [RESULT])
      await q(`SELECT ws_put_cycle('acme.example', '2026-09-02', 'det-2', 'basis-a', $1)`, [{ ...RESULT, day: 2 }])
    })
    const one = await inWorkspace(WS1, (q) => q(`SELECT host, day::text AS day, algo_version FROM workspace_cycles ORDER BY day`))
    expect(one).toEqual([
      { host: 'acme.example', day: '2026-09-01', algo_version: 'det-2' },
      { host: 'acme.example', day: '2026-09-02', algo_version: 'det-2' },
    ])
    expect(await inWorkspace(WS2, (q) => q(`SELECT host FROM workspace_cycles`))).toEqual([])
    expect((await db.query(`SELECT DISTINCT workspace_id FROM workspace_cycles`)).rows).toEqual([{ workspace_id: WS1 }])
  })

  it('a same-version re-write replaces the day; a new algo version is a new row beside it (R5)', async () => {
    await inWorkspace(WS1, async (q) => {
      await q(`SELECT ws_put_cycle('acme.example', '2026-09-01', 'det-2', 'basis-a', $1)`, [{ ...RESULT, rewritten: true }])
      await q(`SELECT ws_put_cycle('acme.example', '2026-09-01', 'det-3', 'basis-a', $1)`, [{ ...RESULT, rescored: true }])
    })
    const rows = await inWorkspace(WS1, (q) => q(`SELECT algo_version, result->>'rewritten' AS rw, result->>'rescored' AS rs FROM workspace_cycles WHERE day = '2026-09-01' ORDER BY algo_version`))
    expect(rows).toEqual([
      { algo_version: 'det-2', rw: 'true', rs: null },
      { algo_version: 'det-3', rw: null, rs: 'true' },
    ])
  })

  it('refuses a non-object result, an upper-case host, an over-long host and an empty version', async () => {
    await inWorkspace(WS1, async (q) => {
      await expect(q(`SELECT ws_put_cycle('acme.example', '2026-09-03', 'det-2', 'b', '[]')`)).rejects.toThrow(/must be an object/)
      await expect(q(`SELECT ws_put_cycle('Acme.example', '2026-09-03', 'det-2', 'b', $1)`, [RESULT])).rejects.toThrow(/names domain acme.example, filed under Acme.example/)
      await expect(q(`SELECT ws_put_cycle($1, '2026-09-03', 'det-2', 'b', $2)`, ['x'.repeat(254), { ...RESULT, domain: 'x'.repeat(254) }])).rejects.toThrow(/check constraint/)
      await expect(q(`SELECT ws_put_cycle('acme.example', '2026-09-03', '', 'b', $1)`, [RESULT])).rejects.toThrow(/check constraint/)
    })
  })

  it('keeps the file store\'s guards: only a scanned result, under its own domain and its own day (audit M3)', async () => {
    await inWorkspace(WS1, async (q) => {
      await expect(q(`SELECT ws_put_cycle('acme.example', '2026-09-03', 'det-2', 'b', $1)`, [{ ...RESULT, status: 'failed' }])).rejects.toThrow(/only a scanned cycle is filed, not failed/)
      await expect(q(`SELECT ws_put_cycle('acme.example', '2026-09-03', 'det-2', 'b', $1)`, [{ ...RESULT, domain: 'other.example' }])).rejects.toThrow(/names domain other.example/)
      await expect(q(`SELECT ws_put_cycle('acme.example', '2026-09-03', 'det-2', 'b', $1)`, [{ ...RESULT, run: { day: '2026-09-04' } }])).rejects.toThrow(/collected on 2026-09-04, filed under 2026-09-03/)
      // A result whose run block names the same day, and one with no run block, both file.
      await q(`SELECT ws_put_cycle('acme.example', '2026-09-03', 'det-2', 'b', $1)`, [{ ...RESULT, run: { day: '2026-09-03' } }])
      await q(`SELECT ws_put_cycle('acme.example', '2026-09-04', 'det-2', 'b', $1)`, [RESULT])
    })
    expect((await db.query(`SELECT count(*)::int AS n FROM workspace_cycles WHERE host = 'acme.example' AND day >= '2026-09-03'`)).rows).toEqual([{ n: 2 }])
  })

  it('a same-day, same-version write on ANOTHER basis is refused, not a re-write (audit M2, R5)', async () => {
    await inWorkspace(WS1, async (q) => {
      await expect(q(`SELECT ws_put_cycle('acme.example', '2026-09-03', 'det-2', 'set=2', $1)`, [RESULT])).rejects.toThrow(/already stored on another basis/)
    })
    const rows = await inWorkspace(WS1, (q) => q(`SELECT comparison_basis FROM workspace_cycles WHERE host = 'acme.example' AND day = '2026-09-03'`))
    expect(rows).toEqual([{ comparison_basis: 'b' }])
  })
})

describe('documents: version N+1 is the database\'s, history is rows, nothing is updated or deleted', () => {
  it('each put is the next version for that kind and host, per workspace', async () => {
    const v = await inWorkspace(WS1, async (q) => [
      await q(`SELECT ws_put_document('category-record', 'acme.example', '{"slug":"crm"}') AS v`),
      await q(`SELECT ws_put_document('category-record', 'acme.example', '{"slug":"erp"}') AS v`),
      await q(`SELECT ws_put_document('competitor-override', 'acme.example', '{"exclude":[]}') AS v`),
      await q(`SELECT ws_put_document('category-record', 'other.example', '{"slug":"crm"}') AS v`),
    ])
    expect(v.flat()).toEqual([{ v: 1 }, { v: 2 }, { v: 1 }, { v: 1 }])
    // The other workspace's numbering is its own.
    expect(await inWorkspace(WS2, (q) => q(`SELECT ws_put_document('category-record', 'acme.example', '{"slug":"crm"}') AS v`))).toEqual([{ v: 1 }])
    expect(await inWorkspace(WS2, (q) => q(`SELECT version, body->>'slug' AS slug FROM workspace_documents WHERE host = 'acme.example' AND kind = 'category-record' ORDER BY version`))).toEqual([{ version: 1, slug: 'crm' }])
    expect(await inWorkspace(WS1, (q) => q(`SELECT version, body->>'slug' AS slug FROM workspace_documents WHERE host = 'acme.example' AND kind = 'category-record' ORDER BY version`))).toEqual([
      { version: 1, slug: 'crm' },
      { version: 2, slug: 'erp' },
    ])
  })

  it('an unknown kind, a non-object body and a body over 64 KiB are refused', async () => {
    await inWorkspace(WS1, async (q) => {
      await expect(q(`SELECT ws_put_document('notes', 'acme.example', '{}')`)).rejects.toThrow(/check constraint/)
      await expect(q(`SELECT ws_put_document('custom-prompts', 'acme.example', '"text"')`)).rejects.toThrow(/must be an object/)
      await expect(q(`SELECT ws_put_document('custom-prompts', 'acme.example', $1)`, [{ big: 'x'.repeat(70_000) }])).rejects.toThrow(/check constraint/)
    })
  })

  it('document writes refuse REPEATABLE READ, where the lock cannot serialise the version (audit M4)', async () => {
    await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ')
    try {
      await db.exec('SET LOCAL ROLE app_rw')
      await db.query(`SELECT set_workspace_jwt($1)`, [token(WS1, U1)])
      await expect(db.query(`SELECT ws_put_document('category-record', 'rr.example', '{}')`)).rejects.toThrow(/not safe at REPEATABLE READ/)
    } finally {
      await db.exec('ROLLBACK')
      await db.exec('RESET ROLE')
      await db.exec('DELETE FROM auth_tenant_context')
    }
  })

  it('no role but the migration owner can update or delete a document row', async () => {
    const held = await db.query(`
      SELECT g.rolname, p.priv FROM pg_roles g
       CROSS JOIN unnest(ARRAY['UPDATE','DELETE','TRUNCATE']) AS p(priv)
       WHERE g.rolname IN ('app_rw','svc_scorer','svc_onboard','auth_verifier')
         AND has_table_privilege(g.rolname, 'workspace_documents', p.priv)`)
    expect(held.rows).toEqual([])
  })
})

describe('requests: one pending per host, filing replaces, resolving is optimistic', () => {
  const T1 = '2026-09-10T10:00:00Z'
  const T2 = '2026-09-10T11:00:00Z'

  it('filing twice leaves one pending row, the later one', async () => {
    await inWorkspace(WS1, async (q) => {
      await q(`SELECT ws_file_request('category', 'acme.example', '{"slug":"erp","reason":"first"}', $1)`, [T1])
      await q(`SELECT ws_file_request('category', 'acme.example', '{"slug":"hr","reason":"second"}', $1)`, [T2])
      // A different kind for the same host is its own queue.
      await q(`SELECT ws_file_request('competitors', 'acme.example', '{"exclude":["x"]}', $1)`, [T1])
    })
    const rows = await inWorkspace(WS1, (q) => q(`SELECT kind, status, body->>'reason' AS reason FROM workspace_requests WHERE host = 'acme.example' ORDER BY kind`))
    expect(rows).toEqual([
      { kind: 'category', status: 'pending', reason: 'second' },
      { kind: 'competitors', status: 'pending', reason: null },
    ])
  })

  it('resolving with a stale requested_at changes nothing; with the current one it resolves once', async () => {
    const stale = await inWorkspace(WS1, (q) => q(`SELECT ws_resolve_request('category', 'acme.example', $1, 'applied', 'operator', 'ok') AS r`, [T1]))
    expect(stale).toEqual([{ r: false }])
    const fresh = await inWorkspace(WS1, (q) => q(`SELECT ws_resolve_request('category', 'acme.example', $1, 'applied', 'operator', 'ok') AS r`, [T2]))
    expect(fresh).toEqual([{ r: true }])
    const again = await inWorkspace(WS1, (q) => q(`SELECT ws_resolve_request('category', 'acme.example', $1, 'declined', 'operator', null) AS r`, [T2]))
    expect(again).toEqual([{ r: false }])
    const rows = await inWorkspace(WS1, (q) => q(`SELECT status, resolved_by, note FROM workspace_requests WHERE host = 'acme.example' AND kind = 'category'`))
    expect(rows).toEqual([{ status: 'applied', resolved_by: 'operator', note: 'ok' }])
  })

  it('a resolution needs a status of applied or declined and a name', async () => {
    await inWorkspace(WS1, async (q) => {
      await expect(q(`SELECT ws_resolve_request('competitors', 'acme.example', $1, 'done', 'op', null)`, [T1])).rejects.toThrow(/applied or declined/)
      await expect(q(`SELECT ws_resolve_request('competitors', 'acme.example', $1, 'applied', '  ', null)`, [T1])).rejects.toThrow(/names who made it/)
    })
  })

  it('twenty resolved requests are kept per host; older ones go when a new one is filed (audit m6)', async () => {
    await inWorkspace(WS1, async (q) => {
      for (let i = 0; i < 25; i++) {
        const at = `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`
        await q(`SELECT ws_file_request('custom-prompts', 'many.example', '{}', $1)`, [at])
        await q(`SELECT ws_resolve_request('custom-prompts', 'many.example', $1, 'declined', 'op', null)`, [at])
      }
    })
    // Trimmed at each filing: twenty resolved kept, plus the one filed and resolved after the last trim.
    expect(await inWorkspace(WS1, (q) => q(`SELECT count(*)::int AS n FROM workspace_requests WHERE host = 'many.example'`))).toEqual([{ n: 21 }])
  })

  it('the other workspace sees none of it and cannot resolve it', async () => {
    expect(await inWorkspace(WS2, (q) => q(`SELECT count(*)::int AS n FROM workspace_requests`))).toEqual([{ n: 0 }])
    expect(await inWorkspace(WS2, (q) => q(`SELECT ws_resolve_request('competitors', 'acme.example', $1, 'applied', 'intruder', null) AS r`, [T1]))).toEqual([{ r: false }])
    expect(await inWorkspace(WS1, (q) => q(`SELECT status FROM workspace_requests WHERE kind = 'competitors'`))).toEqual([{ status: 'pending' }])
  })
})

describe('the migration leaves the model as it found it', () => {
  it('the four writers are definer-owned and executable by the tenant role only, ws_required by the writers only, and the owner is not left in svc_onboard', async () => {
    const rows = (await db.query(`
      SELECT p.proname, o.rolname AS owner, has_function_privilege('app_rw', p.oid, 'EXECUTE') AS app_rw, has_function_privilege('svc_scorer', p.oid, 'EXECUTE') AS scorer
        FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner WHERE p.proname LIKE 'ws\\_%' ORDER BY 1`)).rows
    expect(rows).toEqual([
      { proname: 'ws_file_request', owner: 'svc_onboard', app_rw: true, scorer: false },
      { proname: 'ws_put_cycle', owner: 'svc_onboard', app_rw: true, scorer: false },
      { proname: 'ws_put_document', owner: 'svc_onboard', app_rw: true, scorer: false },
      // the wrapper is the writers' to call, never the tenant's (B3r item 2)
      { proname: 'ws_required', owner: 'auth_verifier', app_rw: false, scorer: false },
      { proname: 'ws_resolve_request', owner: 'svc_onboard', app_rw: true, scorer: false },
    ])
    const r = await db.query(`SELECT count(*)::int AS n FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member WHERE g.rolname = 'svc_onboard' AND m.rolname = current_user`)
    expect(r.rows).toEqual([{ n: 0 }])
  })
})
