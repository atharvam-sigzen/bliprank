-- Deploy-time tenancy assertions. Run against the target database AFTER login
-- roles have been created and granted, as the final step of a deploy:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/scripts/check-deploy.sql
--
-- or `pnpm --filter @bliprank/db db:check`. Any assertion raises, psql exits
-- non-zero, and the deploy fails.
--
-- THE DEPLOY ROLE MUST BE A MEMBER OF `deploy_check`:
--
--   GRANT deploy_check TO <the role that runs this>;
--
-- and it must NOT need to be a superuser, a member of auth_verifier, or hold
-- BYPASSRLS. That was the previous contradiction: the gate read
-- auth_signing_keys directly, which FORCEs RLS, so the only posture in which it
-- passed was one that waived its own most important assertion.
--
-- WHY THIS FILE IS NOW SHORT.
--
-- Four independent audits found four BLOCKERs here, and three of them were the
-- same bug: an assertion that names an ARRANGEMENT — a proxy, a role list,
-- pg_has_role USAGE, rolcanlogin, a function-name list, a relkind list, a
-- grantee name, the schema (nine times), the policy command. Each round
-- enumerated more shapes; each audit found a shape not enumerated. Proving "no
-- unsafe configuration exists" by listing unsafe configurations is unbounded by
-- construction.
--
-- The enumeration therefore moved into `tenancy_exposure_faults()` (migration
-- 0003), which inverts it: everything a non-trusted role can reach — every
-- schema, every relkind, every privilege, every SECURITY DEFINER function — must
-- be DECLARED in `tenancy_exposure_manifest`. Reachable-and-undeclared is the
-- failure condition, so a new schema, object kind, verb or grantee fails by
-- default instead of needing to be predicted.
--
-- What remains below is the part that genuinely is about specific named things:
-- role attributes, the context mechanism itself, and the signing keys.
--
-- The other half of the guarantee is behavioural, and lives in
-- `packages/db/src/tenant-isolation.test.ts`: two seeded tenants, real reads and
-- writes across every scoped relation, asserting the row sets are disjoint. A
-- policy that merely MENTIONS current_workspace_id passes a catalog check and
-- fails that one — `USING (current_workspace_id() IS NOT NULL)` returned both
-- tenants' rows while passing every static assertion here.

\echo 'checking role exclusivity, RLS-bypassing roles, and superusers...'
SELECT assert_role_exclusivity();

-- Membership in a predefined role confers power that never appears in a table
-- ACL, so no amount of privilege derivation can see it. pg_execute_server_program
-- is arbitrary command execution as the database OS user.
\echo 'checking no role holds server-level powers...'
SELECT assert_role_powers();

\echo 'checking every reachable object is declared in the exposure manifest...'
DO $$
DECLARE faults text;
BEGIN
  SELECT string_agg(format('[%s] %s', kind, detail), E'\n  ' ORDER BY kind, detail)
    INTO faults FROM tenancy_exposure_faults();
  IF faults IS NOT NULL THEN
    RAISE EXCEPTION E'tenancy exposure faults:\n  %', faults;
  END IF;
END $$;

-- The context mechanism itself. These name specific objects because they ARE
-- the objects the assertion is about, which the rule permits.
\echo 'checking the context readers exist and are definer-owned...'
DO $$
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

-- Signing keys, read through a definer helper that returns counts.
--
-- Reading the table directly was a contradiction: it FORCEs RLS with a single
-- TO auth_verifier policy — the point of the design — so a non-superuser
-- deployer saw zero rows and the gate failed with "no live row", which is the
-- opposite of what was wrong. The only way to make it pass was to deploy with
-- BYPASSRLS and excuse that role, waiving the most important assertion here.
\echo 'checking every live signing key is fully configured...'
DO $$
DECLARE h record;
BEGIN
  SELECT * INTO h FROM auth_key_health();
  IF NOT h.constraint_present THEN
    RAISE EXCEPTION 'the auth_signing_keys_live_is_configured constraint has been dropped; live keys are unconstrained';
  END IF;
  IF h.misconfigured > 0 THEN
    RAISE EXCEPTION '% live signing key(s) are not fully configured and will verify tokens. Retire or rotate them.', h.misconfigured;
  END IF;
  IF h.live_keys = 0 THEN
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

-- Say what was waived. A deliberate decision that leaves no trace in the
-- artefact recording it is not a deliberate decision.
\echo 'RLS-bypass roles excused by bliprank.rls_bypass_allowed:'
SELECT coalesce(nullif(coalesce(current_setting('bliprank.rls_bypass_allowed', true), ''), ''), '(none)') AS excused;

\echo 'deploy checks passed.'
