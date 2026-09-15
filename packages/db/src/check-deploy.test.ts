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
 * THE RULE: every test below builds a database that is unsafe in one specific
 * way and requires the gate to fail. When you add an assertion to
 * check-deploy.sql, add the unsafe database it catches here — an assertion with
 * no failing case is indistinguishable from one that does nothing. That rule was
 * violated three times, and each time the untested assertion was the broken one.
 *
 * SCOPE. `check-deploy.sql` is deliberately PARTIAL — see ADR-0007. This file
 * covers only what it currently asserts. The exposure manifest,
 * `assert_role_powers()` and signing-key health are on `fix/tenancy-deploy-gate`
 * together with the 78 failing cases that exercise them; that work is required
 * before G1. Do not re-expand the gate here without bringing its cases.
 */

import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS } from './testing.js'

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

async function db(opts: { legacyKey?: 'short' | 'long' } = {}): Promise<PGlite> {
  const d = new PGlite({ extensions: { pgcrypto } })
  open.push(d)
  for (const m of MIGRATIONS) {
    // PRODUCTION ORDER. A database that ran 0001 in service MUST hold a signing
    // key — without one nobody can log in. Inserting the key AFTER the migrations
    // is the one ordering in which a migration that cannot be applied looks fine.
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

/** A correctly-built database: migrated, seeded, one live configured key. */
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
  it('0002 applies to a database that ran 0001 in service, with a key already in it', async () => {
    // The first draft added NOT NULL DEFAULT 'unset' columns plus validating
    // CHECKs. The existing key backfilled to 'unset', the CHECK rejected it, and
    // the whole migration rolled back — leaving the GUC BLOCKER live.
    await expect(db({ legacyKey: 'long' })).resolves.toBeDefined()
    await expect(db({ legacyKey: 'short' })).resolves.toBeDefined()
  })

  it('a carried-over key survives but can never verify a token', async () => {
    const d = await db({ legacyKey: 'long' })
    // Grandfathered by a NOT VALID constraint, so the migration applies — but it
    // has no issuer or audience, so set_workspace_jwt() refuses every token
    // signed with it. The gate assertion that reports this needs
    // auth_key_health() from 0003 (ADR-0007); until then it is inert, not safe.
    expect((await d.query(`SELECT issuer, audience FROM auth_signing_keys WHERE kid='k0'`)).rows).toEqual([
      { issuer: null, audience: null },
    ])
  })

  it('a new key must be fully configured — the constraint binds what is written from here on', async () => {
    const d = await db({ legacyKey: 'long' })
    await expect(d.query(`INSERT INTO auth_signing_keys (kid, secret) VALUES ('k2','${SECRET}')`)).rejects.toThrow(
      /auth_signing_keys_live_is_configured/,
    )
    await expect(
      d.query(`INSERT INTO auth_signing_keys (kid, secret, issuer, audience) VALUES ('k2','tooshort','iss','aud')`),
    ).rejects.toThrow(/auth_signing_keys_live_is_configured/)
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
    expect(
      (
        await d.query(`SELECT pg_has_role('web_prod','auth_verifier','USAGE') AS usage,
                              pg_has_role('web_prod','auth_verifier','MEMBER') AS member`)
      ).rows,
    ).toEqual([{ usage: false, member: true }])
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

  it('a NOLOGIN role in two authority groups is refused, login or not', async () => {
    const d = await healthy()
    // No login role exists here, so a login-only scan passes a database that is
    // already wrong and stays wrong for every role created later.
    await d.exec(`GRANT svc_onboard TO app_rw`)
    await expect(check(d)).rejects.toThrow(/role exclusivity violated: app_rw/)
  })

  it('app_rw re-granted the unverified setter is caught', async () => {
    const d = await healthy()
    // The assertion this exercises certified a proxy and is kept with a
    // correction, not deleted — revoking that EXECUTE is still correct, it just
    // never was what closed the hole.
    await d.exec(`GRANT EXECUTE ON FUNCTION set_workspace(uuid) TO app_rw`)
    await expect(check(d)).rejects.toThrow(/app_rw has EXECUTE on set_workspace/)
  })

  it('an undeclared SECURITY DEFINER function reachable by the tenant role is caught (2026-09-10 audit)', async () => {
    const d = await healthy()
    await d.exec(`CREATE FUNCTION peek_everything() RETURNS SETOF accounts LANGUAGE sql SECURITY DEFINER AS $$ SELECT * FROM accounts $$`)
    await d.exec(`GRANT EXECUTE ON FUNCTION peek_everything() TO app_rw`)
    await expect(check(d)).rejects.toThrow(/undeclared SECURITY DEFINER functions .*peek_everything\(\)/)
  })

  it('a migration owner left a member of a writing group is caught (2026-09-10 audit, m7)', async () => {
    const d = await healthy()
    await d.exec(`GRANT svc_onboard TO postgres`)
    await expect(check(d)).rejects.toThrow(/owner of public.accounts is a member of svc_onboard/)
  })

  it('a missing migration record, a lost number index, and a gap or a second file under one number are all caught (B3r item 4)', async () => {
    const d = await healthy()
    await d.exec(`DROP TABLE schema_migrations`)
    await expect(check(d)).rejects.toThrow(/schema_migrations is missing/)

    const d2 = await healthy()
    await d2.exec(`DROP INDEX schema_migrations_one_per_number`)
    await expect(check(d2)).rejects.toThrow(/lost its unique index/)

    const d3 = await healthy()
    // The index refuses the second file under a held number outright...
    await expect(d3.query(`INSERT INTO schema_migrations (name) VALUES ('0003_tenancy_exposure_manifest')`)).rejects.toThrow(
      /schema_migrations_one_per_number/,
    )
    // ...and with the index gone, the gate still sees the sequence break.
    await d3.exec(`DROP INDEX schema_migrations_one_per_number`)
    await d3.exec(`INSERT INTO schema_migrations (name) VALUES ('0003_tenancy_exposure_manifest')`)
    await expect(check(d3)).rejects.toThrow(/out of sequence at: 0003_tenancy_exposure_manifest/)

    const d4 = await healthy()
    // One number past the next: a gap, whatever the last migration on disk is.
    const skipped = `${String(MIGRATIONS.length + 1).padStart(4, '0')}_skipped_one`
    await d4.exec(`INSERT INTO schema_migrations (name) VALUES ('${skipped}')`)
    await expect(check(d4)).rejects.toThrow(new RegExp(`out of sequence at: ${skipped}`))
  })

  it('a definer writer of a decision that stops reading the role is caught, and so is a writer of state that stops taking its workspace from the context (B3c tenancy audit, MAJOR 1)', async () => {
    const d = await healthy()
    // ws_resolve_request with 0005's role check dropped: still scoped by ws_required(), still owned by svc_onboard, still on the allowlist.
    await d.exec(`CREATE OR REPLACE FUNCTION ws_resolve_request(p_kind text, p_host text, p_expect_requested_at timestamptz, p_status text, p_by text, p_note text) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
      DECLARE ws uuid := ws_required(); n integer;
      BEGIN
        UPDATE workspace_requests r SET status = p_status, resolved_at = now(), resolved_by = p_by, note = p_note
         WHERE r.workspace_id = ws AND r.kind = p_kind AND r.host = p_host AND r.status = 'pending' AND r.requested_at = p_expect_requested_at;
        GET DIAGNOSTICS n = ROW_COUNT;
        RETURN n = 1;
      END $fn$`)
    await expect(check(d)).rejects.toThrow(/without ws_required\(\) or, for a decision, current_workspace_role\(\): ws_resolve_request/)

    // ws_put_cycle taking its workspace straight from the reader instead of ws_required(): not a decision, but no longer refused without a context.
    const d2 = await healthy()
    await d2.exec(`CREATE OR REPLACE FUNCTION ws_put_cycle(p_host text, p_day date, p_algo_version text, p_comparison_basis text, p_result jsonb) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
      BEGIN
        INSERT INTO workspace_cycles (workspace_id, host, day, algo_version, comparison_basis, result)
        VALUES (current_workspace_id(), p_host, p_day, p_algo_version, p_comparison_basis, p_result);
      END $fn$`)
    await expect(check(d2)).rejects.toThrow(/ws_put_cycle/)

    // Filing a request is not a decision: the real ws_file_request, which reads no role, passes (the healthy database does).
    await check(await healthy())
  })

  // The derivation's holes named by the oversight pass on B3c (B3d item 3),
  // one failing database each. Every case is a definer that writes workspace
  // state in a form the first derivation did not see; each failed against
  // that derivation before it was widened (run and recorded 2026-09-15).
  describe('the derivation over definer writers covers every form of write (B3d item 3)', () => {
    // Not reachable by any application role, so the allowlist assertion above
    // does not catch it first: only the writer derivation can.
    const asOnboard = async (d: PGlite, sql: string, sig: string) => {
      await d.exec(sql)
      await d.exec(`ALTER FUNCTION ${sig} OWNER TO svc_onboard; REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC`)
    }

    it('an UPDATE of workspace_documents without the role check', async () => {
      const d = await healthy()
      await asOnboard(
        d,
        `CREATE FUNCTION ws_touch_document(p_host text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
           DECLARE ws uuid := ws_required();
           BEGIN UPDATE workspace_documents SET written_at = now() WHERE workspace_id = ws AND host = p_host; END $fn$`,
        'ws_touch_document(text)',
      )
      await expect(check(d)).rejects.toThrow(/current_workspace_role\(\): .*ws_touch_document/)
    })

    it('a DELETE of workspace_documents without the role check', async () => {
      const d = await healthy()
      await asOnboard(
        d,
        `CREATE FUNCTION ws_forget_document(p_host text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
           DECLARE ws uuid := ws_required();
           BEGIN DELETE FROM workspace_documents WHERE workspace_id = ws AND host = p_host; END $fn$`,
        'ws_forget_document(text)',
      )
      await expect(check(d)).rejects.toThrow(/current_workspace_role\(\): .*ws_forget_document/)
    })

    it('an INSERT into workspace_requests that lands a status, without the role check', async () => {
      const d = await healthy()
      await asOnboard(
        d,
        `CREATE FUNCTION ws_file_applied(p_kind text, p_host text, p_body jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
           DECLARE ws uuid := ws_required();
           BEGIN INSERT INTO workspace_requests (workspace_id, kind, host, body, status, resolved_at) VALUES (ws, p_kind, p_host, p_body, 'applied', now()); END $fn$`,
        'ws_file_applied(text,text,jsonb)',
      )
      await expect(check(d)).rejects.toThrow(/current_workspace_role\(\): .*ws_file_applied/)
    })

    it('a schema-qualified table name', async () => {
      const d = await healthy()
      await asOnboard(
        d,
        `CREATE FUNCTION ws_put_qualified(p_host text, p_body jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
           DECLARE ws uuid := ws_required();
           BEGIN INSERT INTO public.workspace_documents (workspace_id, kind, host, version, body) VALUES (ws, 'category-record', p_host, 1, p_body); END $fn$`,
        'ws_put_qualified(text,jsonb)',
      )
      await expect(check(d)).rejects.toThrow(/current_workspace_role\(\): .*ws_put_qualified/)
    })

    it('dynamic SQL against workspace state is refused outright, even with both checks in the body', async () => {
      const d = await healthy()
      await asOnboard(
        d,
        `CREATE FUNCTION ws_put_dynamic(p_host text, p_body jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
           DECLARE ws uuid := ws_required(); r text := current_workspace_role();
           BEGIN EXECUTE format('INSERT INTO workspace_documents (workspace_id, kind, host, version, body) VALUES (%L, %L, %L, 1, %L)', ws, 'category-record', p_host, p_body); END $fn$`,
        'ws_put_dynamic(text,jsonb)',
      )
      await expect(check(d)).rejects.toThrow(/dynamic SQL against workspace state.*ws_put_dynamic/)
    })

    it('a definer owned by any other role is held to the same rules', async () => {
      const d = await healthy()
      // Owned by the migration owner (PGlite's superuser), not svc_onboard: still a door through RLS.
      await d.exec(`CREATE FUNCTION ws_put_as_owner(p_host text, p_body jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
           DECLARE ws uuid := ws_required();
           BEGIN INSERT INTO workspace_documents (workspace_id, kind, host, version, body) VALUES (ws, 'category-record', p_host, 1, p_body); END $fn$;
         REVOKE ALL ON FUNCTION ws_put_as_owner(text, jsonb) FROM PUBLIC`)
      await expect(check(d)).rejects.toThrow(/current_workspace_role\(\): .*ws_put_as_owner/)
    })
  })

  it('a tenant-readable relation with an open policy, a wrapper policy, an open WITH CHECK, or no read policy is caught (B3r item 3)', async () => {
    const d = await healthy()
    await d.exec(`CREATE TABLE leaky (workspace_id uuid); ALTER TABLE leaky ENABLE ROW LEVEL SECURITY; ALTER TABLE leaky FORCE ROW LEVEL SECURITY;
                  GRANT SELECT ON leaky TO app_rw; CREATE POLICY open ON leaky FOR SELECT USING (true)`)
    await expect(check(d)).rejects.toThrow(/public\.leaky \(policy open does not scope on current_workspace_id\)/)

    const d2 = await healthy()
    await d2.exec(`CREATE FUNCTION ws_wrap() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT current_workspace_id() $$;
                   CREATE TABLE leaky (workspace_id uuid); ALTER TABLE leaky ENABLE ROW LEVEL SECURITY; ALTER TABLE leaky FORCE ROW LEVEL SECURITY;
                   GRANT SELECT ON leaky TO app_rw; CREATE POLICY wrapped ON leaky FOR SELECT USING (workspace_id = ws_wrap())`)
    await expect(check(d2)).rejects.toThrow(/policy wrapped does not scope/)

    const d3 = await healthy()
    // qual is scoped; the write side is open. Reading qual alone passed this.
    await d3.exec(`CREATE TABLE leaky (workspace_id uuid); ALTER TABLE leaky ENABLE ROW LEVEL SECURITY; ALTER TABLE leaky FORCE ROW LEVEL SECURITY;
                   GRANT SELECT, INSERT ON leaky TO app_rw;
                   CREATE POLICY r ON leaky FOR SELECT USING (workspace_id = current_workspace_id());
                   CREATE POLICY w ON leaky FOR INSERT WITH CHECK (true)`)
    await expect(check(d3)).rejects.toThrow(/policy w does not scope/)

    const d4 = await healthy()
    // A view is a relation too; the old sweeps looked at tables only.
    await d4.exec(`CREATE VIEW everyone AS SELECT id, email FROM accounts; GRANT SELECT ON everyone TO app_rw`)
    await expect(check(d4)).rejects.toThrow(/public\.everyone \(no read policy for the tenant role\)/)

    // THE FINDING (B3r audit, MAJOR): production's tenant is a login role that
    // is a member of app_rw, and app_rw may inherit a group. A policy or grant
    // naming either passed a derivation that named only app_rw, and the
    // tenant then read every workspace's documents.
    const d5 = await healthy()
    await d5.exec(`CREATE ROLE web_prod LOGIN; GRANT app_rw TO web_prod;
                   CREATE POLICY wide_docs ON workspace_documents FOR SELECT TO web_prod USING (true)`)
    await expect(check(d5)).rejects.toThrow(/workspace_documents \(policy wide_docs does not scope/)

    const d6 = await healthy()
    await d6.exec(`CREATE ROLE reporting_grp NOLOGIN; GRANT reporting_grp TO app_rw;
                   CREATE TABLE leak_grp (workspace_id uuid); ALTER TABLE leak_grp ENABLE ROW LEVEL SECURITY; ALTER TABLE leak_grp FORCE ROW LEVEL SECURITY;
                   GRANT SELECT ON leak_grp TO reporting_grp; CREATE POLICY open ON leak_grp FOR SELECT TO reporting_grp USING (true)`)
    await expect(check(d6)).rejects.toThrow(/public\.leak_grp \(policy open does not scope/)

    const d7 = await healthy()
    await d7.exec(`CREATE ROLE web_prod LOGIN; GRANT app_rw TO web_prod;
                   CREATE TABLE leak_login (workspace_id uuid); ALTER TABLE leak_login ENABLE ROW LEVEL SECURITY; ALTER TABLE leak_login FORCE ROW LEVEL SECURITY;
                   GRANT SELECT ON leak_login TO web_prod`)
    await expect(check(d7)).rejects.toThrow(/public\.leak_login \(no read policy for the tenant role\)/)
  })

  it('a table that loses FORCE RLS is caught', async () => {
    const d = await healthy()
    await d.exec(`ALTER TABLE score_rows NO FORCE ROW LEVEL SECURITY`)
    await expect(check(d)).rejects.toThrow(/RLS is not forced on: .*score_rows/)
  })

  it('a context reader that stops being SECURITY DEFINER is caught, and so is a missing one', async () => {
    const d = await healthy()
    await d.exec(`ALTER FUNCTION current_account_id() SECURITY INVOKER`)
    await expect(check(d)).rejects.toThrow(/must exist and be SECURITY DEFINER/)

    const d2 = await healthy()
    await d2.exec(`DROP FUNCTION set_workspace(uuid)`)
    await expect(check(d2)).rejects.toThrow(/must exist and be SECURITY DEFINER/)
  })

  it('THE FINDING: the bare-GUC regression assertion actually bites', async () => {
    const d = await healthy()
    // Flagged as having no failing case: by this file's own rule that makes it
    // decoration, and it is the regression assertion for the original BLOCKER.
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

describe('the attacks hold for a real non-superuser LOGIN principal', () => {
  /**
   * rls.test.ts enters app_rw with `SET LOCAL ROLE` from a superuser session.
   * That is faithful for RLS specifically — confirmed identical results — but it
   * structurally cannot test SET ROLE / SET SESSION AUTHORIZATION escapes,
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
