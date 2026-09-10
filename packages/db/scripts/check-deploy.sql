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
--
-- ===========================================================================
-- THIS FILE IS INCOMPLETE, DELIBERATELY, AND IS TRACKED. See ADR-0007.
-- ===========================================================================
--
-- Four independent audits found four BLOCKERs in the expanded version of this
-- file, and three were the same bug: an assertion that names an ARRANGEMENT — a
-- proxy, a role list, `pg_has_role` USAGE, `rolcanlogin`, a function-name list,
-- a relkind list, a grantee name, the schema, the policy command. Each round
-- enumerated more shapes and each audit found a shape not enumerated. Proving
-- "no unsafe configuration exists" by listing unsafe configurations is unbounded
-- by construction, and rounds 5, 6 and 7 each found that the previous round's
-- fix had opened the next hole.
--
-- The replacement — derive every RLS-relevant object from pg_class, pg_inherits,
-- pg_policies and real ownership, and require each one found to prove coverage —
-- is REQUIRED WORK WITH A DEADLINE: it must be closed before gate G1, because
-- PHASES.md's standing suite item 3 runs the RLS suite at every gate. The
-- existing attempt lives on `fix/tenancy-deploy-gate` (migration 0003 plus
-- deploy-check.test.ts) and is NOT merged. Do not treat its absence as a
-- finished gate, and do not re-expand this file by hand in the meantime.
--
-- WHAT REMAINS BELOW is the part that holds without that derivation: role
-- exclusivity, the RLS sweep over pg_class, and the context mechanism itself.
--
-- The other half of the guarantee is behavioural and DOES ship, in
-- `packages/db/src/tenant-isolation.test.ts`: two seeded tenants, real reads and
-- writes across every scoped relation, asserting the row sets are disjoint. A
-- policy that merely MENTIONS current_workspace_id passes any catalog check and
-- fails that one — `USING (current_workspace_id() IS NOT NULL)` returned both
-- tenants' rows while passing every static assertion ever written here.

\echo 'checking role exclusivity, RLS-bypassing roles, and superusers...'
SELECT assert_role_exclusivity();

-- Every table in public must have RLS enabled AND forced. ENABLE alone does not
-- bind the table owner, and migrations run as the owner.
\echo 'checking FORCE ROW LEVEL SECURITY on every table...'
DO $do$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RLS is not forced on: %', bad;
  END IF;
END $do$;

-- The context mechanism. These name specific objects because they ARE the
-- objects the assertion is about, which the rule above permits.
--
-- THIS RUNS BEFORE THE SETTER CHECK BELOW, deliberately: has_function_privilege()
-- on a signature that does not exist RAISES, so a dropped context reader used to
-- report `function "set_workspace(uuid)" does not exist` rather than the
-- assertion's own message. The deploy failed either way and the operator got the
-- wrong reason. Existence is established here first.
\echo 'checking the context readers exist and are definer-owned...'
DO $do$
DECLARE bad text;
BEGIN
  SELECT coalesce(string_agg(sig, ', ' ORDER BY sig), '') INTO bad
    FROM unnest(ARRAY['current_workspace_id()', 'current_account_id()', 'stamp_tenant_context(uuid,uuid)',
                      'set_workspace_jwt(text)', 'set_workspace(uuid)']) AS sig
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles o ON o.oid = p.proowner
      WHERE n.nspname = 'public' AND p.oid::regprocedure::text = sig
        AND p.prosecdef AND o.rolname = 'auth_verifier');
  IF bad <> '' THEN
    RAISE EXCEPTION 'these must exist and be SECURITY DEFINER owned by auth_verifier: %', bad;
  END IF;
END $do$;

-- >>> CORRECTION, 2026-08-24 <<<
--
-- The paragraph that stood here said the tenant role "cannot name a workspace
-- directly", and that re-granting this EXECUTE was how the DB-level identity
-- model gets bypassed. The first half was false and the second was not the
-- shortest path. Until migration 0002, tenant context was carried in a
-- customised GUC, and customised GUCs are USERSET: `SET LOCAL app.workspace_id
-- = '<any uuid>'` established a context for ANY role, needing no grant of any
-- kind. This assertion was true, and it certified something it did not prove.
--
-- It is kept because revoking that EXECUTE is still correct. The assertion that
-- actually closes the hole is the bare-GUC one further down.
\echo 'checking the tenant role cannot call the unverified setter...'
DO $do$
BEGIN
  IF has_function_privilege('app_rw', 'set_workspace(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'app_rw has EXECUTE on set_workspace(uuid): the tenant can name any workspace, defeating verified identity';
  END IF;
END $do$;

-- No GUC may establish a context. The regression assertion for the BLOCKER the
-- correction above describes, run against the real database rather than a
-- fixture. Migration 0002 moved the context into a definer-owned table keyed
-- (backend_pid, xid8) that no application role can write.
\echo 'checking a bare GUC cannot establish a tenant context...'
DO $do$
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
END $do$;

-- pgcrypto must resolve from the search_path the definer functions pin. On
-- Supabase it conventionally lives in `extensions`, and `CREATE EXTENSION IF NOT
-- EXISTS` is then a silent no-op — set_workspace_jwt() would fail to find
-- hmac()/digest() at call time, which fails closed but only once nobody can log
-- in. Better to find out here.
\echo 'checking pgcrypto resolves from schema public...'
DO $do$
BEGIN
  PERFORM public.digest('probe', 'sha256');
  PERFORM public.hmac('probe', 'key', 'sha256');
EXCEPTION WHEN undefined_function OR undefined_table THEN
  RAISE EXCEPTION 'pgcrypto is not resolvable as public.digest/public.hmac; set_workspace_jwt() pins search_path=public,pg_temp and would fail at call time';
END $do$;

-- Every SECURITY DEFINER function an application role may EXECUTE is a door
-- through RLS: it runs as its owner, and its body is the whole of what the
-- caller can do. The 2026-09-10 tenancy audit found that migration 0003
-- added three such doors and no derivation in the repo could see them
-- (every standing check derives over tables and policies). So the property
-- is inverted here the way the exposure manifest inverts it for tables:
-- every reachable definer function must be declared, and one that is not
-- fails the deploy. The declared list is the arrangement; the derivation is
-- the property.
\echo 'checking every SECURITY DEFINER function an application role may execute is declared...'
DO $do$
DECLARE bad text;
BEGIN
  SELECT string_agg(sig, ', ' ORDER BY sig) INTO bad FROM (
    SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND EXISTS (SELECT 1 FROM unnest(ARRAY['app_rw', 'svc_scorer', 'svc_onboard']) AS g(r)
                    WHERE has_function_privilege(g.r, p.oid, 'EXECUTE'))
  ) f
  WHERE sig <> ALL (ARRAY[
    -- 0002: the context readers (PUBLIC) and the verifier (app_rw)
    'current_workspace_id()', 'current_account_id()', 'set_workspace_jwt(text)',
    -- 0003: onboarding, owned by svc_onboard, app_rw only
    'ensure_account(uuid,text,text)', 'create_workspace(uuid,text)', 'workspaces_of(uuid)',
    -- 0004: workspace state writers, owned by svc_onboard, workspace from the verified context
    'ws_required()', 'ws_put_cycle(text,date,text,text,jsonb)', 'ws_put_document(text,text,jsonb)',
    'ws_file_request(text,text,jsonb,timestamp with time zone)',
    'ws_resolve_request(text,text,timestamp with time zone,text,text,text)'
  ]);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'undeclared SECURITY DEFINER functions reachable by an application role: %', bad;
  END IF;
END $do$;

-- DELIBERATELY ABSENT, and moving with the gate rather than being reimplemented
-- here (ADR-0007):
--
--   * the exposure manifest — every reachable object must be declared, so a new
--     schema, relkind, verb or grantee fails by default instead of needing to
--     have been predicted;
--   * assert_role_powers() — predefined-role membership (pg_execute_server_program,
--     pg_read_all_data, pg_maintain, pg_signal_backend) and REPLICATION, none of
--     which appears in any table ACL;
--   * live signing key health. The 0001-era version of this read
--     auth_signing_keys directly, which after 0002 FORCEs RLS with a single
--     TO auth_verifier policy — so a non-superuser deployer saw zero rows and the
--     gate failed with "no live row", the opposite of what was wrong. The only
--     way to make it pass was to deploy with BYPASSRLS and excuse that role,
--     waiving this file's most important assertion. It needs auth_key_health(),
--     which is in migration 0003. Until that merges, a deploy with no live key
--     fails at the first login attempt rather than here.

\echo 'deploy checks passed (PARTIAL GATE — see ADR-0007; must be closed before G1).'
