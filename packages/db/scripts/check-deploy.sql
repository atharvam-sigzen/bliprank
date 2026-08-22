-- Deploy-time tenancy assertions. Run against the target database AFTER login
-- roles have been created and granted, as the final step of a deploy:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/scripts/check-deploy.sql
--
-- or `pnpm --filter @bliprank/db db:check`. Any assertion below raises, psql
-- exits non-zero, and the deploy fails.
--
-- WHY THIS EXISTS. Migration 0000 asserted role exclusivity in the test suite,
-- which proves it about a fixture database and nothing whatsoever about the
-- database customers are on. Login roles are created at deploy time, outside
-- any migration, so this cannot be a constraint — it has to be a check that
-- runs where the roles actually are.
--
-- AND WHY IT IS WRITTEN CAREFULLY. An earlier version of this file certified
-- that "the tenant role cannot name a workspace directly" by checking EXECUTE
-- on set_workspace(uuid). That check passed while the tenant could name any
-- workspace with a bare `SET LOCAL app.workspace_id`, because set_workspace()
-- was never the mechanism. A deploy check that asserts a proxy for a property
-- is worse than no check: it certifies the belief that stopped anyone looking.
-- Every assertion below tests the property, not a door in front of it.

\echo 'checking role exclusivity...'
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

-- THE PROPERTY, not a proxy for it: no application role may write tenant
-- context by any route. That means the context table itself, the function that
-- writes it, and the owner-only setter — all three, for all three roles.
\echo 'checking no application role can manufacture a tenant context...'
DO $$
DECLARE r text; bad text := '';
BEGIN
  FOREACH r IN ARRAY ARRAY['app_rw', 'svc_scorer', 'svc_onboard'] LOOP
    IF has_table_privilege(r, 'auth_tenant_context', 'INSERT')
       OR has_table_privilege(r, 'auth_tenant_context', 'UPDATE')
       OR has_table_privilege(r, 'auth_tenant_context', 'DELETE')
       OR has_table_privilege(r, 'auth_tenant_context', 'SELECT') THEN
      bad := bad || format('%s has a grant on auth_tenant_context; ', r);
    END IF;
    IF has_function_privilege(r, 'stamp_tenant_context(uuid,uuid)', 'EXECUTE') THEN
      bad := bad || format('%s can call stamp_tenant_context(); ', r);
    END IF;
    IF has_function_privilege(r, 'set_workspace(uuid)', 'EXECUTE') THEN
      bad := bad || format('%s can call set_workspace(); ', r);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'tenant context is writable by an application role: %', bad;
  END IF;
END $$;

-- The context readers must be SECURITY DEFINER and owned by auth_verifier. If a
-- future migration replaces them without restoring this, they revert to running
-- as the caller, who cannot read the context table — every tenant would see
-- nothing, which fails closed, but the same slip in the other direction (a
-- non-definer reader falling back to a GUC) is how the last bug happened.
\echo 'checking the context readers are definer-owned...'
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO bad
    FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
   WHERE p.proname IN ('current_workspace_id', 'current_account_id', 'stamp_tenant_context', 'set_workspace_jwt', 'set_workspace')
     AND (NOT p.prosecdef OR o.rolname <> 'auth_verifier');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'these must be SECURITY DEFINER owned by auth_verifier: %', bad;
  END IF;
END $$;

-- No GUC may be able to establish a context. This is the regression test for the
-- 2026-08-22 BLOCKER, run against the real database rather than a fixture.
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

-- A signing key must exist, not be retired, and carry a real issuer/audience,
-- or every tenant request 401s or verifies against the wrong environment.
\echo 'checking at least one live JWT signing key, fully configured...'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth_signing_keys WHERE retired_at IS NULL) THEN
    RAISE EXCEPTION 'no live row in auth_signing_keys: no tenant can establish a session';
  END IF;
END $$;

-- PUBLIC must not be able to create objects in the schema the definer functions
-- pin their search_path to. Default since PG15, but a restored database or an
-- explicit GRANT can undo it, and it is the one remaining assumption behind
-- `SET search_path = public, pg_temp`.
\echo 'checking PUBLIC cannot create in schema public...'
DO $$
BEGIN
  IF has_schema_privilege('public', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'PUBLIC has CREATE on schema public: a definer function''s search_path can be shadowed';
  END IF;
END $$;

\echo 'deploy checks passed.'
