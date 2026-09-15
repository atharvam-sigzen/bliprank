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
    FROM unnest(ARRAY['current_workspace_id()', 'current_account_id()', 'current_workspace_role()',
                      'stamp_tenant_context(uuid,uuid,text)', 'set_workspace_jwt(text)', 'set_workspace(uuid)']) AS sig
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
    -- 0002: the context readers (PUBLIC) and the verifier (app_rw); 0005 adds the role reader
    'current_workspace_id()', 'current_account_id()', 'current_workspace_role()', 'set_workspace_jwt(text)',
    -- 0003: onboarding, owned by svc_onboard, app_rw only
    'ensure_account(uuid,text,text)', 'create_workspace(uuid,text)', 'workspaces_of(uuid)',
    -- 0004: workspace state writers, owned by svc_onboard, workspace from the verified context
    'ws_required()', 'ws_put_cycle(text,date,text,text,jsonb)', 'ws_put_document(text,text,jsonb,integer)',
    'ws_file_request(text,text,jsonb,timestamp with time zone)',
    'ws_resolve_request(text,text,timestamp with time zone,text,text,text)'
  ]);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'undeclared SECURITY DEFINER functions reachable by an application role: %', bad;
  END IF;
END $do$;

-- THE ROLE CHECK IS DERIVED, NOT ASSUMED (B3c tenancy audit, MAJOR 1). The
-- allowlist above says which definer doors exist; it says nothing about what
-- their bodies enforce, so a CREATE OR REPLACE that dropped one line of
-- ws_put_document would pass it. Here every SECURITY DEFINER function owned
-- by svc_onboard whose body writes one of the 0004 state tables must take
-- its workspace from ws_required(), and one that lands a DECISION — an
-- insert into workspace_documents, an update of workspace_requests — must
-- read current_workspace_role() (0005). Filing a request and filing a cycle
-- are not decisions and are not held to the role. A substring is not a
-- semantics; the behavioural proof is workspace-state.test.ts, but a writer
-- that cannot even name the check is refused at deploy.
\echo 'checking every definer writer of workspace state takes its workspace from the context and, for a decision, reads the role...'
DO $do$
DECLARE bad text;
BEGIN
  SELECT string_agg(sig, ', ' ORDER BY sig) INTO bad FROM (
    SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.prosecdef AND n.nspname = 'public' AND o.rolname = 'svc_onboard'
       AND p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+workspace_(cycles|documents|requests)\M'
       AND (p.prosrc NOT LIKE '%ws_required()%'
            OR (p.prosrc ~* '(insert\s+into\s+workspace_documents|update\s+workspace_requests)\M' AND p.prosrc NOT LIKE '%current_workspace_role()%'))
  ) f;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'definer writers of workspace state without ws_required() or, for a decision, current_workspace_role(): %', bad;
  END IF;
END $do$;

-- Migrations 0003 and 0004 grant the migration owner a writing group to
-- transfer function ownership and revoke it at the end. A failure between
-- the two leaves the owner a standing member with unbounded write on
-- identity and state, and exclusivity only fires at TWO groups. The owner
-- of the identity table is derived from the catalog and must be in neither
-- (2026-09-10 tenancy audit, m7).
\echo 'checking the migration owner is not left in a writing group...'
DO $do$
DECLARE bad text;
BEGIN
  SELECT string_agg(g.rolname, ', ' ORDER BY g.rolname) INTO bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_auth_members am ON am.member = c.relowner
    JOIN pg_roles g ON g.oid = am.roleid
   WHERE n.nspname = 'public' AND c.relname = 'accounts' AND g.rolname IN ('svc_onboard', 'auth_verifier');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'the owner of public.accounts is a member of %: a migration left its grant behind', bad;
  END IF;
END $do$;

-- The migration record (0003, section 0). One row per applied file, a unique
-- index on the four-digit number, and no gap: a database that skipped a file,
-- or applied a second file under a number it already holds (the unmerged
-- 0003_tenancy_exposure_manifest, if it were applied without renumbering),
-- fails here. The list on disk is the migrations directory; the record is its
-- applied prefix, and packages/db/src/migrations.test.ts asserts the two agree
-- on a full apply (MVP_PLAN B3r, item 4).
\echo 'checking the migration record is present, indexed by number and gapless...'
DO $do$
DECLARE bad text;
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations is missing: migration 0003 was never applied here, or the record was dropped';
  END IF;
  SELECT string_agg(name, ', ' ORDER BY name) INTO bad
    FROM (SELECT name, left(name, 4)::int AS num, row_number() OVER (ORDER BY name) - 1 AS expected FROM schema_migrations) s
   WHERE num <> expected;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'the migration record is not 0000..N with one file per number; out of sequence at: %', bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'schema_migrations'
                  AND indexname = 'schema_migrations_one_per_number' AND indexdef LIKE 'CREATE UNIQUE INDEX%') THEN
    RAISE EXCEPTION 'schema_migrations has lost its unique index on the migration number: two files with one number could both be applied';
  END IF;
END $do$;

-- THE INVERSE OVER WHAT THE TENANT CAN READ (oversight review 2026-09-10,
-- B3r item 3). Every relation — any schema, any relation kind, any column —
-- that app_rw or PUBLIC can SELECT is either on the shared-corpus allowlist
-- or carries at least one read policy for the tenant, and every policy the
-- tenant meets there scopes on current_workspace_id in the expression that
-- governs its verb: `qual` for rows read, updated or deleted, `with_check`
-- for rows written (which defaults to `qual` when absent). The earlier
-- derivations started from pg_policies and asked the policy whether it
-- needed checking, so `USING (true)` and a policy through a wrapper function
-- were never examined. A substring is still not a scope — the behavioural
-- proof is tenant-isolation.test.ts, whose subject is derived the same way —
-- but a policy that cannot even name the context is refused at deploy.
--
-- THE TENANT IS NOT THE NAME app_rw. Production connects as a login role that
-- is a MEMBER of app_rw (CLAUDE.md §7), created at deploy time outside any
-- migration, and app_rw may itself be granted a group. A grant or a policy
-- naming either side of that membership edge reaches a tenant session and
-- named only app_rw in this derivation, so it was invisible (B3r tenancy
-- audit, MAJOR). The subject is therefore every role a tenant session can act
-- as: app_rw, every role that is a member of it, and everything any of those
-- inherits — the same pg_has_role(…, 'MEMBER') edge assert_role_exclusivity
-- walks.
\echo 'checking every relation a tenant session can read is shared by declaration or scoped by every policy it meets...'
DO $do$
DECLARE bad text;
BEGIN
  CREATE TEMP TABLE tenant_roles ON COMMIT DROP AS
    SELECT r.oid, r.rolname FROM pg_roles r
     WHERE r.rolname NOT LIKE 'pg\_%' AND NOT r.rolsuper
       AND EXISTS (SELECT 1 FROM pg_roles l WHERE NOT l.rolsuper AND pg_has_role(l.oid, 'app_rw', 'MEMBER') AND pg_has_role(l.oid, r.oid, 'MEMBER'));
  SELECT string_agg(rel || ' (' || why || ')', '; ' ORDER BY rel) INTO bad FROM (
    SELECT ns.nspname || '.' || c.relname AS rel,
           CASE
             WHEN NOT EXISTS (SELECT 1 FROM pg_policies p
                               WHERE p.schemaname = ns.nspname AND p.tablename = c.relname
                                 AND p.cmd IN ('SELECT', 'ALL')
                                 AND (p.roles = '{public}' OR EXISTS (SELECT 1 FROM unnest(p.roles) pr JOIN tenant_roles t ON t.rolname = pr)))
               THEN 'no read policy for the tenant role'
             ELSE (SELECT string_agg('policy ' || p.policyname || ' does not scope on current_workspace_id', ', ' ORDER BY p.policyname)
                     FROM pg_policies p
                    WHERE p.schemaname = ns.nspname AND p.tablename = c.relname
                      AND (p.roles = '{public}' OR EXISTS (SELECT 1 FROM unnest(p.roles) pr JOIN tenant_roles t ON t.rolname = pr))
                      AND ((p.cmd IN ('SELECT', 'ALL', 'UPDATE', 'DELETE') AND coalesce(p.qual, '') NOT LIKE '%current_workspace_id%')
                        OR (p.cmd IN ('INSERT', 'ALL', 'UPDATE') AND coalesce(p.with_check, p.qual, '') NOT LIKE '%current_workspace_id%')))
           END AS why
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND (has_any_column_privilege('public', c.oid, 'SELECT')
            OR EXISTS (SELECT 1 FROM tenant_roles t WHERE has_any_column_privilege(t.oid, c.oid, 'SELECT')))
       -- the shared-corpus allowlist: read in full by every tenant, by decision
       AND ns.nspname || '.' || c.relname <> ALL (ARRAY['public.prompt_banks'])
  ) x WHERE why IS NOT NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'tenant-readable relations that are neither shared nor scoped: %', bad;
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
