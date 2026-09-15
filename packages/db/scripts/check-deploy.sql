-- Deploy-time tenancy assertions. Run against the target database AFTER login
-- roles have been created and granted, as the final step of a deploy:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/scripts/check-deploy.sql
--
-- or `pnpm --filter @bliprank/db db:check`. Any assertion below raises, psql
-- exits non-zero, and the deploy fails.
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
-- WHY THIS EXISTS. Migration 0000 asserted role exclusivity in the test suite,
-- which proves it about a fixture database and nothing whatsoever about the
-- database customers are on. Login roles are created at deploy time, outside
-- any migration, so this cannot be a constraint — it has to be a check that
-- runs where the roles actually are. A bad GRANT should fail the deploy, not
-- sit undetected until it is a breach.
--
-- THE GATE IS CLOSED (ADR-0007; closed on main 2026-09-09, merged into this
-- lineage 2026-09-15 as migration 0008). Four independent audits found four
-- BLOCKERs in the expanded version of this file, and three were the same bug:
-- an assertion that names an ARRANGEMENT — a proxy, a role list, `pg_has_role`
-- USAGE, `rolcanlogin`, a function-name list, a relkind list, a grantee name,
-- the schema, the policy command. Each round enumerated more shapes and each
-- audit found a shape not enumerated. Proving "no unsafe configuration exists"
-- by listing unsafe configurations is unbounded by construction.
--
-- So the file holds TWO derivations, and neither is a list of unsafe shapes:
--
--   * the exposure manifest (`tenancy_exposure_faults()`, migration 0008)
--     inverts the question for every privilege: everything a non-trusted role
--     can reach — every schema, every relkind, every verb, every sequence,
--     every SECURITY DEFINER function — must be DECLARED in
--     `tenancy_exposure_manifest` with a disposition. Reachable-and-undeclared
--     is the failure condition, so a new schema, object kind, verb or grantee
--     fails by default instead of needing to be predicted;
--   * the inverse over what the tenant can READ (B3r item 3, at the foot):
--     every relation any role a tenant session can act as may SELECT is on the
--     shared allowlist or carries a read policy that scopes on the context in
--     the expression that governs its verb, `with_check` included — a second
--     witness that starts from reachability and never from a declaration, so a
--     declaration that lies is still refused;
--
-- plus the derivation over definer BODIES (every function that writes
-- workspace state takes its workspace from the context and, for a decision,
-- reads the role), the migration record, and the parts that genuinely are
-- about specific named things: role attributes, the context mechanism itself,
-- and the signing keys.
--
-- The other half of the guarantee is behavioural and lives in
-- `packages/db/src/tenant-isolation.test.ts`: two seeded tenants, real reads and
-- writes across every scoped relation, asserting the row sets are disjoint. A
-- policy that merely MENTIONS current_workspace_id passes any catalog check and
-- fails that one — `USING (current_workspace_id() IS NOT NULL)` returned both
-- tenants' rows while passing every static assertion ever written here.

\echo 'checking role exclusivity, RLS-bypassing roles, and superusers...'
SELECT assert_role_exclusivity();

-- Membership in a predefined role confers power that never appears in a table
-- ACL, so no amount of privilege derivation can see it. pg_execute_server_program
-- is arbitrary command execution as the database OS user; REPLICATION streams
-- the WAL, on which RLS is never consulted.
\echo 'checking no role holds server-level powers...'
SELECT assert_role_powers();

\echo 'checking every reachable object is declared in the exposure manifest...'
DO $do$
DECLARE faults text;
BEGIN
  SELECT string_agg(format('[%s] %s', kind, detail), E'\n  ' ORDER BY kind, detail)
    INTO faults FROM tenancy_exposure_faults();
  IF faults IS NOT NULL THEN
    RAISE EXCEPTION E'tenancy exposure faults:\n  %', faults;
  END IF;
END $do$;

-- Every table in public must have RLS enabled AND forced. ENABLE alone does not
-- bind the table owner, and migrations run as the owner. The manifest holds
-- the same obligation over every DESCENDANT of a scoped declaration, in any
-- schema (`scoped-without-forced-rls`); this sweep is kept as the second line
-- for a public table nobody declared and nobody can yet reach.
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
-- actually closes the hole is the bare-GUC one further down. And since the
-- manifest runs first, this arrangement is now caught there as
-- `[definer-function-exposed] set_workspace(uuid) is executable by app_rw`
-- before this line is reached (measured at main's merge, 2026-09-09): the
-- manifest DERIVED a fault nobody enumerated, which is ADR-0007's thesis
-- demonstrated. Known-redundant, kept as the second line for the case where a
-- declaration lies.
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

-- Signing keys, read through a definer helper that returns counts.
--
-- Reading the table directly was a contradiction: it FORCEs RLS with a single
-- TO auth_verifier policy — the point of the design — so a non-superuser
-- deployer saw zero rows and the gate failed with "no live row", which is the
-- opposite of what was wrong. The only way to make it pass was to deploy with
-- BYPASSRLS and excuse that role, waiving the most important assertion here.
-- `auth_key_health()` (migration 0008) returns counts only; no secret material
-- crosses the boundary.
\echo 'checking every live signing key is fully configured...'
DO $do$
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

-- THE ROLE CHECK IS DERIVED, NOT ASSUMED (B3c tenancy audit, MAJOR 1; the
-- holes the oversight pass named closed by B3d item 3). The allowlist below
-- says which definer doors an application role may open; it says nothing
-- about what their bodies enforce, so a CREATE OR REPLACE that dropped one
-- line of ws_put_document would pass it. So this runs FIRST, and over every
-- SECURITY DEFINER function in public — whoever owns it, whoever may call
-- it, since an owner always may — whose body touches one of the 0004 state
-- tables, and holds it to three rules read from its source:
--   - dynamic SQL (EXECUTE) against those tables cannot be derived from and
--     is refused outright, checks in the body or not;
--   - a writer (INSERT, UPDATE or DELETE, schema-qualified or quoted or
--     neither) takes its workspace from ws_required();
--   - a writer of a DECISION — any write of workspace_documents, an UPDATE
--     of workspace_requests, an INSERT into workspace_requests that names a
--     status — reads current_workspace_role() (0005; 0006 narrows what that
--     check refuses, not where it is read).
-- Filing a request and filing a cycle are not decisions. A substring is not
-- a semantics; the behavioural proof is workspace-state.test.ts, but a
-- writer that cannot even name the check is refused at deploy.
--
-- Widened after the B3d tenancy audit (2026-09-15, MAJOR 1 and MINORs 2, 3):
-- every FUNCTION in a non-catalog schema, definer or not, since an invoker
-- helper called from a definer runs as svc_onboard; MERGE, ONLY, TRUNCATE
-- and COPY are writes; an INSERT or MERGE that can land a status (an ON
-- CONFLICT that sets it, a column list that names it, a MERGE into
-- requests) is a decision; an updatable view over the three tables is a
-- door the source of no function names, and is refused; the three tables
-- must exist, so a rename cannot empty the check; every definer in public
-- pins search_path, or the checks it names resolve to whatever the caller
-- put first; and ws_put_document's one exemption from the role check is
-- pinned to its text, so a CREATE OR REPLACE that widened it fails here.
\echo 'checking every function that touches workspace state: no dynamic SQL, its workspace from the context, the role for a decision, no writable view, every definer pinned...'
DO $do$
DECLARE
  bad  text;
  -- the three state tables, schema-qualified or quoted or neither, as whole words
  tbl  constant text := '(public\.)?"?workspace_(cycles|documents|requests)\M"?';
  doc  constant text := '(public\.)?"?workspace_documents\M"?';
  req  constant text := '(public\.)?"?workspace_requests\M"?';
  verb constant text := '(insert\s+into|update|delete\s+from|merge\s+into|truncate(\s+table)?|copy)\s+(only\s+)?';
  src  text;
BEGIN
  IF to_regclass('public.workspace_cycles') IS NULL OR to_regclass('public.workspace_documents') IS NULL OR to_regclass('public.workspace_requests') IS NULL THEN
    RAISE EXCEPTION 'the workspace state tables this derivation covers are missing: renamed or dropped without updating check-deploy.sql';
  END IF;

  SELECT string_agg(sig, ', ' ORDER BY sig) INTO bad FROM (
    SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND p.prosrc ~* 'workspace_(cycles|documents|requests)'
       AND p.prosrc ~* '\mexecute\M'
  ) f;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'functions running dynamic SQL against workspace state cannot be derived from and are refused: %', bad;
  END IF;

  SELECT string_agg(sig, ', ' ORDER BY sig) INTO bad FROM (
    SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND p.prosrc ~* (verb || tbl)
       AND (p.prosrc NOT LIKE '%ws_required()%'
            OR (p.prosrc ~* (verb || doc
                             || '|(update|merge\s+into)\s+(only\s+)?' || req
                             || '|insert\s+into\s+(only\s+)?' || req || '\s*\([^)]*\mstatus\M'
                             || '|on\s+conflict[^;]*\mstatus\M')
                AND p.prosrc NOT LIKE '%current_workspace_role()%'))
  ) f;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'functions writing workspace state without ws_required() or, for a decision, current_workspace_role(): %', bad;
  END IF;

  SELECT string_agg(c.oid::regclass::text, ', ' ORDER BY 1) INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'v' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND pg_relation_is_updatable(c.oid, true) <> 0
     AND EXISTS (SELECT 1 FROM pg_rewrite r
                   JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid AND d.refclassid = 'pg_class'::regclass
                   JOIN pg_class t ON t.oid = d.refobjid
                  WHERE r.ev_class = c.oid AND t.relnamespace = 'public'::regnamespace
                    AND t.relname IN ('workspace_cycles', 'workspace_documents', 'workspace_requests'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'an updatable view over workspace state is a door no function names, and is refused: %', bad;
  END IF;

  SELECT string_agg(sig, ', ' ORDER BY sig) INTO bad FROM (
    SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND n.nspname = 'public'
       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) AS c WHERE c ~ '^search_path=\s*public\s*,\s*pg_temp\s*$')
  ) f;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER functions in public that do not pin search_path to public, pg_temp: %', bad;
  END IF;

  SELECT p.prosrc INTO src FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.oid::regprocedure::text = 'ws_put_document(text,text,jsonb,integer)';
  IF src IS NULL OR src !~ $re$IF NOT \(p_kind = 'category-record' AND next_version = 1\) AND coalesce\(role, ''\) NOT IN \('owner', 'admin'\) THEN$re$ THEN
    RAISE EXCEPTION 'ws_put_document exempts from the role check something other than version 1 of a category record (migration 0006), or is missing';
  END IF;
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
--
-- The manifest's `definer-function-exposed` sweep (0008) holds the SAME list,
-- over every role there is — login roles and PUBLIC included, not only the
-- three application groups named here — and runs first, so an undeclared
-- definer is named there before this line is reached. Two copies of one list
-- cannot drift silently: a definer added to one and not the other fails the
-- healthy database here or there. Kept as the second line (a merge is the
-- easiest place in the world to lose an assertion); consolidating the two into
-- one declaration is a follow-up for the tenancy owner, not a merge decision.
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
-- or applied a second file under a number it already holds, fails here. (The
-- exposure manifest arrived on main as a second 0003; it is 0008 in this
-- lineage, and the index is what made applying it under the old number
-- impossible rather than merely noticed.) The list on disk is the migrations
-- directory; the record is its applied prefix, and
-- packages/db/src/migrations.test.ts asserts the two agree on a full apply
-- (MVP_PLAN B3r, item 4).
--
-- The record is read through migration_record() (0008), not the table: the
-- table is FORCE RLS with one policy naming the migration owner and no grant to
-- anyone else, and the deploy principal is a member of deploy_check that owns
-- nothing. Read directly, that principal got `permission denied for table
-- schema_migrations` and could not run the gate at all (measured, C0 audit);
-- read through the definer it can, and an empty record is refused rather than
-- passed over.
\echo 'checking the migration record is present, indexed by number and gapless...'
DO $do$
DECLARE bad text; n integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations is missing: migration 0003 was never applied here, or the record was dropped';
  END IF;
  SELECT count(*) INTO n FROM migration_record();
  IF n = 0 THEN
    RAISE EXCEPTION 'the migration record is empty: migration_record() returned no rows, so either nothing was applied or this principal cannot read the record';
  END IF;
  SELECT string_agg(name, ', ' ORDER BY name) INTO bad
    FROM (SELECT name, left(name, 4)::int AS num, row_number() OVER (ORDER BY name) - 1 AS expected FROM migration_record()) s
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
--
-- A VIEW the tenant can read is refused here, security_invoker or not: it
-- carries no policy of its own, so nothing in the catalog says its rows are
-- scoped. The manifest accepts a DECLARED security_invoker view
-- (`scoped-view-not-invoker` is the fault for the other kind); this inverse
-- does not yet, and fails closed. Teaching it that an invoker view inherits
-- its base tables' scoping is a decision for the tenancy owner, recorded at
-- the merge (2026-09-15), not made here.
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
       -- the shared-corpus allowlist: read in full by every tenant, by decision.
       -- The manifest declares the same relation `shared` with its column list;
       -- tenant-isolation.test.ts holds the two allowlists to each other.
       AND ns.nspname || '.' || c.relname <> ALL (ARRAY['public.prompt_banks'])
  ) x WHERE why IS NOT NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'tenant-readable relations that are neither shared nor scoped: %', bad;
  END IF;
END $do$;

-- Say what was waived. A deliberate decision that leaves no trace in the
-- artefact recording it is not a deliberate decision.
-- READ THIS LINE IN THE DEPLOY LOG. `(none)` is the expected output in
-- production. Anything else is a role that reads every tenant's rows, and is
-- either a decision recorded under docs/runbooks/deploying-the-database.md §1
-- or a decision nobody made. There is no third case.
--
-- The exception this allowlist silences offers naming a role as one of its two
-- remedies, and at 2am that is much easier than removing the attribute. The
-- runbook exists for that moment.
\echo 'RLS-bypass roles excused by bliprank.rls_bypass_allowed:'
SELECT coalesce(nullif(coalesce(current_setting('bliprank.rls_bypass_allowed', true), ''), ''), '(none)') AS excused;

\echo 'deploy checks passed.'
