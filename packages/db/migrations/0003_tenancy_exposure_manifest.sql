-- 0003_tenancy_exposure_manifest — the deploy gate stops asking "is anything
-- wrong?" and starts asking "is everything reachable on the approved list?"
--
-- HUMAN-OWNED (CLAUDE.md §4: RLS policies and the tenancy model).
--
-- WHY THIS EXISTS, AND WHY IT IS NOT ANOTHER PATCH.
--
-- Four independent audits have now found the same bug in check-deploy.sql, and
-- it was fixed three times without the fix holding:
--
--   1. it asserted a PROXY (EXECUTE on set_workspace) for a property (can the
--      tenant name a workspace);
--   2. it asserted the property against a hardcoded list of three ROLES;
--   3. it named an ARRANGEMENT in five places — pg_has_role USAGE (blind to
--      NOINHERIT), rolcanlogin (blind to BYPASSRLS on a NOLOGIN role), a
--      five-name function list, relkind IN ('r','p') (blind to views), and the
--      literal grantee 'app_rw';
--   4. it named the SCHEMA, nine times, and the policy COMMAND — so a table in
--      a new schema with no RLS at all passed, and so did FOR DELETE USING
--      (true) and a TRUNCATE grant, both of which destroy another tenant's rows
--      from a fully authenticated session.
--
-- Each round enumerated more shapes; each audit found a shape not enumerated.
-- That is not bad luck. Proving "no unsafe configuration exists" by listing
-- unsafe configurations is unbounded by construction: the catalog can always
-- express one more thing than the list.
--
-- The bounded form is the inverse. Enumerate everything a non-trusted role can
-- reach — every schema, every relkind, every privilege — and require each to be
-- DECLARED here with a disposition and a reason. A new schema, a new object
-- kind, a new verb, a grant to a login role nobody thought of: all fail by
-- default, because the failure condition is "reachable and undeclared" rather
-- than "matches one of the shapes we listed".
--
-- This does not replace the row-level checks, which still catch a declared-
-- scoped table whose policy does not actually scope. It replaces the part that
-- kept being incomplete.

-- ---------------------------------------------------------------------------
-- 1. The manifest
-- ---------------------------------------------------------------------------

CREATE TABLE tenancy_exposure_manifest (
  schema_name text NOT NULL,
  relation    text NOT NULL,
  privilege   text NOT NULL CHECK (privilege IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','USAGE')),
  -- scoped  : tenant-reachable, and every policy on it must bound rows by the
  --           tenant context. Behavioural isolation is asserted in the suite.
  -- shared   : deliberately visible to every tenant. Adding one is a tenancy
  --           decision and should be reviewed as one.
  -- service  : reachable only by a trusted service role, never by a tenant.
  disposition text NOT NULL CHECK (disposition IN ('scoped','shared','service')),
  reason      text NOT NULL CHECK (length(reason) > 0),
  PRIMARY KEY (schema_name, relation, privilege)
);
-- RLS is enabled at the FOOT of this file, after the seed rows. FORCE binds the
-- owner and the only policy is TO auth_verifier, so enabling it here would make
-- the migration unable to write its own manifest — on PGlite it would pass
-- anyway, the owner being a superuser, which is precisely the kind of thing that
-- passes for a weaker reason than production.

INSERT INTO tenancy_exposure_manifest (schema_name, relation, privilege, disposition, reason) VALUES
  ('public','workspaces',             'SELECT','scoped', 'a workspace sees itself'),
  ('public','workspace_members',      'SELECT','scoped', 'a workspace sees its own members'),
  ('public','workspace_brands',       'SELECT','scoped', 'a workspace sees its own entitlements'),
  ('public','workspace_subscriptions','SELECT','scoped', 'a workspace sees its own plan'),
  ('public','accounts',               'SELECT','scoped', 'co-members of the current workspace only'),
  ('public','brands',                 'SELECT','scoped', 'entitled brands only; an unentitled brand is invisible'),
  ('public','score_rows',             'SELECT','scoped', 'filtered join through workspace_brands'),
  ('public','score_aggregates',       'SELECT','scoped', 'filtered join through workspace_brands'),
  ('public','prompt_banks',           'SELECT','shared', 'category-keyed reference data with no tenant column; private banks go in a separate RLS table (0000)'),
  -- The scorer and onboarding services. Declared so the surface is complete,
  -- not because a tenant can reach them.
  ('public','score_rows',             'INSERT','service','svc_scorer appends the corpus'),
  ('public','score_aggregates',       'INSERT','service','svc_scorer appends rollups'),
  ('public','accounts',               'INSERT','service','svc_onboard writes identity'),
  ('public','accounts',               'UPDATE','service','svc_onboard writes identity'),
  ('public','accounts',               'DELETE','service','svc_onboard writes identity'),
  ('public','workspaces',             'INSERT','service','svc_onboard writes identity'),
  ('public','workspaces',             'UPDATE','service','svc_onboard writes identity'),
  ('public','workspaces',             'DELETE','service','svc_onboard writes identity'),
  ('public','workspace_members',      'INSERT','service','svc_onboard writes identity'),
  ('public','workspace_members',      'UPDATE','service','svc_onboard writes identity'),
  ('public','workspace_members',      'DELETE','service','svc_onboard writes identity'),
  ('public','workspace_brands',       'INSERT','service','svc_onboard grants entitlements, behind the billing gate'),
  ('public','workspace_brands',       'UPDATE','service','svc_onboard moves entitlements, behind the billing gate'),
  ('public','workspace_brands',       'DELETE','service','svc_onboard revokes entitlements'),
  ('public','workspace_subscriptions','INSERT','service','svc_onboard writes billing state'),
  ('public','workspace_subscriptions','UPDATE','service','svc_onboard writes billing state'),
  ('public','workspace_subscriptions','DELETE','service','svc_onboard writes billing state'),
  ('public','brands',                 'INSERT','service','svc_onboard curates the brand set'),
  ('public','brands',                 'UPDATE','service','svc_onboard curates the brand set'),
  ('public','prompt_banks',           'INSERT','service','svc_onboard curates prompt banks'),
  ('public','prompt_banks',           'UPDATE','service','svc_onboard curates prompt banks');

-- The partitions inherit the parent's exposure. Enumerated rather than special-
-- cased, so a new month provisioned by ensure_score_partition() is declared too.
INSERT INTO tenancy_exposure_manifest (schema_name, relation, privilege, disposition, reason)
SELECT 'public', c.relname, p.priv, CASE WHEN p.priv = 'SELECT' THEN 'scoped' ELSE 'service' END,
       'partition of score_rows; carries its own FORCE RLS and entitlement policy'
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 CROSS JOIN unnest(ARRAY['SELECT','INSERT']) AS p(priv)
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p')   -- relations, not their indexes
   AND c.relname LIKE 'score\_rows\_%';

-- ---------------------------------------------------------------------------
-- 2. The assertion
-- ---------------------------------------------------------------------------

-- Definer-owned, because it reads the manifest, which no application role can.
-- It returns a fault list rather than raising, so check-deploy.sql can report
-- everything at once instead of one line per deploy attempt.
CREATE OR REPLACE FUNCTION tenancy_exposure_faults()
RETURNS TABLE(kind text, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  -- Reachable but undeclared. The subject is derived three ways at once — every
  -- schema, every relation kind, every privilege — so nothing here names an
  -- arrangement. `pg_%` roles are Postgres's own; auth_verifier is the trusted
  -- owner; superusers bypass RLS entirely and are asserted separately.
  FOR r IN
    SELECT DISTINCT ns.nspname, c.relname, p.priv, g.rolname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES']) AS p(priv)
     CROSS JOIN LATERAL (
       SELECT rolname FROM pg_roles
        WHERE rolname NOT LIKE 'pg\_%' AND rolname <> 'auth_verifier' AND NOT rolsuper
       UNION ALL SELECT 'public'
     ) g
     WHERE ns.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
       AND ns.nspname NOT LIKE 'pg\_temp%' AND ns.nspname NOT LIKE 'pg\_toast%'
       AND c.relkind IN ('r','p','v','m','f')
       AND has_table_privilege(g.rolname, c.oid, p.priv)
       AND NOT EXISTS (
         SELECT 1 FROM tenancy_exposure_manifest m
          WHERE m.schema_name = ns.nspname AND m.relation = c.relname AND m.privilege = p.priv)
  LOOP
    kind := 'undeclared-exposure';
    detail := format('%s.%s %s is reachable by %s and is not in the manifest', r.nspname, r.relname, r.priv, r.rolname);
    RETURN NEXT;
  END LOOP;

  -- Column-level grants do not register in has_table_privilege. Same rule.
  FOR r IN
    SELECT DISTINCT ns.nspname, c.relname, p.priv, g.rolname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS p(priv)
     CROSS JOIN LATERAL (
       SELECT rolname FROM pg_roles
        WHERE rolname NOT LIKE 'pg\_%' AND rolname <> 'auth_verifier' AND NOT rolsuper
       UNION ALL SELECT 'public'
     ) g
     WHERE ns.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
       AND ns.nspname NOT LIKE 'pg\_temp%' AND ns.nspname NOT LIKE 'pg\_toast%'
       AND c.relkind IN ('r','p','v','m','f')
       AND has_any_column_privilege(g.rolname, c.oid, p.priv)
       AND NOT EXISTS (
         SELECT 1 FROM tenancy_exposure_manifest m
          WHERE m.schema_name = ns.nspname AND m.relation = c.relname AND m.privilege = p.priv)
  LOOP
    kind := 'undeclared-exposure';
    detail := format('%s.%s %s (column-level) is reachable by %s and is not in the manifest', r.nspname, r.relname, r.priv, r.rolname);
    RETURN NEXT;
  END LOOP;

  -- Sequences leak volume, not rows — a competitor's insert count is still
  -- signal for an agency product.
  FOR r IN
    SELECT DISTINCT ns.nspname, c.relname, g.rolname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     CROSS JOIN LATERAL (
       SELECT rolname FROM pg_roles
        WHERE rolname NOT LIKE 'pg\_%' AND rolname <> 'auth_verifier' AND NOT rolsuper
       UNION ALL SELECT 'public'
     ) g
     WHERE ns.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
       AND c.relkind = 'S'
       AND (has_sequence_privilege(g.rolname, c.oid, 'SELECT') OR has_sequence_privilege(g.rolname, c.oid, 'USAGE'))
       AND NOT EXISTS (
         SELECT 1 FROM tenancy_exposure_manifest m
          WHERE m.schema_name = ns.nspname AND m.relation = c.relname AND m.privilege = 'USAGE')
  LOOP
    kind := 'undeclared-exposure';
    detail := format('sequence %s.%s is readable by %s and is not in the manifest', r.nspname, r.relname, r.rolname);
    RETURN NEXT;
  END LOOP;

  -- TRUNCATE can never be scoped: RLS does not apply to it in any form, so a
  -- grant is unconditional destruction of every tenant's rows. Declared or not.
  FOR r IN
    SELECT DISTINCT ns.nspname, c.relname, g.rolname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     CROSS JOIN LATERAL (
       SELECT rolname FROM pg_roles
        WHERE rolname NOT LIKE 'pg\_%' AND rolname NOT IN ('auth_verifier','svc_scorer','svc_onboard') AND NOT rolsuper
       UNION ALL SELECT 'public'
     ) g
     WHERE ns.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
       AND c.relkind IN ('r','p') AND has_table_privilege(g.rolname, c.oid, 'TRUNCATE')
  LOOP
    kind := 'truncate-granted';
    detail := format('%s.%s TRUNCATE is held by %s; no policy can restrain TRUNCATE', r.nspname, r.relname, r.rolname);
    RETURN NEXT;
  END LOOP;

  -- A declared-scoped relation must carry RLS, forced, with at least one policy,
  -- and EVERY policy on it — for every command, including DELETE, which the
  -- previous gate never swept — must mention the tenant context. Mentioning it
  -- is necessary and not sufficient; the suite asserts the row sets behave.
  FOR r IN
    SELECT m.schema_name, m.relation FROM tenancy_exposure_manifest m WHERE m.disposition = 'scoped'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = r.schema_name AND c.relname = r.relation
         AND c.relrowsecurity AND c.relforcerowsecurity)
    THEN
      kind := 'scoped-without-forced-rls';
      detail := format('%s.%s is declared scoped but does not FORCE row level security', r.schema_name, r.relation);
      RETURN NEXT;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_policies pol
       WHERE pol.schemaname = r.schema_name AND pol.tablename = r.relation
         AND (pol.roles = '{public}' OR NOT EXISTS (
               SELECT 1 FROM unnest(pol.roles) rr WHERE rr::text IN ('svc_scorer','svc_onboard','auth_verifier')))
         AND coalesce(pol.qual, '') || coalesce(pol.with_check, '') NOT LIKE '%current_workspace_id%')
    THEN
      kind := 'scoped-policy-unbounded';
      detail := format('%s.%s has a tenant-facing policy that never mentions current_workspace_id', r.schema_name, r.relation);
      RETURN NEXT;
    END IF;
  END LOOP;

  -- A declared-shared relation must have no column that could carry a tenant
  -- identity. Testing for a foreign key was tried and is not enough: a column
  -- can be `workspace_id uuid NOT NULL` with no constraint, which is exactly
  -- how prompt_banks acquired two tenants' private banks while passing.
  FOR r IN
    SELECT m.schema_name, m.relation, a.attname
      FROM tenancy_exposure_manifest m
      JOIN pg_class c ON c.relname = m.relation
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = m.schema_name
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE m.disposition = 'shared'
       AND (a.attname ~ '(workspace|account|tenant|customer|client)'
            OR EXISTS (SELECT 1 FROM pg_constraint fk
                        WHERE fk.conrelid = c.oid AND fk.contype = 'f'
                          AND a.attnum = ANY (fk.conkey)))
  LOOP
    kind := 'shared-with-tenant-column';
    detail := format('%s.%s is declared shared but column %s can carry a tenant identity', r.schema_name, r.relation, r.attname);
    RETURN NEXT;
  END LOOP;

  -- Manifest rows for objects that no longer exist. A stale manifest is a
  -- manifest nobody is reading.
  FOR r IN
    SELECT m.schema_name, m.relation FROM tenancy_exposure_manifest m
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = m.schema_name AND c.relname = m.relation)
  LOOP
    kind := 'stale-manifest-row';
    detail := format('%s.%s is in the manifest but does not exist', r.schema_name, r.relation);
    RETURN NEXT;
  END LOOP;

  -- SECURITY DEFINER functions, in EVERY schema. The previous check pinned
  -- public, so the same helper one schema over returned the signing secret.
  FOR r IN
    SELECT ns.nspname, p.oid::regprocedure::text AS sig, o.rolname AS owner,
           EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) cf WHERE cf LIKE 'search\_path=%') AS pinned
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
      JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.prosecdef AND ns.nspname NOT IN ('pg_catalog','information_schema')
  LOOP
    IF r.owner <> 'auth_verifier' OR NOT r.pinned THEN
      kind := 'definer-function-unsafe';
      detail := format('%s (owner %s, search_path %s)', r.sig, r.owner, CASE WHEN r.pinned THEN 'pinned' ELSE 'UNPINNED' END);
      RETURN NEXT;
    END IF;
  END LOOP;

  -- PUBLIC must not be able to create objects in any schema the model depends
  -- on: that is the remaining assumption behind `SET search_path = public`.
  -- Derived from the manifest, so a schema added to it is covered automatically.
  -- Lives here rather than in check-deploy.sql because it reads the manifest,
  -- which the deploy role cannot — the same contradiction that made the gate
  -- require a BYPASSRLS deployer.
  FOR r IN
    SELECT DISTINCT sch FROM (
      SELECT schema_name AS sch FROM tenancy_exposure_manifest
      UNION SELECT 'public'
    ) x WHERE has_schema_privilege('public', sch, 'CREATE')
  LOOP
    kind := 'public-can-create';
    detail := format('PUBLIC has CREATE on schema %s; a definer function''s search_path can be shadowed', r.sch);
    RETURN NEXT;
  END LOOP;

  FOR r IN
    SELECT ns.nspname || '.' || p.oid::regprocedure::text AS sig, g.rolname
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     CROSS JOIN LATERAL (
       SELECT rolname FROM pg_roles
        WHERE rolname NOT LIKE 'pg\_%' AND rolname <> 'auth_verifier' AND NOT rolsuper
       UNION ALL SELECT 'public'
     ) g
     WHERE p.prosecdef AND ns.nspname NOT IN ('pg_catalog','information_schema')
       -- DEFAULT-DENY: the intended surface, by name. A new definer function is
       -- refused the day it is written, which is the opposite of the list that
       -- said "check only these five" and left the sixth unexamined.
       AND NOT (ns.nspname = 'public' AND p.oid::regprocedure::text IN (
              'set_workspace_jwt(text)', 'current_workspace_id()', 'current_account_id()',
              'auth_key_health()', 'tenancy_exposure_faults()'))
       AND has_function_privilege(g.rolname, p.oid, 'EXECUTE')
  LOOP
    kind := 'definer-function-exposed';
    detail := format('%s is executable by %s', r.sig, r.rolname);
    RETURN NEXT;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Key health, readable by a deployer that is not a superuser
-- ---------------------------------------------------------------------------

-- The gate read auth_signing_keys directly. That table FORCEs RLS with a single
-- TO auth_verifier policy — the entire point of the design — so on the
-- production posture the design prescribes, a non-superuser deployer sees ZERO
-- rows and the gate fails with "no live row", which is the opposite of what is
-- wrong. The only way to make it pass was to run the deploy with BYPASSRLS and
-- excuse that role, waiving the single most important assertion in the file.
--
-- Counts only. No secret material crosses this boundary, so it is safe to
-- expose, and it is in the default-deny allowlist above.
CREATE OR REPLACE FUNCTION auth_key_health()
RETURNS TABLE(live_keys integer, misconfigured integer, constraint_present boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    (SELECT count(*)::int FROM auth_signing_keys WHERE retired_at IS NULL OR retired_at > now()),
    (SELECT count(*)::int FROM auth_signing_keys
      WHERE (retired_at IS NULL OR retired_at > now())
        AND NOT (length(kid) > 0 AND length(secret) >= 32
                 AND issuer IS NOT NULL AND length(issuer) > 0
                 AND audience IS NOT NULL AND length(audience) > 0
                 AND max_lifetime_s BETWEEN 60 AND 604800)),
    (SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_signing_keys_live_is_configured'))
$$;

-- ---------------------------------------------------------------------------
-- 4. Ownership and grants
-- ---------------------------------------------------------------------------

ALTER TABLE tenancy_exposure_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy_exposure_manifest FORCE  ROW LEVEL SECURITY;
GRANT SELECT ON tenancy_exposure_manifest TO auth_verifier;
CREATE POLICY manifest_verifier_only ON tenancy_exposure_manifest FOR ALL TO auth_verifier USING (true) WITH CHECK (true);

DO $$ BEGIN EXECUTE format('GRANT auth_verifier TO %I', current_user); END $$;

ALTER FUNCTION tenancy_exposure_faults() OWNER TO auth_verifier;
ALTER FUNCTION auth_key_health()          OWNER TO auth_verifier;
ALTER TABLE    tenancy_exposure_manifest  OWNER TO auth_verifier;

-- Both are EXECUTE-to-PUBLIC, deliberately. They must be callable by a deploy
-- role that is NOT a member of auth_verifier — that was the contradiction in the
-- previous gate, which could only pass if the deployer bypassed RLS, waiving the
-- one assertion that matters most. Neither returns secret material or tenant
-- data: auth_key_health() returns three counts, and tenancy_exposure_faults()
-- returns configuration facts a role can already read out of the catalog for
-- objects it holds privileges on. Both are in the default-deny allowlist above.
GRANT EXECUTE ON FUNCTION auth_key_health()          TO PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy_exposure_faults()  TO PUBLIC;

-- Same reason: the deploy role must be able to run the gate without being a
-- member of auth_verifier and without bypassing RLS. assert_role_exclusivity()
-- is invoker-rights and reads only pg_roles and pg_auth_members, which Postgres
-- makes world-readable regardless, so this grants no visibility a caller does
-- not already have.
GRANT EXECUTE ON FUNCTION assert_role_exclusivity()  TO PUBLIC;

DO $$ BEGIN EXECUTE format('REVOKE auth_verifier FROM %I', current_user); END $$;
