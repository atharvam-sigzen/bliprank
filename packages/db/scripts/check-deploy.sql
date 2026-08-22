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
-- AND WHY IT IS WRITTEN THE WAY IT IS. Two earlier versions of this file failed
-- in the same way, and the pattern is worth naming so a third does not:
--
--   1. It certified that "the tenant cannot name a workspace" by checking
--      EXECUTE on set_workspace(uuid). That passed while any role could name any
--      workspace with a bare SET LOCAL, because set_workspace() was never the
--      mechanism. It asserted a proxy.
--   2. It then checked the right properties against a HARDCODED LIST of three
--      group roles. A login role granted EXECUTE on set_workspace(), and a role
--      with BYPASSRLS, both passed every assertion and read every tenant.
--
-- So: assert the property, and enumerate from the catalog, never from a literal
-- list of the things someone thought of. Anything below that names a specific
-- object is either the object itself (auth_signing_keys) or a bug.

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

-- A materialized view cannot carry RLS at all, so granting one to an application
-- role hands over an unfiltered copy of whatever it selects. The measurement
-- corpus is meant to be reached by a filtered join, never by a copy, and a
-- matview is the obvious reach when a rollup needs to be fast.
\echo 'checking no materialized view is readable by an application role...'
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s -> %s', c.relname, r.rolname), ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN unnest(ARRAY['app_rw', 'svc_scorer', 'svc_onboard']) AS r(rolname)
   WHERE n.nspname = 'public' AND c.relkind = 'm'
     AND has_any_column_privilege(r.rolname, c.oid, 'SELECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'materialized views cannot have RLS and must not be granted to an application role: %', bad;
  END IF;
END $$;

-- THE PROPERTY: nothing an application connects as may write a tenant context,
-- by any route. Enumerated from pg_roles, plus PUBLIC — not from a list of the
-- three group roles, which is how a login role granted EXECUTE on
-- set_workspace() passed this check and then read another tenant.
\echo 'checking no role outside auth_verifier can manufacture a tenant context...'
DO $$
DECLARE r text; bad text := '';
BEGIN
  FOR r IN
    SELECT rolname FROM pg_roles
     WHERE rolname NOT LIKE 'pg\_%' AND rolname <> 'auth_verifier' AND NOT rolsuper
    UNION ALL SELECT 'public'
  LOOP
    IF has_table_privilege(r, 'auth_tenant_context', 'INSERT')
       OR has_table_privilege(r, 'auth_tenant_context', 'UPDATE')
       OR has_table_privilege(r, 'auth_tenant_context', 'DELETE')
       OR has_any_column_privilege(r, 'auth_tenant_context'::regclass, 'SELECT') THEN
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

-- The two tables that hold the keys to the kingdom may carry no policy other
-- than the verifier's own. A grant on them is caught above; an over-broad POLICY
-- is a separate mistake and RLS is the only thing standing behind it.
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

-- Every table an application role can read must scope on the tenant context, or
-- be a deliberate exception. This sweep lived only in the test suite, which is
-- exactly the "proves it about a fixture" failure this file exists to avoid: a
-- new table with `USING (true)` passed the deploy and served every tenant's rows.
\echo 'checking every tenant-readable table scopes on the tenant context...'
DO $$
DECLARE
  -- Genuinely shared, deliberately unscoped reference data. Adding to this list
  -- is a tenancy decision and should be reviewed as one.
  shared text[] := ARRAY['prompt_banks'];
  bad text := '';
  t record;
  n_scoped int;
  n_total  int;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND has_any_column_privilege('app_rw', c.oid, 'SELECT')
       AND NOT (c.relname = ANY (shared))
  LOOP
    SELECT count(*) FILTER (WHERE coalesce(qual, '') LIKE '%current_workspace_id%'), count(*)
      INTO n_scoped, n_total
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = t.relname AND cmd IN ('SELECT', 'ALL')
       AND (roles = '{public}' OR 'app_rw' = ANY (roles));
    IF n_total = 0 OR n_scoped <> n_total THEN
      bad := bad || format('%s (%s of %s policies scoped); ', t.relname, n_scoped, n_total);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'app_rw can read these without a tenant-scoped policy: %', bad;
  END IF;
END $$;

-- The context functions must be SECURITY DEFINER owned by auth_verifier, and
-- must pin their search_path. A future migration that CREATE OR REPLACEs one
-- without restoring both silently changes what it can see.
\echo 'checking the context functions are definer-owned with a pinned search_path...'
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO bad
    FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
   WHERE p.proname IN ('current_workspace_id', 'current_account_id', 'stamp_tenant_context', 'set_workspace_jwt', 'set_workspace')
     AND (NOT p.prosecdef
          OR o.rolname <> 'auth_verifier'
          OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) cfg WHERE cfg LIKE 'search\_path=%'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'these must be SECURITY DEFINER, owned by auth_verifier, with a pinned search_path: %', bad;
  END IF;
END $$;

-- No GUC may establish a context. The regression test for the 2026-08-22
-- BLOCKER, run against the real database rather than a fixture.
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

-- A live, fully configured signing key must exist. Migration 0002 grandfathers
-- pre-existing rows (NOT VALID), so an unconfigured legacy key is inert rather
-- than a migration failure — and this is where that becomes visible.
\echo 'checking a live, fully configured JWT signing key exists...'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth_signing_keys
     WHERE retired_at IS NULL AND length(kid) > 0 AND length(secret) >= 32
       AND issuer IS NOT NULL AND length(issuer) > 0
       AND audience IS NOT NULL AND length(audience) > 0
  ) THEN
    RAISE EXCEPTION 'no live, fully configured row in auth_signing_keys: no tenant can establish a session. A key carried over from before migration 0002 needs issuer, audience and a >=32 char secret — rotate it.';
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
EXCEPTION WHEN undefined_function THEN
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

\echo 'deploy checks passed.'
