/**
 * The deploy gate, tested against the states it exists to refuse.
 *
 * Separate from rls.test.ts on purpose. That suite proves the POLICIES are
 * right on one correctly-built database. This one proves the CHECK is right on
 * a range of wrongly-built ones — role attributes, ad-hoc grants and object
 * kinds that no migration creates and that only appear at deploy time.
 *
 * Both earlier versions of check-deploy.sql passed a database that leaked:
 *
 *   1. It certified "the tenant cannot name a workspace" by testing EXECUTE on
 *      set_workspace(uuid), while any role could name any workspace with a bare
 *      SET LOCAL. It asserted a proxy for the property.
 *   2. It then asserted the right properties against a hardcoded list of three
 *      group roles, so a LOGIN role granted EXECUTE on set_workspace(), and a
 *      role with BYPASSRLS, both passed and read every tenant.
 *
 * Every test below builds a database that is unsafe in one specific way and
 * requires the gate to fail. When you add an assertion to check-deploy.sql, add
 * the unsafe database it catches here — an assertion with no failing case is
 * indistinguishable from one that does nothing.
 */

import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterEach, describe, expect, it } from 'vitest'

const migration = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8')
/** psql meta-commands are not SQL; PGlite runs the rest verbatim. */
const CHECK = readFileSync(new URL('../scripts/check-deploy.sql', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('\\'))
  .join('\n')

const WS1 = '00000000-0000-4000-8000-000000000001'
const USER1 = '00000000-0000-4000-8000-0000000000f1'
const SECRET = 'a-secret-long-enough-to-satisfy-the-constraint'

let open: PGlite[] = []
afterEach(async () => {
  await Promise.all(open.map((d) => d.close()))
  open = []
})

async function db(opts: { legacyKey?: 'short' | 'long'; skip0002?: boolean } = {}): Promise<PGlite> {
  const d = new PGlite({ extensions: { pgcrypto } })
  open.push(d)
  await d.exec(migration('0000_init.sql'))
  await d.exec(migration('0001_tenancy_identity.sql'))
  // PRODUCTION ORDER. A database that ran 0001 in service MUST hold a signing
  // key — without one nobody can log in, and check-deploy asserted exactly that.
  // The old suite inserted the key AFTER all three migrations, which is the one
  // ordering in which a migration that cannot be applied looks fine.
  if (opts.legacyKey) {
    const secret = opts.legacyKey === 'short' ? 'short-0001-secret' : 'a-long-enough-0001-era-secret-value'
    await d.exec(`INSERT INTO auth_signing_keys (kid, secret) VALUES ('k0','${secret}')`)
  }
  if (!opts.skip0002) await d.exec(migration('0002_tenancy_context.sql'))
  // PGlite's session user is a superuser LOGIN role, which the RLS-bypass
  // assertion correctly refuses. A harness artifact, not a production shape —
  // managed Postgres gives you a privileged non-superuser. Named in the
  // allowlist rather than switched off, so every test below that expects a
  // bypass refusal still gets one.
  await d.exec(`SET bliprank.rls_bypass_allowed = 'postgres'`)
  return d
}

/**
 * A correctly-built database: migrated, seeded, one live configured key.
 *
 * `postgres` is named in the RLS-bypass allowlist because PGlite's session user
 * is a superuser LOGIN role — a harness artifact, not a production shape.
 * Naming it rather than disabling the check is the point: every test below that
 * expects a bypass refusal still gets one.
 */
async function healthy(): Promise<PGlite> {
  const d = await db()
  await d.exec(`INSERT INTO auth_signing_keys (kid, secret, issuer, audience) VALUES ('k1','${SECRET}','iss','aud')`)
  await d.exec(`SET ROLE svc_onboard`)
  await d.exec(`INSERT INTO accounts (id,email) VALUES ('${USER1}','a@ws1.test')`)
  await d.exec(`INSERT INTO workspaces (id,name) VALUES ('${WS1}','Agency One')`)
  await d.exec(`INSERT INTO workspace_members (workspace_id,account_id,role) VALUES ('${WS1}','${USER1}','owner')`)
  await d.exec(`RESET ROLE`)
  return d
}

const check = (d: PGlite) => d.exec(CHECK)

describe('the migration must apply to the database production actually has', () => {
  it('THE FINDING: 0002 applies to a database that ran 0001 in service, with a key already in it', async () => {
    // The first draft added NOT NULL DEFAULT 'unset' columns plus validating
    // CHECKs. The existing key backfilled to 'unset', the CHECK rejected it, and
    // the whole migration rolled back — leaving the GUC BLOCKER live.
    await expect(db({ legacyKey: 'long' })).resolves.toBeDefined()
    await expect(db({ legacyKey: 'short' })).resolves.toBeDefined()
  })

  it('a carried-over key is inert rather than dangerous, and the deploy says so', async () => {
    const d = await db({ legacyKey: 'long' })
    // It survives the migration (grandfathered), but it has no issuer/audience,
    // so it can never verify a token, and the gate refuses the deploy.
    expect((await d.query(`SELECT issuer, audience FROM auth_signing_keys WHERE kid='k0'`)).rows).toEqual([{ issuer: null, audience: null }])
    await expect(check(d)).rejects.toThrow(/no live, fully configured row in auth_signing_keys/)
  })

  it('a new key must be fully configured — the constraint binds what is written from here on', async () => {
    const d = await db({ legacyKey: 'long' })
    await expect(d.query(`INSERT INTO auth_signing_keys (kid, secret) VALUES ('k2','${SECRET}')`)).rejects.toThrow(
      /auth_signing_keys_live_is_configured/,
    )
    await expect(d.query(`INSERT INTO auth_signing_keys (kid, secret, issuer, audience) VALUES ('k2','tooshort','iss','aud')`)).rejects.toThrow(
      /auth_signing_keys_live_is_configured/,
    )
  })
})

describe('check-deploy refuses the databases it exists to refuse', () => {
  it('passes on a correctly built one', async () => {
    await expect(check(await healthy())).resolves.toBeDefined()
  })

  it('THE FINDING: a login role with BYPASSRLS reads every tenant, and must fail the deploy', async () => {
    const d = await healthy()
    await d.exec(`CREATE ROLE web_prod LOGIN`)
    await d.exec(`GRANT app_rw TO web_prod`)
    await d.exec(`ALTER ROLE web_prod BYPASSRLS`)
    // Verified before the fix: this passed every assertion, and web_prod then
    // read every workspace with no token and current_workspace_id() = NULL.
    // BYPASSRLS matters more than SUPERUSER on managed Postgres, where you
    // cannot create a superuser but can set this attribute.
    await expect(check(d)).rejects.toThrow(/bypass RLS entirely/)
  })

  it('a superuser login role is fatal too, not a warning nobody reads', async () => {
    const d = await healthy()
    await d.exec(`CREATE ROLE ops LOGIN SUPERUSER`)
    await expect(check(d)).rejects.toThrow(/ops\(SUPERUSER\)/)
  })

  it('the refusal is overridden per role, not by a switch that opens the door for everyone', async () => {
    const d = await healthy()
    await d.exec(`CREATE ROLE breakglass LOGIN BYPASSRLS`)
    await expect(check(d)).rejects.toThrow(/breakglass\(BYPASSRLS\)/)

    await d.exec(`SET bliprank.rls_bypass_allowed = 'postgres, breakglass'`)
    await expect(check(d)).resolves.toBeDefined()

    // The next role to be quietly granted the attribute is still refused. A
    // boolean switch would have accepted it, which is why this is a list.
    await d.exec(`CREATE ROLE sneaky LOGIN BYPASSRLS`)
    await expect(check(d)).rejects.toThrow(/sneaky\(BYPASSRLS\)/)
  })

  it('THE FINDING: a LOGIN role granted the context writers passed a check that only looked at groups', async () => {
    for (const grant of ['set_workspace(uuid)', 'stamp_tenant_context(uuid,uuid)']) {
      const d = await healthy()
      await d.exec(`CREATE ROLE web_prod LOGIN`)
      await d.exec(`GRANT app_rw TO web_prod`)
      await d.exec(`GRANT EXECUTE ON FUNCTION ${grant} TO web_prod`)
      // Both are SECURITY DEFINER owned by auth_verifier, so the grant IS the
      // authorization: web_prod could name any workspace and read it.
      await expect(check(d)).rejects.toThrow(/reachable outside auth_verifier/)
    }
  })

  it('PUBLIC granted a context writer is caught as well', async () => {
    const d = await healthy()
    await d.exec(`GRANT EXECUTE ON FUNCTION set_workspace(uuid) TO PUBLIC`)
    await expect(check(d)).rejects.toThrow(/reachable outside auth_verifier/)
  })

  it('any grant on the signing key or the context table is caught, including column-level', async () => {
    const d1 = await healthy()
    await d1.exec(`GRANT SELECT ON auth_signing_keys TO app_rw`)
    await expect(check(d1)).rejects.toThrow(/can read the signing secret/)

    const d2 = await healthy()
    // has_table_privilege is FALSE for a column-only grant; has_any_column_privilege is not.
    await d2.exec(`GRANT SELECT (secret) ON auth_signing_keys TO app_rw`)
    await expect(check(d2)).rejects.toThrow(/can read the signing secret/)

    const d3 = await healthy()
    await d3.exec(`GRANT INSERT ON auth_tenant_context TO app_rw`)
    await expect(check(d3)).rejects.toThrow(/grant on auth_tenant_context/)
  })

  it('an over-broad policy on an auth table is caught even without a grant', async () => {
    const d = await healthy()
    await d.exec(`CREATE POLICY oops ON auth_signing_keys FOR SELECT USING (true)`)
    await expect(check(d)).rejects.toThrow(/open an auth table beyond auth_verifier/)
  })

  it('THE FINDING: a new tenant-readable table with an unscoped policy must fail the deploy', async () => {
    const d = await healthy()
    // The shape a P4 reconciliation import would plausibly take, with the
    // mistake a hurried migration would plausibly make. The test-suite sweep
    // caught this; the deploy gate did not, which is the wrong way round.
    await d.exec(`CREATE TABLE recon_imports (id serial primary key, workspace_id uuid NOT NULL, payload jsonb)`)
    await d.exec(`ALTER TABLE recon_imports ENABLE ROW LEVEL SECURITY`)
    await d.exec(`ALTER TABLE recon_imports FORCE  ROW LEVEL SECURITY`)
    await d.exec(`GRANT SELECT ON recon_imports TO app_rw`)
    await d.exec(`CREATE POLICY recon_read ON recon_imports FOR SELECT USING (true)`)
    await expect(check(d)).rejects.toThrow(/without a tenant-scoped policy: recon_imports/)
  })

  it('a tenant-readable table with NO policy at all is caught too', async () => {
    const d = await healthy()
    await d.exec(`CREATE TABLE recon_imports (id serial primary key, workspace_id uuid NOT NULL)`)
    await d.exec(`ALTER TABLE recon_imports ENABLE ROW LEVEL SECURITY`)
    await d.exec(`ALTER TABLE recon_imports FORCE  ROW LEVEL SECURITY`)
    await d.exec(`GRANT SELECT ON recon_imports TO app_rw`)
    await expect(check(d)).rejects.toThrow(/without a tenant-scoped policy/)
  })

  it('a materialized view granted to an application role is caught — it cannot carry RLS at all', async () => {
    const d = await healthy()
    await d.exec(`CREATE MATERIALIZED VIEW score_mv AS SELECT * FROM score_rows`)
    await d.exec(`GRANT SELECT ON score_mv TO app_rw`)
    await expect(check(d)).rejects.toThrow(/materialized views cannot have RLS/)
  })

  it('a definer function that loses its pinned search_path is caught', async () => {
    const d = await healthy()
    await d.exec(`ALTER FUNCTION current_workspace_id() RESET search_path`)
    await expect(check(d)).rejects.toThrow(/pinned search_path: current_workspace_id/)
  })

  it('a context reader that stops being SECURITY DEFINER is caught', async () => {
    const d = await healthy()
    await d.exec(`ALTER FUNCTION current_account_id() SECURITY INVOKER`)
    await expect(check(d)).rejects.toThrow(/SECURITY DEFINER, owned by auth_verifier/)
  })

  it('a table that loses FORCE RLS is caught', async () => {
    const d = await healthy()
    await d.exec(`ALTER TABLE score_rows NO FORCE ROW LEVEL SECURITY`)
    await expect(check(d)).rejects.toThrow(/RLS is not forced on: score_rows/)
  })

  it('PUBLIC with CREATE on schema public is caught — it is what search_path pinning assumes', async () => {
    const d = await healthy()
    await d.exec(`GRANT CREATE ON SCHEMA public TO PUBLIC`)
    await expect(check(d)).rejects.toThrow(/PUBLIC has CREATE on schema public/)
  })
})

describe('the attacks hold for a real non-superuser LOGIN principal', () => {
  /**
   * rls.test.ts enters app_rw with `SET LOCAL ROLE` from a superuser session.
   * That is faithful for RLS specifically — I confirmed identical results — but
   * it structurally cannot test SET ROLE / SET SESSION AUTHORIZATION escapes,
   * because the session user is already a superuser. These use the shape
   * production has: a LOGIN role, not superuser, not BYPASSRLS, whose only
   * membership is app_rw.
   */
  async function withTenant(fn: (d: PGlite) => Promise<void>): Promise<void> {
    const d = await healthy()
    await d.exec(`CREATE ROLE web_prod LOGIN`)
    await d.exec(`GRANT app_rw TO web_prod`)
    expect((await d.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='web_prod'`)).rows).toEqual([
      { rolsuper: false, rolbypassrls: false },
    ])
    await d.exec(`SET SESSION AUTHORIZATION web_prod`)
    await fn(d)
    // No teardown: the instance is closed in afterEach, so a leaked session
    // authorization cannot reach another test.
  }

  it('bare GUCs establish nothing', async () => {
    await withTenant(async (d) => {
      await d.exec(`BEGIN`)
      await d.exec(`SET LOCAL app.workspace_id = '${WS1}'`)
      await d.exec(`SELECT set_config('app.workspace_at', transaction_timestamp()::text, true)`)
      await d.exec(`SELECT set_config('app.account_id', '${USER1}', true)`)
      expect((await d.query(`SELECT current_workspace_id() AS w`)).rows).toEqual([{ w: null }])
      expect((await d.query(`SELECT current_account_id() AS a`)).rows).toEqual([{ a: null }])
      for (const t of ['workspaces', 'workspace_members', 'accounts', 'brands', 'score_rows', 'workspace_subscriptions']) {
        expect([t, (await d.query(`SELECT count(*)::int n FROM ${t}`)).rows]).toEqual([t, [{ n: 0 }]])
      }
      await d.exec(`ROLLBACK`)
    })
  })

  it('cannot SET ROLE to the verifier or to a service role', async () => {
    await withTenant(async (d) => {
      // This is the assertion rls.test.ts deliberately does NOT make, because
      // there SET ROLE is checked against a superuser session user and would
      // pass for a reason production does not share.
      await expect(d.query(`SET ROLE auth_verifier`)).rejects.toThrow(/permission denied to set role/)
      await expect(d.query(`SET ROLE svc_onboard`)).rejects.toThrow(/permission denied to set role/)
      // `SET SESSION AUTHORIZATION postgres` is deliberately NOT asserted. It
      // succeeds here and would be denied in production, because the check is
      // against the ORIGINAL authenticated user — `postgres` on this harness,
      // `web_prod` on a real connection. Asserting it would fail for a reason
      // production does not share, which is the mirror image of the proxy
      // assertions that let the GUC bug through.
    })
  })

  it('cannot read the signing secret or write its own context', async () => {
    await withTenant(async (d) => {
      await expect(d.query(`SELECT secret FROM auth_signing_keys`)).rejects.toThrow(/permission denied/)
      await expect(d.query(`SELECT * FROM auth_tenant_context`)).rejects.toThrow(/permission denied/)
      await expect(d.query(`SELECT stamp_tenant_context('${WS1}','${USER1}')`)).rejects.toThrow(/permission denied/)
      await expect(d.query(`SELECT set_workspace('${WS1}')`)).rejects.toThrow(/permission denied/)
    })
  })
})
