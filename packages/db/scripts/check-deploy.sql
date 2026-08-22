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
-- runs where the roles actually are. A bad GRANT should fail the deploy, not
-- sit undetected until it is a breach.

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

-- The tenant role must not be able to name a workspace directly. If a future
-- migration re-grants this, the whole DB-level identity model is bypassed.
\echo 'checking the tenant role cannot call the unverified setter...'
DO $$
BEGIN
  IF has_function_privilege('app_rw', 'set_workspace(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'app_rw has EXECUTE on set_workspace(uuid): the tenant can name any workspace, defeating verified identity';
  END IF;
END $$;

-- A signing key must exist and not be retired, or every tenant request 401s.
\echo 'checking at least one live JWT signing key...'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth_signing_keys WHERE retired_at IS NULL) THEN
    RAISE EXCEPTION 'no live row in auth_signing_keys: no tenant can establish a session';
  END IF;
END $$;

\echo 'deploy checks passed.'
