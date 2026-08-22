-- Deploy-time tenancy assertions. Run against the target database AFTER login
-- roles have been created and granted, as the final step of a deploy:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/scripts/check-deploy.sql
--
-- or `pnpm --filter @bliprank/db db:check`. Any assertion below raises, psql
-- exits non-zero, and the deploy fails.
--
-- WHY THIS EXISTS. Login roles, role attributes and ad-hoc grants are created at
-- deploy time, outside every migration. A test suite proves things about a
-- fixture database and nothing whatsoever about the database customers are on.
--
-- THREE AUDITS HAVE NOW FOUND THE SAME BUG IN THIS FILE, so it is worth naming
-- precisely rather than restating the principle a fourth time:
--
--   1. It certified "the tenant cannot name a workspace" by testing EXECUTE on
--      set_workspace(uuid), while any role could name any workspace with a bare
--      SET LOCAL. It asserted a PROXY for the property.
--   2. It then asserted the right properties against a hardcoded LIST of three
--      group roles. A login role granted EXECUTE on set_workspace() passed, and
--      a role with BYPASSRLS passed and read every tenant.
--   3. The replacement still named a specific ARRANGEMENT in five places:
--      `pg_has_role(..., 'USAGE')` (blind to NOINHERIT members, who reach
--      everything via SET ROLE), `rolcanlogin` (blind to BYPASSRLS on a NOLOGIN
--      role reached via SET ROLE), a literal list of five function names for the
--      SECURITY DEFINER check, `relkind IN ('r','p')` (blind to views), and the
--      literal role name 'app_rw' (blind to a grant made to the login role).
--      Each had a working proof-of-concept ending in the plaintext HMAC secret.
--
-- The rule, stated once: **an assertion may name only the object it is about.**
-- Every SUBJECT — which roles, which relkinds, which functions — is derived from
-- the catalog. If you find yourself typing a role name or a relkind list into a
-- WHERE clause below, that is the bug, and it has shipped three times.
--
-- Two derived sets are used throughout, defined once here:
--   * a PRINCIPAL is any role that is not auth_verifier and not an internal
--     pg_* role. The property is "only auth_verifier holds this", so who can
--     reach whom does not enter into it.
--   * a TENANT PRINCIPAL is app_rw, PUBLIC, or any role that is a MEMBER of
--     app_rw — MEMBER, because SET ROLE is the reachability that matters.

\echo 'checking role exclusivity, RLS-bypassing roles, and superusers...'
SELECT assert_role_exclusivity();

-- Every table in public must have RLS enabled AND forced. ENABLE alone does not
-- bind the table owner, and migrations run as the owner.
\echo 'checking FORCE ROW LEVEL SECURITY on every table...'
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RLS is not forced on: %', bad;
  END IF;
END $$;

-- Only auth_verifier may hold any privilege that writes a tenant context or
-- reads the signing secret. Enumerated over EVERY role, so it does not matter
-- whether a given one is login-capable, inherits, or is reached by SET ROLE:
-- if the privilege is held anywhere else, that is already wrong.
\echo 'checking only auth_verifier can write a context or read a key...'
DO $$
DECLARE r text; bad text := '';
BEGIN
  FOR r IN
    SELECT rolname FROM pg_roles
     WHERE rolname NOT LIKE 'pg\_%' AND rolname <> 'auth_verifier' AND NOT rolsuper
    UNION ALL SELECT 'public'
  LOOP
    IF has_any_column_privilege(r, 'auth_tenant_context'::regclass, 'SELECT')
       OR has_table_privilege(r, 'auth_tenant_context', 'INSERT')
       OR has_table_privilege(r, 'auth_tenant_context', 'UPDATE')
       OR has_table_privilege(r, 'auth_tenant_context', 'DELETE') THEN
      bad := bad || format('%s has a grant on auth_tenant_context; ', r);
    END IF;
    IF has_function_privilege(r, 'stamp_tenant_context(uuid,uuid)', 'EXECUTE') THEN
      bad := bad || format('%s can call stamp_tenant_context(); ', r);
    END IF;
    IF has_function_privilege(r, 'set_workspace(uuid)', 'EXECUTE') THEN
      bad := bad || format('%s can call set_workspace(); ', r);
    END IF;
    IF has_any_column_privilege(r, 'auth_signing_keys'::regclass, 'SELECT') THEN
      bad := bad || format('%s can read the signing secret; ', r);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'tenant context or signing key is reachable outside auth_verifier: %', bad;
  END IF;
END $$;

-- EVERY SECURITY DEFINER function in public, derived — not the five this
-- migration happens to create. A definer function owned by auth_verifier and
-- granted to an application role IS a privilege grant: audit 3 shipped a
-- six-line `auth_key_status()` helper past the previous check and read the
-- plaintext secret with it, then forged a token for another tenant and entered
-- through the front door. The codebase hands helpers to auth_verifier as a
-- matter of convention, so the next one is a question of when.
\echo 'checking every SECURITY DEFINER function in public...'
DO $$
DECLARE bad text := '';
BEGIN
  -- Owner and pinned search_path, for all of them.
  SELECT bad || coalesce(string_agg(format('%s (owner %s, search_path %s)', p.proname, o.rolname,
           CASE WHEN EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search\_path=%') THEN 'pinned' ELSE 'UNPINNED' END),
         '; ' ORDER BY p.proname), '') INTO bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles o ON o.oid = p.proowner
   WHERE n.nspname = 'public' AND p.prosecdef
     AND (o.rolname <> 'auth_verifier'
          OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search\_path=%'));
  IF bad <> '' THEN
    RAISE EXCEPTION 'SECURITY DEFINER functions must be owned by auth_verifier with a pinned search_path: %', bad;
  END IF;

  -- And these five must REMAIN definer functions. The sweep above is filtered on
  -- prosecdef, so a function that stops being one leaves the scan rather than
  -- failing it — `ALTER FUNCTION current_account_id() SECURITY INVOKER` passed
  -- silently, and the reader would then run as the caller, who cannot read the
  -- context table. Naming them is correct here: the assertion is about these
  -- objects, and it is default-deny in the safe direction.
  SELECT coalesce(string_agg(sig, ', ' ORDER BY sig), '') INTO bad
    FROM unnest(ARRAY['current_workspace_id()', 'current_account_id()', 'stamp_tenant_context(uuid,uuid)',
                      'set_workspace_jwt(text)', 'set_workspace(uuid)']) AS sig
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.oid::regprocedure::text = sig AND p.prosecdef);
  IF bad <> '' THEN
    RAISE EXCEPTION 'these must exist and be SECURITY DEFINER, owned by auth_verifier: %', bad;
  END IF;

  -- Executable by anyone else: three are allowed, BY NAME, and the naming is
  -- the point rather than the bug. The failure this file keeps repeating is a
  -- DEFAULT-ALLOW list — "check only these five functions", so the sixth was
  -- unexamined. This is a DEFAULT-DENY list: every definer function is refused
  -- unless it is one of the three that constitute the intended surface, so a new
  -- one fails the deploy the day it is written. That is the opposite property.
  --
  -- Why these three are safe to expose: set_workspace_jwt(text) takes a
  -- credential it verifies before acting on it, and the two readers take no
  -- argument at all — there is nothing to tell them to fetch, and they return
  -- the caller's own context or nothing. auth_key_status(), the six-line helper
  -- that walked past the previous check and returned the plaintext secret, also
  -- took no arguments; zero-arity is therefore not a sufficient test and a
  -- reviewed list is.
  SELECT coalesce(string_agg(format('%s -> %s', sig, grantee), '; ' ORDER BY sig, grantee), '') INTO bad
    FROM (
      SELECT p.oid::regprocedure::text AS sig, g.rolname AS grantee
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       CROSS JOIN LATERAL (
         SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg\_%' AND rolname <> 'auth_verifier' AND NOT rolsuper
         UNION ALL SELECT 'public'
       ) g
       WHERE n.nspname = 'public' AND p.prosecdef
         AND p.oid::regprocedure::text NOT IN (
               'set_workspace_jwt(text)', 'current_workspace_id()', 'current_account_id()')
         AND has_function_privilege(g.rolname, p.oid, 'EXECUTE')
    ) x;
  IF bad <> '' THEN
    RAISE EXCEPTION 'these SECURITY DEFINER functions are executable outside auth_verifier: %', bad;
  END IF;
END $$;

-- Object KINDS are derived too. A materialized view cannot carry RLS at all; a
-- plain view is only as safe as its owner's RLS posture unless it is
-- security_invoker; a foreign table has no policies. Any of them granted to a
-- tenant principal is an unfiltered copy of whatever it selects — and the
-- measurement corpus is meant to be reached by a filtered join, never a copy.
\echo 'checking views, matviews and foreign tables are not readable by a tenant principal...'
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s (%s) -> %s', c.relname,
           CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' ELSE 'foreign table' END, g.rolname),
         '; ' ORDER BY c.relname) INTO bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL (
     SELECT rolname FROM pg_roles
      WHERE rolname NOT LIKE 'pg\_%' AND NOT rolsuper
        AND (rolname = 'app_rw' OR pg_has_role(rolname, 'app_rw', 'MEMBER'))
     UNION ALL SELECT 'public'
   ) g
   WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm', 'f')
     AND has_any_column_privilege(g.rolname, c.oid, 'SELECT')
     -- A security_invoker view runs the caller's policies, so it is a filtered
     -- join wearing a different hat. Everything else is a copy.
     AND NOT (c.relkind = 'v' AND coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions)
                                             WHERE option_name = 'security_invoker'), 'false') = 'true');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'these cannot carry tenant policies and must not be readable by a tenant principal: %', bad;
  END IF;
END $$;

-- Every table a TENANT PRINCIPAL can read must scope on the tenant context, and
-- every write policy it can use must scope its WITH CHECK. The read half alone
-- let a legitimately-authenticated WS1 session INSERT a row into WS2 through a
-- `FOR INSERT WITH CHECK (true)` policy — invisible to the writer, and read by
-- the victim as its own reconciliation data. On a product whose claim is that
-- its numbers reconcile, that is corruption of record, not merely a leak.
--
-- The "genuinely shared" exemption is a DEFAULT-DENY list plus a property check
-- on the list itself. Deriving it purely from "has no FK to workspaces" was
-- tried and is wrong: a table can carry a `workspace_id uuid NOT NULL` column
-- with no formal constraint, and a hurried migration is exactly where that
-- happens — such a table silently qualified as shared reference data and served
-- every tenant's rows. So: everything is scoped unless named, AND anything named
-- must still have no workspace foreign key, so `prompt_banks` gaining one forces
-- it out automatically. 0000 says private banks go in a separate table; this is
-- what makes that a rule rather than a comment.
\echo 'checking every tenant-readable and tenant-writable table scopes on the context...'
DO $$
DECLARE bad text := ''; t record; n_scoped int; n_total int;
BEGIN
  FOR t IN
    SELECT DISTINCT c.oid, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL (
       SELECT rolname FROM pg_roles
        WHERE rolname NOT LIKE 'pg\_%' AND NOT rolsuper
          AND (rolname = 'app_rw' OR pg_has_role(rolname, 'app_rw', 'MEMBER'))
       UNION ALL SELECT 'public'
     ) g
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND (has_any_column_privilege(g.rolname, c.oid, 'SELECT')
            OR has_any_column_privilege(g.rolname, c.oid, 'INSERT')
            OR has_any_column_privilege(g.rolname, c.oid, 'UPDATE'))
       AND (c.relname <> ALL (ARRAY['prompt_banks'])
            -- an exempt table that grows a workspace FK stops being exempt
            OR EXISTS (SELECT 1 FROM pg_constraint fk
                        WHERE fk.conrelid = c.oid AND fk.contype = 'f'
                          AND fk.confrelid = 'workspaces'::regclass))
  LOOP
    SELECT count(*) FILTER (WHERE coalesce(qual, '') LIKE '%current_workspace_id%'), count(*)
      INTO n_scoped, n_total
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = t.relname AND cmd IN ('SELECT', 'ALL')
       AND (roles = '{public}' OR EXISTS (
             SELECT 1 FROM unnest(roles) rr
              WHERE rr::text = 'app_rw' OR pg_has_role(rr::text, 'app_rw', 'MEMBER')));
    IF n_total = 0 OR n_scoped <> n_total THEN
      bad := bad || format('%s reads unscoped (%s of %s); ', t.relname, n_scoped, n_total);
    END IF;

    SELECT count(*) FILTER (WHERE coalesce(with_check, qual, '') LIKE '%current_workspace_id%'), count(*)
      INTO n_scoped, n_total
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = t.relname AND cmd IN ('INSERT', 'UPDATE', 'ALL')
       AND (roles = '{public}' OR EXISTS (
             SELECT 1 FROM unnest(roles) rr
              WHERE rr::text = 'app_rw' OR pg_has_role(rr::text, 'app_rw', 'MEMBER')));
    IF n_total > 0 AND n_scoped <> n_total THEN
      bad := bad || format('%s writes unscoped (%s of %s); ', t.relname, n_scoped, n_total);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'a tenant principal can reach these without a tenant-scoped policy: %', bad;
  END IF;
END $$;

-- The two tables holding the keys to the kingdom may carry no policy other than
-- the verifier's own. A grant is caught above; an over-broad POLICY is a
-- separate mistake and RLS is the only thing behind it.
\echo 'checking auth_* tables carry only auth_verifier policies...'
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s.%s', tablename, policyname), ', ' ORDER BY policyname) INTO bad
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('auth_signing_keys', 'auth_tenant_context')
     AND roles <> ARRAY['auth_verifier']::name[];
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'these policies open an auth table beyond auth_verifier: %', bad;
  END IF;
END $$;

-- No GUC may establish a context. The regression test for the audit-1 BLOCKER,
-- run against the real database rather than a fixture.
\echo 'checking a bare GUC cannot establish a tenant context...'
DO $$
DECLARE got uuid;
BEGIN
  PERFORM set_config('app.workspace_id', '00000000-0000-4000-8000-000000000001', true);
  PERFORM set_config('app.workspace_at', transaction_timestamp()::text, true);
  PERFORM set_config('app.account_id',   '00000000-0000-4000-8000-0000000000f1', true);
  SELECT current_workspace_id() INTO got;
  IF got IS NOT NULL THEN
    RAISE EXCEPTION 'current_workspace_id() honoured a GUC: any role could set that with SET LOCAL';
  END IF;
  SELECT current_account_id() INTO got;
  IF got IS NOT NULL THEN
    RAISE EXCEPTION 'current_account_id() honoured a GUC';
  END IF;
END $$;

-- The property is NOT EXISTS(bad key), not EXISTS(good key). Asserting that one
-- good key exists let a second key with a one-character secret sit alongside it
-- and verify tokens — the constraint had been dropped, and nothing checked that
-- either. Both are asserted here now.
\echo 'checking every live signing key is fully configured...'
DO $$
DECLARE bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_signing_keys_live_is_configured') THEN
    RAISE EXCEPTION 'the auth_signing_keys_live_is_configured constraint has been dropped; live keys are unconstrained';
  END IF;

  SELECT string_agg(kid, ', ' ORDER BY kid) INTO bad
    FROM auth_signing_keys
   WHERE (retired_at IS NULL OR retired_at > now())
     AND NOT (length(kid) > 0 AND length(secret) >= 32
              AND issuer IS NOT NULL AND length(issuer) > 0
              AND audience IS NOT NULL AND length(audience) > 0
              AND max_lifetime_s BETWEEN 60 AND 604800);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'these live signing keys are not fully configured and will verify tokens: %. Retire or rotate them.', bad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth_signing_keys WHERE retired_at IS NULL OR retired_at > now()) THEN
    RAISE EXCEPTION 'no live row in auth_signing_keys: no tenant can establish a session. A key carried over from before migration 0002 needs issuer, audience and a >=32 char secret — rotate it.';
  END IF;
END $$;

-- pgcrypto must resolve from the search_path the definer functions pin. On
-- Supabase it conventionally lives in `extensions`, and `CREATE EXTENSION IF NOT
-- EXISTS` is then a silent no-op — set_workspace_jwt() would fail to find
-- hmac()/digest() at call time, which fails closed but only once nobody can log
-- in. Better to find out here.
\echo 'checking pgcrypto resolves from schema public...'
DO $$
BEGIN
  PERFORM public.digest('probe', 'sha256');
  PERFORM public.hmac('probe', 'key', 'sha256');
EXCEPTION WHEN undefined_function OR undefined_table THEN
  RAISE EXCEPTION 'pgcrypto is not resolvable as public.digest/public.hmac; set_workspace_jwt() pins search_path=public,pg_temp and would fail at call time';
END $$;

-- PUBLIC must not be able to create objects in the schema the definer functions
-- pin to. Default since PG15, but a restored database or an explicit GRANT can
-- undo it, and it is the remaining assumption behind `SET search_path = public`.
\echo 'checking PUBLIC cannot create in schema public...'
DO $$
BEGIN
  IF has_schema_privilege('public', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'PUBLIC has CREATE on schema public: a definer function''s search_path can be shadowed';
  END IF;
END $$;

-- Say what was waived. A deliberate decision that leaves no trace in the
-- artefact recording it is not a deliberate decision: the previous version
-- printed "deploy checks passed" identically whether the allowlist held
-- `postgres` or `postgres, web_prod, reporting, everyone`.
\echo 'RLS-bypass roles excused by bliprank.rls_bypass_allowed:'
SELECT coalesce(nullif(coalesce(current_setting('bliprank.rls_bypass_allowed', true), ''), ''), '(none)') AS excused;

\echo 'deploy checks passed.'
