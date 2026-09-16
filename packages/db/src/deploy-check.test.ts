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
 *
 * MERGED INTO THE mvp/stage-a LINEAGE ON 2026-09-15 (MVP_PLAN C0). These are
 * main's 78 cases for the exposure manifest, re-run against the merged gate:
 * the manifest is migration 0008 here (not 0003), every database is built from
 * the full migration list (`MIGRATIONS`, read from the directory), and the
 * gate also carries the lineage's own derivations (check-deploy.test.ts holds
 * their cases). Where a case's expectation moved, the comment at the case says
 * what the merged gate does instead and why. `check-deploy.test.ts` is the
 * older suite and is not superseded by this one; neither is a superset.
 */

import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS } from './testing.js'

const migration = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8')
/** psql meta-commands are not SQL; PGlite runs the rest verbatim. */
const RAW = readFileSync(new URL('../scripts/check-deploy.sql', import.meta.url), 'utf8')
const CHECK = RAW.split('\n')
  .filter((l) => !l.trimStart().startsWith('\\'))
  .join('\n')

/** One assertion of the gate on its own: the SQL between the `\echo` line that starts with `label` and the next `\echo`. */
function section(label: string): string {
  const lines = RAW.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`\\echo '${label}`))
  expect(start, `no gate section starts with "${label}"`).toBeGreaterThan(-1)
  const next = lines.findIndex((l, i) => i > start && l.startsWith('\\echo'))
  return lines.slice(start + 1, next === -1 ? lines.length : next).join('\n')
}
const MANIFEST = 'checking every reachable object is declared in the exposure manifest'

const WS1 = '00000000-0000-4000-8000-000000000001'
const USER1 = '00000000-0000-4000-8000-0000000000f1'
const SECRET = 'a-secret-long-enough-to-satisfy-the-constraint'

let open: PGlite[] = []
afterEach(async () => {
  await Promise.all(open.map((d) => d.close()))
  open = []
})

async function db(opts: { legacyKey?: 'short' | 'long' } = {}): Promise<PGlite> {
  const d = new PGlite({ extensions: { pgcrypto } })
  open.push(d)
  // Every migration on disk, in order: 0000..0007 of this lineage and 0008, the
  // manifest. PRODUCTION ORDER for the key: a database that ran 0001 in service
  // MUST hold a signing key — without one nobody can log in, and check-deploy
  // asserts exactly that. Inserting it AFTER the migrations is the one ordering
  // in which a migration that cannot be applied looks fine.
  for (const m of MIGRATIONS) {
    if (opts.legacyKey && m.startsWith('0002_')) {
      const secret = opts.legacyKey === 'short' ? 'short-0001-secret' : 'a-long-enough-0001-era-secret-value'
      await d.exec(`INSERT INTO auth_signing_keys (kid, secret) VALUES ('k0','${secret}')`)
    }
    await d.exec(migration(m))
  }
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
const only = (d: PGlite, label: string) => d.exec(section(label))

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
    await expect(check(d)).rejects.toThrow(/live signing key\(s\) are not fully configured/)
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
    for (const grant of ['set_workspace(uuid)', 'stamp_tenant_context(uuid,uuid,text)']) {
      const d = await healthy()
      await d.exec(`CREATE ROLE web_prod LOGIN`)
      await d.exec(`GRANT app_rw TO web_prod`)
      await d.exec(`GRANT EXECUTE ON FUNCTION ${grant} TO web_prod`)
      // Both are SECURITY DEFINER owned by auth_verifier, so the grant IS the
      // authorization: web_prod could name any workspace and read it.
      await expect(check(d)).rejects.toThrow(/definer-function-exposed/)
    }
  })

  it('PUBLIC granted a context writer is caught as well', async () => {
    const d = await healthy()
    await d.exec(`GRANT EXECUTE ON FUNCTION set_workspace(uuid) TO PUBLIC`)
    await expect(check(d)).rejects.toThrow(/definer-function-exposed/)
  })

  it('any grant on the signing key or the context table is caught, including column-level', async () => {
    const d1 = await healthy()
    await d1.exec(`GRANT SELECT ON auth_signing_keys TO app_rw`)
    await expect(check(d1)).rejects.toThrow(/undeclared-exposure[\s\S]*auth_signing_keys/)

    const d2 = await healthy()
    // has_table_privilege is FALSE for a column-only grant; has_any_column_privilege is not.
    await d2.exec(`GRANT SELECT (secret) ON auth_signing_keys TO app_rw`)
    await expect(check(d2)).rejects.toThrow(/undeclared-exposure[\s\S]*auth_signing_keys/)

    const d3 = await healthy()
    await d3.exec(`GRANT INSERT ON auth_tenant_context TO app_rw`)
    await expect(check(d3)).rejects.toThrow(/undeclared-exposure[\s\S]*auth_tenant_context/)
  })

  it('an over-broad policy on an auth table is caught even without a grant', async () => {
    const d = await healthy()
    await d.exec(`CREATE POLICY oops ON auth_signing_keys FOR SELECT USING (true)`)
    // A policy alone confers nothing without a grant; the grant is what makes
    // it reachable, and the manifest is what refuses it.
    await d.exec(`GRANT SELECT ON auth_signing_keys TO app_rw`)
    await expect(check(d)).rejects.toThrow(/undeclared-exposure/)
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
    await expect(check(d)).rejects.toThrow(/undeclared-exposure[\s\S]*recon_imports/)
  })

  it('a tenant-readable table with NO policy at all is caught too', async () => {
    const d = await healthy()
    await d.exec(`CREATE TABLE recon_imports (id serial primary key, workspace_id uuid NOT NULL)`)
    await d.exec(`ALTER TABLE recon_imports ENABLE ROW LEVEL SECURITY`)
    await d.exec(`ALTER TABLE recon_imports FORCE  ROW LEVEL SECURITY`)
    await d.exec(`GRANT SELECT ON recon_imports TO app_rw`)
    await expect(check(d)).rejects.toThrow(/undeclared-exposure[\s\S]*recon_imports/)
  })

  it('a materialized view granted to an application role is caught — it cannot carry RLS at all', async () => {
    const d = await healthy()
    await d.exec(`CREATE MATERIALIZED VIEW score_mv AS SELECT * FROM score_rows`)
    await d.exec(`GRANT SELECT ON score_mv TO app_rw`)
    await expect(check(d)).rejects.toThrow(/undeclared-exposure/)
  })

  it('a definer function that loses its pinned search_path is caught', async () => {
    const d = await healthy()
    await d.exec(`ALTER FUNCTION current_workspace_id() RESET search_path`)
    await expect(check(d)).rejects.toThrow(/definer-function-unsafe/)
  })

  it('a context reader that stops being SECURITY DEFINER is caught', async () => {
    const d = await healthy()
    await d.exec(`ALTER FUNCTION current_account_id() SECURITY INVOKER`)
    await expect(check(d)).rejects.toThrow(/must exist and be SECURITY DEFINER/)
  })

  it('a table that loses FORCE RLS is caught', async () => {
    const d = await healthy()
    await d.exec(`ALTER TABLE score_rows NO FORCE ROW LEVEL SECURITY`)
    await expect(check(d)).rejects.toThrow(/scoped-without-forced-rls/)
  })

  it('PUBLIC with CREATE on schema public is caught — it is what search_path pinning assumes', async () => {
    const d = await healthy()
    await d.exec(`GRANT CREATE ON SCHEMA public TO PUBLIC`)
    await expect(check(d)).rejects.toThrow(/schema-create-granted/)
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
      await expect(d.query(`SELECT stamp_tenant_context('${WS1}','${USER1}','owner')`)).rejects.toThrow(/permission denied/)
      await expect(d.query(`SELECT set_workspace('${WS1}')`)).rejects.toThrow(/permission denied/)
    })
  })
})

describe('audit 3 — every assertion names only the object it is about', () => {
  it('THE FINDING: a NOINHERIT login role in all three groups plus auth_verifier', async () => {
    const d = await healthy()
    await d.exec(`CREATE ROLE web_prod LOGIN NOINHERIT`)
    await d.exec(`GRANT app_rw TO web_prod`)
    await d.exec(`GRANT svc_onboard TO web_prod`)
    await d.exec(`GRANT auth_verifier TO web_prod`)
    // pg_has_role(..., 'USAGE') asks whether privileges are INHERITED and is
    // false for all three here; 'MEMBER' asks whether the role can SET ROLE to
    // them, which is the attack. Verified before the fix: this passed the whole
    // gate, then `SET ROLE auth_verifier` returned the plaintext secret.
    expect((await d.query(`SELECT pg_has_role('web_prod','auth_verifier','USAGE') AS usage,
                                  pg_has_role('web_prod','auth_verifier','MEMBER') AS member`)).rows).toEqual([
      { usage: false, member: true },
    ])
    // The exclusivity assertion fires first here (two authority groups); the
    // auth_verifier reach is asserted on its own below.
    await expect(check(d)).rejects.toThrow(/role exclusivity violated: web_prod/)

    const d2 = await healthy()
    await d2.exec(`CREATE ROLE only_verifier LOGIN NOINHERIT`)
    await d2.exec(`GRANT app_rw TO only_verifier`)
    await d2.exec(`GRANT auth_verifier TO only_verifier`)
    await expect(check(d2)).rejects.toThrow(/can reach auth_verifier/)
  })

  it('a NOINHERIT login role in two authority groups is caught', async () => {
    const d = await healthy()
    await d.exec(`CREATE ROLE web_prod LOGIN NOINHERIT`)
    await d.exec(`GRANT app_rw TO web_prod`)
    await d.exec(`GRANT svc_scorer TO web_prod`)
    await expect(check(d)).rejects.toThrow(/role exclusivity violated: web_prod/)
  })

  it('THE FINDING: BYPASSRLS on a NOLOGIN role, reached by SET ROLE', async () => {
    const d = await healthy()
    await d.exec(`CREATE ROLE reporting NOLOGIN BYPASSRLS`)
    await d.exec(`GRANT app_rw TO reporting`)
    // Not login-capable, so the old rolcanlogin scan never looked at it. RLS
    // bypass is evaluated against the CURRENT user after SET ROLE, not the
    // authenticated one. Verified: the gate passed and one SET ROLE read
    // every tenant's accounts, workspaces and subscriptions.
    await expect(check(d)).rejects.toThrow(/reporting\(BYPASSRLS\)/)
  })

  it('BYPASSRLS on an authority group itself is caught', async () => {
    const d = await healthy()
    // The blunt variant, needing no extra role: the plausible reaction to
    // "RLS is blocking my job".
    await d.exec(`ALTER ROLE app_rw BYPASSRLS`)
    await expect(check(d)).rejects.toThrow(/app_rw\(BYPASSRLS\)/)
  })

  it('the authority groups must not reach each other', async () => {
    const d = await healthy()
    // No login role exists here, so a login-only scan passes a database that is
    // already wrong and stays wrong for every role created later.
    await d.exec(`GRANT svc_onboard TO app_rw`)
    // Caught by the first exclusivity scan now that it no longer filters on
    // rolcanlogin: app_rw itself reaches two authority groups.
    await expect(check(d)).rejects.toThrow(/role exclusivity violated: app_rw/)
  })

  it('THE FINDING: a new SECURITY DEFINER helper granted to an application role', async () => {
    const d = await healthy()
    await d.exec(`CREATE FUNCTION auth_key_status() RETURNS TABLE(kid text, secret text)
                  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
                    SELECT k.kid, k.secret FROM auth_signing_keys k WHERE k.retired_at IS NULL $fn$`)
    await d.exec(`ALTER FUNCTION auth_key_status() OWNER TO auth_verifier`)
    await d.exec(`GRANT EXECUTE ON FUNCTION auth_key_status() TO app_rw`)
    // Six lines, returned the plaintext secret to an app_rw-only login role,
    // which then forged a token for another tenant and entered through the
    // front door with every downstream control behaving correctly.
    await expect(check(d)).rejects.toThrow(/definer-function-exposed/)
  })

  it('a definer function owned by the migration owner rather than auth_verifier is caught', async () => {
    const d = await healthy()
    await d.exec(`CREATE FUNCTION dashboard_rollup() RETURNS TABLE(brand_id uuid, mentions int)
                  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
                    SELECT s.brand_id, s.mentions FROM score_rows s $fn$`)
    await expect(check(d)).rejects.toThrow(/definer-function-unsafe/)
  })

  it('a definer function without a pinned search_path is caught', async () => {
    const d = await healthy()
    await d.exec(`CREATE FUNCTION helper() RETURNS int LANGUAGE sql SECURITY DEFINER AS $fn$ SELECT 1 $fn$`)
    await d.exec(`ALTER FUNCTION helper() OWNER TO auth_verifier`)
    await expect(check(d)).rejects.toThrow(/definer-function-unsafe/)
  })

  it('THE FINDING: a plain VIEW over the signing keys, granted to a tenant principal', async () => {
    const d = await healthy()
    await d.exec(`CREATE VIEW key_health AS SELECT kid, secret, issuer, audience FROM auth_signing_keys`)
    await d.exec(`GRANT SELECT ON key_health TO app_rw`)
    // Every sweep filtered relkind IN ('r','p') or = 'm'. A view confers no
    // privilege on the base table, so the "can read the signing secret" check
    // was true and useless. Whether it leaks depends on the view owner's RLS
    // posture — on Supabase the migration owner carries BYPASSRLS — and the
    // gate could not tell you either way, which is itself the problem.
    await expect(check(d)).rejects.toThrow(/undeclared-exposure/)
  })

  it('a security_invoker view still has to be declared', async () => {
    const d = await healthy()
    await d.exec(`CREATE VIEW my_scores WITH (security_invoker = true) AS SELECT * FROM score_rows`)
    await d.exec(`GRANT SELECT ON my_scores TO app_rw`)
    // Still refused: reachable and undeclared. security_invoker makes a view
    // safe to DECLARE, not exempt from declaring — the manifest is the record
    // of what a tenant may reach, and a view is a thing a tenant reaches.
    await expect(check(d)).rejects.toThrow(/undeclared-exposure/)
  })

  it('THE FINDING: a grant made to the LOGIN role rather than to app_rw', async () => {
    const d = await healthy()
    await d.exec(`CREATE ROLE web_prod LOGIN`)
    await d.exec(`GRANT app_rw TO web_prod`)
    await d.exec(`CREATE TABLE recon_imports (id serial primary key, workspace_id uuid NOT NULL REFERENCES workspaces(id), payload jsonb)`)
    await d.exec(`ALTER TABLE recon_imports ENABLE ROW LEVEL SECURITY`)
    await d.exec(`ALTER TABLE recon_imports FORCE  ROW LEVEL SECURITY`)
    await d.exec(`GRANT SELECT ON recon_imports TO web_prod`) // not to app_rw
    await d.exec(`CREATE POLICY recon_read ON recon_imports FOR SELECT USING (true)`)
    // The replacement for a hardcoded list of three group roles was a hardcoded
    // list of one. Deploy-time grants land on login roles as often as groups.
    await expect(check(d)).rejects.toThrow(/undeclared-exposure[\s\S]*recon_imports/)
  })

  it('THE FINDING: a write policy with WITH CHECK (true) lets a WS1 session write into WS2', async () => {
    const d = await healthy()
    await d.exec(`CREATE TABLE recon_imports (id serial primary key, workspace_id uuid NOT NULL REFERENCES workspaces(id), payload jsonb)`)
    await d.exec(`ALTER TABLE recon_imports ENABLE ROW LEVEL SECURITY`)
    await d.exec(`ALTER TABLE recon_imports FORCE  ROW LEVEL SECURITY`)
    await d.exec(`GRANT SELECT, INSERT ON recon_imports TO app_rw`)
    await d.exec(`CREATE POLICY recon_read  ON recon_imports FOR SELECT USING (workspace_id = current_workspace_id())`)
    await d.exec(`CREATE POLICY recon_write ON recon_imports FOR INSERT WITH CHECK (true)`)
    // The sweep read only `qual` on SELECT/ALL policies, so `with_check` was
    // never examined. A legitimately authenticated WS1 session inserted a row
    // into WS2 — invisible to the writer, read by the victim as its own
    // reconciliation data. On a product whose claim is that its numbers
    // reconcile, that is corruption of record, not merely a leak.
    await expect(check(d)).rejects.toThrow(/undeclared-exposure[\s\S]*recon_imports/)
  })

  it('THE FINDING: prompt_banks stops being shared the moment it gains a workspace column', async () => {
    const d = await healthy()
    // The FK test alone was evaded by exactly the mistake its own comment
    // named: a workspace column with no REFERENCES clause.
    await d.exec(`ALTER TABLE prompt_banks ADD COLUMN workspace_id uuid`)
    // 0000 says private banks go in a separate table. Nothing enforced it, and
    // prompt_banks is the one tenant-readable table that returns rows with no
    // context at all — so a private bank added here would be world-readable.
    await expect(check(d)).rejects.toThrow(/shared-columns-changed/)
  })

  it('a live key that is not fully configured is caught even when a good one exists', async () => {
    const d = await healthy()
    await d.exec(`ALTER TABLE auth_signing_keys DROP CONSTRAINT auth_signing_keys_live_is_configured`)
    await d.exec(`INSERT INTO auth_signing_keys (kid,secret,issuer,audience) VALUES ('weak','a','iss','aud')`)
    // The assertion was EXISTS(good key) where the property is NOT EXISTS(bad
    // key): a one-character secret sat alongside a good one and verified tokens.
    await expect(check(d)).rejects.toThrow(/constraint has been dropped/)
  })

  it('an unbounded token lifetime is caught', async () => {
    const d = await healthy()
    await d.exec(`ALTER TABLE auth_signing_keys DROP CONSTRAINT auth_signing_keys_lifetime_sane`)
    await d.exec(`UPDATE auth_signing_keys SET max_lifetime_s = 2147483647`)
    await d.exec(`ALTER TABLE auth_signing_keys ADD CONSTRAINT auth_signing_keys_lifetime_sane CHECK (max_lifetime_s BETWEEN 60 AND 604800) NOT VALID`)
    // 12 hours silently becomes 68 years. Not tenant-reachable, but a control
    // that nothing verifies is not a control.
    await expect(check(d)).rejects.toThrow(/live signing key\(s\) are not fully configured/)
  })

  it('the bare-GUC regression assertion actually bites', async () => {
    const d = await healthy()
    // Flagged as having no failing case: by this file's own rule that makes it
    // decoration, and it is the regression test for the original BLOCKER.
    // Restore the pre-0002 reader and require the gate to notice.
    await d.exec(`CREATE OR REPLACE FUNCTION current_workspace_id() RETURNS uuid
                  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
                    SELECT CASE
                      WHEN current_setting('app.workspace_at', true) = transaction_timestamp()::text
                      THEN NULLIF(current_setting('app.workspace_id', true), '')::uuid
                      ELSE NULL END $fn$`)
    await expect(check(d)).rejects.toThrow(/honoured a GUC/)
  })

  it('the pgcrypto assertion actually bites', async () => {
    const d = await healthy()
    await d.exec(`DROP EXTENSION pgcrypto CASCADE`)
    // On Supabase pgcrypto conventionally lives in `extensions`, where
    // CREATE EXTENSION IF NOT EXISTS is a silent no-op and set_workspace_jwt()
    // would fail to resolve hmac()/digest() at call time.
    await expect(check(d)).rejects.toThrow(/pgcrypto is not resolvable/)
  })
})

describe('audit 5 — every assertion has a failing case, including the ones that did not', () => {
  // The correlation the audit named: the ONE assertion with no test was the one
  // that did not work. These close that.

  it('THE FINDING: a mixed role list does not exempt a policy from scoping', async () => {
    for (const roles of ['app_rw, svc_scorer', 'app_rw, auth_verifier', 'svc_scorer, app_rw', 'app_rw']) {
      const d = await healthy()
      await d.exec(`CREATE POLICY p ON score_rows FOR SELECT TO ${roles} USING (true)`)
      // RLS ORs permissive policies, so naming a service role alongside app_rw
      // changes nothing about what app_rw can read. The old predicate asked
      // whether ANY named role was trusted; the property is whether EVERY one is.
      await expect(check(d)).rejects.toThrow(/scoped-policy-unbounded/)
    }
  })

  it('a policy naming ONLY trusted roles is correctly exempt', async () => {
    const d = await healthy()
    await d.exec(`CREATE POLICY p ON score_rows FOR SELECT TO svc_scorer, svc_onboard USING (true)`)
    await expect(check(d)).resolves.toBeDefined()
  })

  it('a service-declared privilege does not authorise it for a tenant', async () => {
    const d = await healthy()
    // score_rows INSERT is declared `service`. The manifest match used to ignore
    // the grantee, so this passed and RLS was the only thing left.
    await d.exec(`GRANT INSERT ON score_rows TO app_rw`)
    await expect(check(d)).rejects.toThrow(/undeclared-exposure[\s\S]*score_rows INSERT/)
  })

  it('THE FINDING (C0 audit): a service-declared privilege does not authorise it for the OTHER service role either', async () => {
    // The row for workspace_documents INSERT names svc_onboard. Matching any of
    // the three trusted roles let this grant pass, and with a FOR ALL policy to
    // match, svc_scorer inserted a forged category record into another
    // workspace, which that workspace's own verified session then read as its
    // own (measured in the worktree, 2026-09-15). The grantee column closes it.
    const d = await healthy()
    await d.exec(`GRANT INSERT ON workspace_documents TO svc_scorer`)
    await d.exec(`CREATE POLICY scorer_all_documents ON workspace_documents FOR ALL TO svc_scorer USING (true) WITH CHECK (true)`)
    await expect(check(d)).rejects.toThrow(/undeclared-exposure\] public\.workspace_documents INSERT is reachable by svc_scorer/)

    // And main's own rows, the same way round: the corpus is the scorer's to append, not onboarding's.
    const d2 = await healthy()
    await d2.exec(`GRANT INSERT ON score_aggregates TO svc_onboard`)
    await expect(check(d2)).rejects.toThrow(/undeclared-exposure\] public\.score_aggregates INSERT is reachable by svc_onboard/)
  })

  it('a definer owned by the scorer is refused, whichever list it is on (C0 audit)', async () => {
    const d = await healthy()
    // On the twelve-name list, so `definer-function-exposed` cannot be what
    // catches it: only the owner rule can, and it names auth_verifier and
    // svc_onboard, never svc_scorer.
    await d.exec(`ALTER FUNCTION ws_put_cycle(text,date,text,text,jsonb) OWNER TO svc_scorer`)
    await expect(check(d)).rejects.toThrow(/definer-function-unsafe\] ws_put_cycle\(text,date,text,text,jsonb\) \(owner svc_scorer/)
  })

  it('a tenant-facing write policy on shared reference data is refused', async () => {
    const d = await healthy()
    await d.exec(`GRANT INSERT, UPDATE ON prompt_banks TO app_rw`)
    await d.exec(`CREATE POLICY banks_editable ON prompt_banks FOR ALL USING (true) WITH CHECK (true)`)
    // Cross-tenant corruption of the shared benchmark corpus by a legitimately
    // authenticated tenant — not a leak, but worse for a product whose claim is
    // that its numbers reconcile.
    await expect(check(d)).rejects.toThrow(/shared-relation-writable|undeclared-exposure/)
  })

  it('THE FINDING: the shared column list is declared, not guessed from names', async () => {
    // Every one of these passed a five-word case-sensitive regex. `brand_id` is
    // the sharpest: in this schema brand identity IS tenant identity.
    for (const col of ['"WorkspaceId" uuid', 'org_id uuid', 'brand_id uuid', 'agency uuid', 'owner_id uuid', 'wsid uuid']) {
      const d = await healthy()
      await d.exec(`ALTER TABLE prompt_banks ADD COLUMN ${col}`)
      await expect(check(d)).rejects.toThrow(/shared-columns-changed/)
    }
  })

  it('THE FINDING: a routine partition provision does not break the gate', async () => {
    const d = await healthy()
    await d.exec(`SELECT ensure_score_partition('2026-10-01')`)
    // Seeding partitions once at migration time meant a correct maintenance job
    // failed the deploy on the 1st of every month. A gate that fails routinely
    // gets `|| true` in the pipeline, and then a real fault ships behind it.
    await expect(check(d)).resolves.toBeDefined()
  })

  it('a dropped partition leaves nothing stale, and a dropped declared table does', async () => {
    const d = await healthy()
    await d.exec(`DROP TABLE score_rows_2026_09`)
    await expect(check(d)).resolves.toBeDefined() // resolved through pg_inherits, not enumerated

    const d2 = await healthy()
    await d2.exec(`DROP TABLE workspace_subscriptions CASCADE`)
    await expect(check(d2)).rejects.toThrow(/stale-manifest-row/)
  })

  it('THE FINDING: predefined-role membership is not invisible', async () => {
    for (const grp of ['pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files']) {
      const d = await healthy()
      await d.exec(`CREATE ROLE web_prod LOGIN`)
      await d.exec(`GRANT app_rw TO web_prod`)
      await d.exec(`GRANT ${grp} TO web_prod`)
      // These confer power that never appears in a table ACL, so no amount of
      // privilege derivation can see them. pg_execute_server_program is
      // arbitrary command execution as the database OS user.
      await expect(check(d)).rejects.toThrow(/server-level powers/)
    }
  })

  it('TRUNCATE is refused for any untrusted role, declared or not', async () => {
    const d = await healthy()
    await d.exec(`GRANT TRUNCATE ON score_rows TO app_rw`)
    await expect(check(d)).rejects.toThrow(/truncate-granted/)
  })

  it('a sequence readable by a tenant is refused — it leaks volume across tenants', async () => {
    const d = await healthy()
    await d.exec(`CREATE SEQUENCE recon_seq`)
    await d.exec(`GRANT USAGE ON SEQUENCE recon_seq TO app_rw`)
    await expect(check(d)).rejects.toThrow(/sequence public\.recon_seq/)
  })

  it('a database with no live signing key is refused', async () => {
    const d = await healthy()
    await d.exec(`UPDATE auth_signing_keys SET retired_at = now() - interval '1 day'`)
    await expect(check(d)).rejects.toThrow(/no live row in auth_signing_keys/)
  })

  it('the gate functions are not readable by a tenant — they are a targeting list', async () => {
    const d = await healthy()
    await d.exec(`CREATE ROLE web_prod LOGIN`)
    await d.exec(`GRANT app_rw TO web_prod`)
    await d.exec(`SET SESSION AUTHORIZATION web_prod`)
    // tenancy_exposure_faults() returns a ranked list of exactly which relations
    // are reachable-and-unreviewed, plus definer signatures in schemas the caller
    // cannot enter. No tenant data — but a map of where to attack.
    for (const fn of ['tenancy_exposure_faults()', 'auth_key_health()', 'assert_role_exclusivity()']) {
      await expect(d.query(`SELECT * FROM ${fn}`)).rejects.toThrow(/permission denied/)
    }
    // No teardown needed: the instance is closed in afterEach.
  })

  it('the gate runs as a deploy principal that is neither superuser nor auth_verifier', async () => {
    const d = await healthy()
    await d.exec(`CREATE ROLE deployer NOLOGIN`)
    await d.exec(`GRANT deploy_check TO deployer`)
    await d.exec(`GRANT deployer TO postgres`)
    expect((await d.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='deployer'`)).rows).toEqual([
      { rolsuper: false, rolbypassrls: false },
    ])
    expect((await d.query(`SELECT pg_has_role('deployer','auth_verifier','MEMBER') AS m`)).rows).toEqual([{ m: false }])
    await d.exec(`SET ROLE deployer`)
    await expect(check(d)).resolves.toBeDefined()
    await d.exec(`RESET ROLE`)
  })
})

describe('audit 6 — the obligations follow the declaration down the tree', () => {
  // The audit observed, for the third time, that the mechanisms with only
  // PASSING tests were the broken ones. manifest_root(), the deploy_check
  // exemption and assert_role_powers() each had cases asserting the gate
  // TOLERATES something and none asserting it REFUSES anything. All three were
  // broken. These are the missing halves.

  it('THE FINDING: a partition created without RLS is refused', async () => {
    const d = await healthy()
    await d.exec(`CREATE TABLE score_rows_2026_10 PARTITION OF score_rows FOR VALUES FROM ('2026-10-01') TO ('2026-11-01')`)
    await d.exec(`GRANT SELECT ON score_rows_2026_10 TO app_rw`)
    // Exactly what ensure_score_partition() does, minus the RLS. Verified before
    // the fix: gate passed, and a WS2 session read WS1's corpus straight out of
    // the partition while the parent correctly returned nothing.
    await expect(check(d)).rejects.toThrow(/scoped-without-forced-rls[\s\S]*score_rows_2026_10/)
  })

  it('an existing partition with RLS switched off is refused', async () => {
    const d = await healthy()
    await d.exec(`ALTER TABLE score_rows_2026_08 DISABLE ROW LEVEL SECURITY`)
    // "RLS is blocking my job", applied one level down from where the file
    // already anticipates it.
    await expect(check(d)).rejects.toThrow(/scoped-without-forced-rls[\s\S]*score_rows_2026_08/)
  })

  it('a table staged with LIKE ... INCLUDING ALL and then ATTACHed is refused', async () => {
    const d = await healthy()
    // INCLUDING ALL does not copy RLS. This is standard partition maintenance.
    await d.exec(`CREATE TABLE score_rows_import (LIKE score_rows INCLUDING ALL)`)
    await d.exec(`ALTER TABLE score_rows ATTACH PARTITION score_rows_import FOR VALUES FROM ('2026-11-01') TO ('2026-12-01')`)
    await d.exec(`GRANT SELECT ON score_rows_import TO app_rw`)
    await expect(check(d)).rejects.toThrow(/scoped-without-forced-rls[\s\S]*score_rows_import/)
  })

  it('a legacy INHERITS child of a scoped relation is refused', async () => {
    const d = await healthy()
    await d.exec(`CREATE TABLE recon_imports (payload jsonb) INHERITS (workspace_brands)`)
    await d.exec(`GRANT SELECT ON recon_imports TO app_rw`)
    // manifest_root() resolved it to workspace_brands, so it was never
    // undeclared — and nothing required it to carry RLS.
    await expect(check(d)).rejects.toThrow(/scoped-without-forced-rls[\s\S]*recon_imports/)
  })

  it('THE FINDING: a child of the shared relation is refused, even with a correct policy', async () => {
    const d = await healthy()
    await d.exec(`CREATE TABLE prompt_banks_private (workspace_id uuid NOT NULL) INHERITS (prompt_banks)`)
    await d.exec(`ALTER TABLE prompt_banks_private ENABLE ROW LEVEL SECURITY`)
    await d.exec(`ALTER TABLE prompt_banks_private FORCE  ROW LEVEL SECURITY`)
    await d.exec(`CREATE POLICY pbp ON prompt_banks_private FOR SELECT USING (workspace_id = current_workspace_id())`)
    await d.exec(`GRANT SELECT ON prompt_banks_private TO app_rw`)
    // This is a good-faith implementation of 0000's own instruction that private
    // banks go in a separate RLS'd table. Verified before the fix: reading the
    // CHILD returned [] — the child's policy works — and reading the PARENT
    // returned every tenant's private bank, because a parent applies the
    // parent's policy to its children's rows and the shared policy is
    // USING (true). No column-list comparison on the parent can see this.
    await expect(check(d)).rejects.toThrow(/shared-relation-has-descendant/)
  })

  it('multi-parent inheritance is refused rather than resolved arbitrarily', async () => {
    const d = await healthy()
    await d.exec(`CREATE TABLE mixed () INHERITS (workspace_brands, prompt_banks)`)
    // manifest_root() takes the first parent it finds, so which declaration
    // governs would be decided by heap order rather than by a rule.
    await expect(check(d)).rejects.toThrow(/multi-parent-inheritance/)
  })

  it('THE FINDING: deploy_check granted to an application role is refused', async () => {
    const d = await healthy()
    await d.exec(`GRANT deploy_check TO app_rw`)
    // A name that confers an exemption must itself be constrained. Verified
    // before the fix: this passed silently and handed every tenant the gate's
    // own fault list — a map of exactly where the database is unreviewed.
    await expect(check(d)).rejects.toThrow(/can reach auth_verifier or deploy_check/)
  })

  it('THE FINDING: a REPLICATION login role is refused', async () => {
    const d = await healthy()
    await d.exec(`CREATE ROLE web_prod LOGIN REPLICATION`)
    await d.exec(`GRANT app_rw TO web_prod`)
    // An ATTRIBUTE, like BYPASSRLS, whose omission was a BLOCKER in audit 3. A
    // replication connection streams the WAL, and RLS is not consulted on the
    // WAL. rds_replication and Supabase's replication grant make it the
    // realistic form on the hosting target.
    await expect(check(d)).rejects.toThrow(/REPLICATION and can stream/)
  })

  it('pg_maintain and pg_signal_backend are refused too', async () => {
    for (const grp of ['pg_maintain', 'pg_signal_backend']) {
      const d = await healthy()
      await d.exec(`CREATE ROLE web_prod LOGIN`)
      await d.exec(`GRANT app_rw TO web_prod`)
      await d.exec(`GRANT ${grp} TO web_prod`)
      await expect(check(d)).rejects.toThrow(/server-level powers/)
    }
  })

  it('a PUBLIC grant on a gate function reports the fault rather than killing the gate', async () => {
    const d = await healthy()
    await d.exec(`GRANT EXECUTE ON FUNCTION tenancy_exposure_faults() TO PUBLIC`)
    // has_table_privilege accepts the PUBLIC pseudo-role; pg_has_role raises on
    // it. Without the guard this died with `role "public" does not exist` —
    // fail-closed, but it misdiagnoses, and the obvious fix (dropping the
    // 'public' grantee row) would blind the whole scan to PUBLIC grants.
    await expect(check(d)).rejects.toThrow(/definer-function-exposed/)
  })

  it('a shared column changing TYPE is a change, not just its name', async () => {
    const d = await healthy()
    await d.exec(`ALTER TABLE prompt_banks ALTER COLUMN version TYPE text`)
    await expect(check(d)).rejects.toThrow(/shared-columns-changed/)
  })

  it('CREATE on a schema outside the manifest is refused', async () => {
    const d = await healthy()
    await d.exec(`CREATE SCHEMA recon`)
    await d.exec(`GRANT CREATE ON SCHEMA recon TO app_rw`)
    await expect(check(d)).rejects.toThrow(/schema-create-granted[\s\S]*recon/)
  })

  it('and a correctly provisioned partition still passes', async () => {
    const d = await healthy()
    await d.exec(`SELECT ensure_score_partition('2026-10-01')`)
    // The tolerance case is kept — a gate that fails on correct maintenance gets
    // `|| true`'d — but it is no longer the only case.
    await expect(check(d)).resolves.toBeDefined()
  })
})

describe('audit 7 — one key for declaration and obligation, and the owner is a principal', () => {
  it('THE FINDING: a same-named parent in another schema does not shed the obligation', async () => {
    for (const rel of ['accounts', 'workspace_brands', 'score_aggregates']) {
      const d = await healthy()
      await d.exec(`CREATE SCHEMA archive`)
      await d.exec(`CREATE TABLE archive.${rel} (LIKE public.${rel})`)
      await d.exec(`ALTER TABLE public.${rel} INHERIT archive.${rel}`)
      await d.exec(`ALTER TABLE public.${rel} DISABLE ROW LEVEL SECURITY`)
      // The declaration resolved on the CHILD's schema and the obligation on the
      // ROOT's, so `CREATE TABLE archive.x (LIKE public.x)` — a cold-storage or
      // schema-reorg move — passed the gate and returned every tenant's rows.
      await expect(check(d)).rejects.toThrow(new RegExp('scoped-without-forced-rls[^]*public[.]' + rel))
    }
  })

  it('THE FINDING: a scoped VIEW must be security_invoker', async () => {
    const d = await healthy()
    await d.exec(`CREATE VIEW my_scores AS SELECT brand_id, mentions FROM score_rows`)
    await d.exec(`GRANT SELECT ON my_scores TO app_rw`)
    await d.exec(`INSERT INTO tenancy_exposure_manifest VALUES ('public','my_scores','SELECT','scoped','dashboard read model')`)
    // A view has no policies, so the policy loop never saw one, and the RLS
    // obligation was filtered to relkind ('r','p'). A plain view runs with its
    // OWNER's rights, straight past the base table's RLS — and a dashboard read
    // model is the most likely next object in apps/web.
    await expect(check(d)).rejects.toThrow(/scoped-view-not-invoker/)
  })

  it('a scoped security_invoker view is accepted by the manifest, and still refused by the read inverse (recorded at C0)', async () => {
    const d = await healthy()
    await d.exec(`CREATE VIEW my_scores WITH (security_invoker = true) AS SELECT brand_id, mentions FROM score_rows`)
    await d.exec(`GRANT SELECT ON my_scores TO app_rw`)
    await d.exec(`INSERT INTO tenancy_exposure_manifest VALUES ('public','my_scores','SELECT','scoped','dashboard read model')`)
    // On main this database passed the whole gate. In this lineage the gate
    // also holds the read inverse (B3r item 3), which refuses any relation the
    // tenant can read that carries no scoping policy of its own — and a view
    // carries none. It does not yet know that an invoker view inherits its
    // base tables' policies; teaching it that is the tenancy owner's decision,
    // recorded at the merge (2026-09-15), not made here. Both verdicts are
    // pinned so the day the decision is made, this case says which way it went.
    await expect(only(d, MANIFEST)).resolves.toBeDefined()
    await expect(check(d)).rejects.toThrow(/public\.my_scores \(no read policy for the tenant role\)/)
  })

  it('a scoped matview or foreign table is refused outright — neither can carry a policy', async () => {
    const d = await healthy()
    await d.exec(`CREATE MATERIALIZED VIEW score_mv AS SELECT brand_id, mentions FROM score_rows`)
    await d.exec(`GRANT SELECT ON score_mv TO app_rw`)
    await d.exec(`INSERT INTO tenancy_exposure_manifest VALUES ('public','score_mv','SELECT','scoped','rollup')`)
    await expect(check(d)).rejects.toThrow(/scoped-kind-cannot-scope/)
  })

  it('THE FINDING: the gate passes with the tables owned by a NON-superuser', async () => {
    const d = await healthy()
    await d.exec(`CREATE ROLE migrator NOLOGIN`)
    await d.exec(`GRANT migrator TO postgres`)
    for (const t of ['accounts', 'workspaces', 'workspace_members', 'workspace_brands', 'workspace_subscriptions', 'brands', 'prompt_banks', 'score_rows', 'score_aggregates']) {
      await d.exec(`ALTER TABLE public.${t} OWNER TO migrator`)
    }
    // This is the posture 0001 says the design exists to survive, and the gate
    // had never been run against it: ownership confers every privilege
    // implicitly, the grantee sweep excluded only rolsuper, and reassigning
    // ownership produced 54 faults. The predictable remedy — exempt the owner by
    // name, or `|| true` — is what the file's own preamble warns against.
    await expect(check(d)).resolves.toBeDefined()
  })

  it('but an owner that can log in, or that a tenant can reach, is refused', async () => {
    const d1 = await healthy()
    await d1.exec(`CREATE ROLE migrator LOGIN`)
    await d1.exec(`GRANT migrator TO postgres`)
    await d1.exec(`ALTER TABLE public.accounts OWNER TO migrator`)
    await expect(check(d1)).rejects.toThrow(/owner-can-login/)

    const d2 = await healthy()
    await d2.exec(`CREATE ROLE migrator NOLOGIN`)
    await d2.exec(`GRANT migrator TO postgres`)
    await d2.exec(`ALTER TABLE public.accounts OWNER TO migrator`)
    await d2.exec(`GRANT migrator TO app_rw`)
    await expect(check(d2)).rejects.toThrow(/owner-reachable-by-tenant/)
  })

  it('THE FINDING: a shared relation may not reference a scoped one', async () => {
    const d = await healthy()
    await d.exec(`CREATE TABLE recon_imports (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), payload jsonb)`)
    await d.exec(`ALTER TABLE recon_imports ENABLE ROW LEVEL SECURITY`)
    await d.exec(`ALTER TABLE recon_imports FORCE  ROW LEVEL SECURITY`)
    await d.exec(`GRANT SELECT ON recon_imports TO app_rw`)
    await d.exec(`CREATE POLICY recon_read ON recon_imports FOR SELECT USING (true)`)
    await d.exec(`INSERT INTO tenancy_exposure_manifest VALUES ('public','recon_imports','SELECT','shared','competitor export cache',
                  ARRAY['id:uuid','payload:jsonb','workspace_id:uuid'])`)
    // `shared` was an unconstrained escape hatch: a workspace column sat in the
    // approved list and nothing objected. Naming the tenancy columns would be
    // the unbounded shape again, so this derives it from the manifest.
    await expect(check(d)).rejects.toThrow(/shared-references-scoped/)
  })

  it('a NOLOGIN role in two authority groups is refused, login or not', async () => {
    const d = await healthy()
    await d.exec(`CREATE ROLE reporting NOLOGIN NOINHERIT`)
    await d.exec(`GRANT app_rw TO reporting`)
    await d.exec(`GRANT svc_onboard TO reporting`)
    // rolcanlogin was still filtering both exclusivity scans. A NOLOGIN role in
    // two groups is a database that is already wrong, and it goes live the
    // moment any login role is granted it.
    await expect(check(d)).rejects.toThrow(/role exclusivity violated: reporting/)
  })

  it('a NOINHERIT role reaching auth_verifier is refused even without a login role', async () => {
    const d = await healthy()
    await d.exec(`CREATE ROLE reporting NOLOGIN NOINHERIT`)
    await d.exec(`GRANT app_rw TO reporting`)
    await d.exec(`GRANT auth_verifier TO reporting`)
    // NOINHERIT defeats has_table_privilege, so the reachability sweep cannot
    // see it; the exclusivity scan must, and it did not while it filtered on
    // rolcanlogin.
    await expect(check(d)).rejects.toThrow(/can reach auth_verifier or deploy_check/)
  })

  it('a tenant holding a temp table does not fail the deploy', async () => {
    const d = await healthy()
    await d.exec(`CREATE TEMP TABLE scratch (x int)`)
    await d.exec(`CREATE TEMP SEQUENCE scratch_seq`)
    // TEMP is granted to PUBLIC by default, so any tenant could break the deploy
    // at will — and a gate that fails at an attacker's convenience converges on
    // `|| true` in the pipeline, which is the outcome this file exists to avoid.
    await expect(check(d)).resolves.toBeDefined()
  })

  it('shared-relation-writable fires on its own, not only alongside another fault', async () => {
    const d = await healthy()
    // No grant — so `undeclared-exposure` cannot fire and satisfy the assertion
    // by the wrong branch. The policy alone is the fault.
    await d.exec(`CREATE POLICY banks_editable ON prompt_banks FOR UPDATE USING (true) WITH CHECK (true)`)
    await expect(check(d)).rejects.toThrow(/shared-relation-writable/)
  })

  it('a missing context function, and one owned by the wrong role, are both refused', async () => {
    const d1 = await healthy()
    await d1.exec(`DROP FUNCTION set_workspace(uuid)`)
    await expect(check(d1)).rejects.toThrow(/must exist and be SECURITY DEFINER/)

    const d2 = await healthy()
    await d2.exec(`ALTER FUNCTION current_workspace_id() OWNER TO postgres`)
    await expect(check(d2)).rejects.toThrow(/must exist and be SECURITY DEFINER|definer-function-unsafe/)
  })

  it('TRUNCATE held by PUBLIC is refused, not only by app_rw', async () => {
    const d = await healthy()
    await d.exec(`GRANT TRUNCATE ON score_rows TO PUBLIC`)
    await expect(check(d)).rejects.toThrow(/truncate-granted/)
  })
})
