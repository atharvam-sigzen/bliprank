-- 0008_tenancy_exposure_manifest — the deploy gate stops asking "is anything
-- wrong?" and starts asking "is everything reachable on the approved list?"
--
-- HUMAN-OWNED (CLAUDE.md §4: RLS policies and the tenancy model).
--
-- NUMBERING (MVP_PLAN C0, 2026-09-15). This file closed the tenancy deploy
-- gate on `main` as 0003 (ADR-0007, 2026-09-09). The `mvp/stage-a` lineage had
-- taken 0003 for accounts identity (B2) and 0004-0007 for workspace state, the
-- role claim, the member's first record and filing ownership, and B3r's record
-- (`schema_migrations`, section 0 of 0003) refuses a second file under a held
-- number before it changes anything. So this is 0008 here: it records itself
-- first, runs in ONE transaction like every file from 0003 on (migrations.test.ts
-- cuts it after its GRANT and proves the owner is left in no group), and its
-- declared surface is the lineage's, not main's: the three 0004 state tables
-- and their service writes are declared below, the SECURITY DEFINER rule names
-- the trusted service roles rather than auth_verifier alone (B2 owns the
-- onboarding and state definers by svc_onboard, deliberately), and the
-- tenant-callable definer list is the twelve check-deploy.sql already declares.
-- Section 4 gains migration_record() so the deploy principal this file
-- prescribes can still read the record. And from the tenancy audit of the
-- merge (docs/MVP_REVIEWS.md, row C0, MAJOR): a `service` row now names its
-- GRANTEE, and the reachability sweep matches on it, because matching any of
-- the three trusted roles let `GRANT INSERT ON workspace_documents TO
-- svc_scorer` pass the gate, and with a policy to match, the scorer wrote
-- another workspace's category record (measured, worktree, 2026-09-15). Main's
-- rows had the same coarseness on score_rows and score_aggregates. Nothing
-- else changed at the renumbering; the reasoning below is preserved as
-- written because it is why the design is right.
--
-- HUMAN REVIEW REQUIRED before this is applied anywhere: the renumbering, the
-- added rows, the grantee column, the two rule changes, and migration_record().
--
-- WHY THIS EXISTS, AND WHY IT IS NOT ANOTHER PATCH.
--
-- Five independent audits found the same bug in the deploy gate, and it was
-- fixed four times without the fix holding:
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
--      (true) and a TRUNCATE grant, each of which destroys another tenant's rows
--      from a fully authenticated session;
--   5. after the inversion below, ONE assertion was left in the old style — the
--      policy-scoping check exempted any policy whose role list mentioned a
--      service role, so `CREATE POLICY p ON score_rows FOR SELECT TO app_rw,
--      svc_scorer USING (true)` passed the gate and returned every tenant's
--      corpus to an authenticated session. It was also the one assertion in the
--      file with no failing case in the test suite. Those two facts are the
--      same fact.
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
-- WHERE A NAME STILL APPEARS, it is default-deny: the three trusted service
-- roles are named so that everything NOT named is treated as tenant-facing.
-- That is the safe direction. Naming things so that everything not named is
-- treated as safe is the direction that failed five times.

BEGIN;

-- This file's own row goes in FIRST: under a second file with this number the
-- unique index refuses it here, before anything below runs (B3r item 4).
INSERT INTO schema_migrations (name) VALUES ('0008_tenancy_exposure_manifest');

-- ---------------------------------------------------------------------------
-- 1. The manifest
-- ---------------------------------------------------------------------------

CREATE TABLE tenancy_exposure_manifest (
  schema_name text NOT NULL,
  relation    text NOT NULL,
  privilege   text NOT NULL CHECK (privilege IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','USAGE')),
  -- scoped  : tenant-reachable, and every tenant-facing policy on it must bound
  --           rows by the tenant context. Disjointness is asserted behaviourally
  --           in packages/db/src/tenant-isolation.test.ts.
  -- shared  : deliberately visible to every tenant, read-only, with a declared
  --           column list.
  -- service : reachable by a trusted service role, and by nothing else.
  disposition text NOT NULL CHECK (disposition IN ('scoped','shared','service')),
  reason      text NOT NULL CHECK (length(reason) > 0),
  -- `shared` rows only: the exact columns approved for universal exposure.
  -- Guessing tenant-ness from column NAMES was tried and is unbounded in the
  -- same way as everything else here — `brand_id`, `org_id`, `agency`,
  -- `owner_id` and `"WorkspaceId"` all passed a five-word case-sensitive regex,
  -- and in this schema brand identity IS tenant identity. So the inversion
  -- applies one level down: declare the columns, and any difference is a fault.
  shared_columns text[],
  -- `service` rows only: the ONE trusted role the privilege is declared for.
  -- Matching any trusted role (main's form) meant a grant to the wrong service
  -- role was declared by a row that named another; the sweep now matches the
  -- grantee, so `GRANT INSERT ON workspace_documents TO svc_scorer` is
  -- `undeclared-exposure` while the svc_onboard row stands (C0 audit, MAJOR).
  grantee text,
  PRIMARY KEY (schema_name, relation, privilege),
  CHECK ((disposition = 'shared') = (shared_columns IS NOT NULL)),
  CHECK ((disposition = 'service') = (grantee IS NOT NULL)),
  CHECK (grantee IS NULL OR grantee IN ('svc_scorer', 'svc_onboard', 'auth_verifier'))
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
  -- Migration 0004 (workspace state; this lineage). A workspace reads its own
  -- cycles, documents and requests; every write goes through the ws_* definer
  -- functions owned by svc_onboard, which take the workspace from the verified
  -- context (ws_required()) and, for a decision, the stamped role (0005).
  ('public','workspace_cycles',       'SELECT','scoped', 'a workspace reads its own cycles (0004)'),
  ('public','workspace_documents',    'SELECT','scoped', 'a workspace reads its own versioned documents (0004)'),
  ('public','workspace_requests',     'SELECT','scoped', 'a workspace reads its own filed requests (0004)');

-- The scorer and onboarding services. Declared so the surface is complete,
-- and matched against the GRANTEE, so a `service` row does not silently
-- authorise the same privilege for a tenant role, nor for the other service
-- role (the grantee column, C0 audit).
INSERT INTO tenancy_exposure_manifest (schema_name, relation, privilege, disposition, reason, grantee) VALUES
  ('public','score_rows',             'INSERT','service','svc_scorer appends the corpus',  'svc_scorer'),
  ('public','score_aggregates',       'INSERT','service','svc_scorer appends rollups',     'svc_scorer'),
  ('public','accounts',               'INSERT','service','svc_onboard writes identity',    'svc_onboard'),
  ('public','accounts',               'UPDATE','service','svc_onboard writes identity',    'svc_onboard'),
  ('public','accounts',               'DELETE','service','svc_onboard writes identity',    'svc_onboard'),
  ('public','workspaces',             'INSERT','service','svc_onboard writes identity',    'svc_onboard'),
  ('public','workspaces',             'UPDATE','service','svc_onboard writes identity',    'svc_onboard'),
  ('public','workspaces',             'DELETE','service','svc_onboard writes identity',    'svc_onboard'),
  ('public','workspace_members',      'INSERT','service','svc_onboard writes identity',    'svc_onboard'),
  ('public','workspace_members',      'UPDATE','service','svc_onboard writes identity',    'svc_onboard'),
  ('public','workspace_members',      'DELETE','service','svc_onboard writes identity',    'svc_onboard'),
  ('public','workspace_brands',       'INSERT','service','svc_onboard grants entitlements, behind the billing gate', 'svc_onboard'),
  ('public','workspace_brands',       'UPDATE','service','svc_onboard moves entitlements, behind the billing gate',  'svc_onboard'),
  ('public','workspace_brands',       'DELETE','service','svc_onboard revokes entitlements', 'svc_onboard'),
  ('public','workspace_subscriptions','INSERT','service','svc_onboard writes billing state', 'svc_onboard'),
  ('public','workspace_subscriptions','UPDATE','service','svc_onboard writes billing state', 'svc_onboard'),
  ('public','workspace_subscriptions','DELETE','service','svc_onboard writes billing state', 'svc_onboard'),
  ('public','brands',                 'INSERT','service','svc_onboard curates the brand set', 'svc_onboard'),
  ('public','brands',                 'UPDATE','service','svc_onboard curates the brand set', 'svc_onboard'),
  ('public','prompt_banks',           'INSERT','service','svc_onboard curates prompt banks',  'svc_onboard'),
  ('public','prompt_banks',           'UPDATE','service','svc_onboard curates prompt banks',  'svc_onboard'),
  -- 0004's grants, exactly (0004:115-119): the DELETE is 0004's, used by
  -- ws_file_request to replace a pending filing and trim the history; 0007
  -- added the ownership check around it and introduced no privilege.
  ('public','workspace_cycles',       'INSERT','service','svc_onboard files a cycle through ws_put_cycle', 'svc_onboard'),
  ('public','workspace_cycles',       'UPDATE','service','svc_onboard completes a cycle (result, basis, written_at) through ws_put_cycle', 'svc_onboard'),
  ('public','workspace_documents',    'INSERT','service','svc_onboard writes version N+1 through ws_put_document', 'svc_onboard'),
  ('public','workspace_requests',     'INSERT','service','svc_onboard files a request through ws_file_request', 'svc_onboard'),
  ('public','workspace_requests',     'UPDATE','service','svc_onboard resolves a request (status, resolved_at, resolved_by, note) through ws_resolve_request', 'svc_onboard'),
  ('public','workspace_requests',     'DELETE','service','svc_onboard replaces a filer''s own pending request and trims its history through ws_file_request (0004)', 'svc_onboard');

INSERT INTO tenancy_exposure_manifest (schema_name, relation, privilege, disposition, reason, shared_columns) VALUES
  ('public','prompt_banks','SELECT','shared',
   'category-keyed reference data with no tenant column; private banks go in a separate RLS table (0000)',
   ARRAY['id:uuid','category:text','locale:text','geo:text','prompts:jsonb','version:integer']);

-- Partitions are NOT seeded. Seeding them once at migration time meant
-- ensure_score_partition() — a correct, scheduled maintenance job — created a
-- relation nobody could declare, and the gate then failed on the 1st of every
-- month for a benign reason. A gate that fails routinely gets `|| true` in the
-- pipeline, and then a real fault ships behind it. `manifest_root()` resolves a
-- partition to its root instead, so a new month inherits the parent's
-- disposition and a dropped month leaves nothing stale.
CREATE OR REPLACE FUNCTION manifest_root(rel oid) RETURNS oid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE cur oid := rel; parent oid;
BEGIN
  LOOP
    SELECT i.inhparent INTO parent FROM pg_inherits i WHERE i.inhrelid = cur LIMIT 1;
    EXIT WHEN parent IS NULL;
    cur := parent;
  END LOOP;
  RETURN cur;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The assertion
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tenancy_exposure_faults()
RETURNS TABLE(kind text, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  trusted constant text[] := ARRAY['svc_scorer','svc_onboard','auth_verifier'];
BEGIN
  -- ---- reachable but undeclared -------------------------------------------
  -- The subject is derived three ways at once — every schema, every relation
  -- kind, every privilege — and matched against the manifest INCLUDING the
  -- disposition, so a row declared `service` does not silently authorise the
  -- same privilege for a tenant role.
  FOR r IN
    SELECT DISTINCT ns.nspname, c.relname, root.relname AS rootname, p.priv, g.rolname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_class root ON root.oid = manifest_root(c.oid)
     CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES']) AS p(priv)
     CROSS JOIN LATERAL (
       SELECT rolname FROM pg_roles
        WHERE rolname NOT LIKE 'pg\_%' AND rolname <> 'auth_verifier' AND NOT rolsuper
       UNION ALL SELECT 'public'
     ) g
     WHERE ns.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
       AND ns.nspname NOT LIKE 'pg\_temp%' AND ns.nspname NOT LIKE 'pg\_toast%'
       -- A relation's OWNER holds every privilege on it implicitly. Excluding
       -- only rolsuper worked because PGlite's owner is a superuser; production
       -- owners are not, which is the exact difference this design exists to
       -- survive (0001). With ownership reassigned to a non-superuser the gate
       -- produced 54 faults and could not pass the posture it prescribes — the
       -- failure mode of 3c7e78b, and the predictable remedy (exempt the owner
       -- by name, or `|| true`) is what this file's preamble warns against.
       -- Owners are constrained separately below instead.
       AND g.rolname <> pg_get_userbyid(c.relowner)
       AND c.relkind IN ('r','p','v','m','f')
       AND (has_table_privilege(g.rolname, c.oid, p.priv)
            OR (p.priv NOT IN ('TRUNCATE','DELETE') AND has_any_column_privilege(g.rolname, c.oid, p.priv)))
       AND NOT EXISTS (
         SELECT 1 FROM tenancy_exposure_manifest m
          WHERE m.schema_name = ns.nspname AND m.relation = root.relname AND m.privilege = p.priv
            AND (m.disposition <> 'service' OR m.grantee = g.rolname))
  LOOP
    kind := 'undeclared-exposure';
    detail := format('%s.%s %s is reachable by %s and is not declared for it', r.nspname, r.relname, r.priv, r.rolname);
    RETURN NEXT;
  END LOOP;

  -- ---- sequences -----------------------------------------------------------
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
       AND ns.nspname NOT LIKE 'pg\_temp%' AND ns.nspname NOT LIKE 'pg\_toast%'
       AND g.rolname <> pg_get_userbyid(c.relowner)
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

  -- ---- TRUNCATE ------------------------------------------------------------
  -- Never scopeable: RLS does not apply to it in any form, so a grant is
  -- unconditional destruction of every tenant's rows. Declared or not.
  FOR r IN
    SELECT DISTINCT ns.nspname, c.relname, g.rolname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     CROSS JOIN LATERAL (
       SELECT rolname FROM pg_roles
        WHERE rolname NOT LIKE 'pg\_%' AND NOT (rolname = ANY (trusted)) AND NOT rolsuper
       UNION ALL SELECT 'public'
     ) g
     WHERE ns.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
       AND ns.nspname NOT LIKE 'pg\_temp%' AND ns.nspname NOT LIKE 'pg\_toast%'
       AND g.rolname <> pg_get_userbyid(c.relowner)
       AND c.relkind IN ('r','p') AND has_table_privilege(g.rolname, c.oid, 'TRUNCATE')
  LOOP
    kind := 'truncate-granted';
    detail := format('%s.%s TRUNCATE is held by %s; no policy can restrain TRUNCATE', r.nspname, r.relname, r.rolname);
    RETURN NEXT;
  END LOOP;

  -- ---- every DESCENDANT of a scoped relation must force RLS ----------------
  -- manifest_root() lets a descendant inherit its parent's declaration, so a
  -- partition is never `undeclared-exposure`. The first version then checked the
  -- obligation only against the relation NAMED in the manifest, so the
  -- declaration propagated downward and none of the duties did: a partition
  -- created without RLS, an existing partition with RLS switched off, a table
  -- staged with `LIKE ... INCLUDING ALL` (which does not copy RLS) and then
  -- ATTACHed, and a legacy INHERITS child all passed the gate and returned
  -- another tenant's rows to a legitimately authenticated session.
  --
  -- Worse, it was sticky: ensure_score_partition() short-circuits on the
  -- relation already existing, so a partition pre-created without RLS stays that
  -- way forever — and that helper's normal behaviour is to GRANT SELECT to
  -- app_rw, so every partition is tenant-readable by design.
  --
  -- If manifest_root() is good enough to confer the exemption, it is the only
  -- thing good enough to scope the requirement. So this iterates pg_class, not
  -- the manifest.
  --
  -- ONE KEY for declaration and obligation. The first version of this sweep
  -- resolved the manifest on the ROOT's schema (`m.schema_name = rns.nspname`)
  -- while `undeclared-exposure` and the policy loop resolve it on the CHILD's.
  -- Giving a declared relation a same-named parent in another schema then made
  -- the declaration resolve and the duty not:
  --
  --     CREATE TABLE archive.accounts (LIKE public.accounts);
  --     ALTER TABLE public.accounts INHERIT archive.accounts;
  --     ALTER TABLE public.accounts DISABLE ROW LEVEL SECURITY;
  --
  -- passed the gate and returned every tenant's user emails. That is exactly
  -- what `CREATE TABLE archive.x (LIKE public.x)` produces — a cold-storage or
  -- schema-reorg move — and it is the same bug as the commit that introduced
  -- this sweep, one column over.
  --
  -- AND THE OBLIGATION IS DERIVED FROM THE RELKIND, not filtered to ('r','p').
  -- A `scoped` VIEW carried no duty at all: views have no policies, so the
  -- policy loop never saw one, and a plain view executes with its OWNER's
  -- rights, straight past the base table's RLS. A dashboard read-model view is
  -- the most likely next object in apps/web and `scoped` is the disposition its
  -- author would reach for.
  FOR r IN
    SELECT ns.nspname, c.relname, c.relkind,
           coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions)
                      WHERE option_name = 'security_invoker'), 'false') AS invoker
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_class root ON root.oid = manifest_root(c.oid)
     WHERE c.relkind IN ('r','p','v','m','f')
       AND ns.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
       AND ns.nspname NOT LIKE 'pg\_temp%' AND ns.nspname NOT LIKE 'pg\_toast%'
       AND EXISTS (SELECT 1 FROM tenancy_exposure_manifest m
                    WHERE m.schema_name = ns.nspname AND m.relation = root.relname
                      AND m.disposition = 'scoped')
  LOOP
    IF r.relkind IN ('r','p') AND NOT EXISTS (
      SELECT 1 FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
       WHERE n2.nspname = r.nspname AND c2.relname = r.relname
         AND c2.relrowsecurity AND c2.relforcerowsecurity)
    THEN
      kind := 'scoped-without-forced-rls';
      detail := format('%s.%s inherits a scoped declaration but does not FORCE row level security', r.nspname, r.relname);
      RETURN NEXT;
    ELSIF r.relkind = 'v' AND lower(r.invoker) NOT IN ('true','on') THEN
      kind := 'scoped-view-not-invoker';
      detail := format('%s.%s is declared scoped but is not a security_invoker view, so it runs with its owner''s rights past RLS', r.nspname, r.relname);
      RETURN NEXT;
    ELSIF r.relkind IN ('m','f') THEN
      kind := 'scoped-kind-cannot-scope';
      detail := format('%s.%s is declared scoped but a %s can carry no policy at all', r.nspname, r.relname,
                       CASE r.relkind WHEN 'm' THEN 'materialized view' ELSE 'foreign table' END);
      RETURN NEXT;
    END IF;
  END LOOP;

  -- ---- object owners are a principal, and must be constrained like one ------
  -- Excluded from the grantee sweep above because ownership confers everything
  -- implicitly. That exclusion is only safe while an owner cannot be reached by
  -- anything that serves a tenant.
  FOR r IN
    SELECT DISTINCT o.rolname AS owner, o.rolcanlogin,
           (SELECT string_agg(grp, ', ') FROM unnest(ARRAY['app_rw','svc_scorer','svc_onboard']) grp
             WHERE pg_has_role(grp, o.rolname, 'MEMBER')) AS reached_by
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_roles o ON o.oid = c.relowner
     WHERE c.relkind IN ('r','p','v','m','f','S')
       AND EXISTS (SELECT 1 FROM tenancy_exposure_manifest m
                    WHERE m.schema_name = ns.nspname
                      AND m.relation = (SELECT rc.relname FROM pg_class rc WHERE rc.oid = manifest_root(c.oid)))
       AND NOT o.rolsuper
  LOOP
    IF r.rolcanlogin THEN
      kind := 'owner-can-login';
      detail := format('%s owns declared relations and can log in; ownership confers every privilege implicitly', r.owner);
      RETURN NEXT;
    END IF;
    IF r.reached_by IS NOT NULL THEN
      kind := 'owner-reachable-by-tenant';
      detail := format('%s owns declared relations and is reachable by %s', r.owner, r.reached_by);
      RETURN NEXT;
    END IF;
  END LOOP;

  -- ---- a shared relation must be a LEAF ------------------------------------
  -- Reading a parent applies the PARENT's policy to the child's rows, and a
  -- shared relation's policy is USING (true). So a child of prompt_banks — even
  -- one carrying a correct `workspace_id = current_workspace_id()` policy of its
  -- own, which is exactly what 0000 instructs ("private banks go in a separate
  -- RLS'd table") — returns [] when read directly and every tenant's private
  -- bank when read through the parent. The child's correct policy is never
  -- consulted. No column-list comparison on the parent can ever see this.
  FOR r IN
    SELECT m.schema_name, m.relation, child.relname AS childname
      FROM tenancy_exposure_manifest m
      JOIN pg_class p ON p.relname = m.relation
      JOIN pg_namespace ns ON ns.oid = p.relnamespace AND ns.nspname = m.schema_name
      JOIN pg_inherits i ON i.inhparent = p.oid
      JOIN pg_class child ON child.oid = i.inhrelid
     WHERE m.disposition = 'shared'
  LOOP
    kind := 'shared-relation-has-descendant';
    detail := format('%s.%s is declared shared (policy USING (true)) and has descendant %s, whose rows are readable through the parent',
                     r.schema_name, r.relation, r.childname);
    RETURN NEXT;
  END LOOP;

  -- ---- a shared relation may not be tied to tenancy ------------------------
  -- `shared` means USING (true) for every tenant, and the only check on it was
  -- drift. A new table declared shared with `workspace_id:uuid` in its approved
  -- column list passed and returned both tenants' rows. Naming the tenancy
  -- columns would be the unbounded shape again, so this derives it: a shared
  -- relation may not carry a foreign key to anything declared `scoped`.
  FOR r IN
    SELECT m.schema_name, m.relation, tgt.relname AS target
      FROM tenancy_exposure_manifest m
      JOIN pg_class c ON c.relname = m.relation
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = m.schema_name
      JOIN pg_constraint fk ON fk.conrelid = c.oid AND fk.contype = 'f'
      JOIN pg_class tgt ON tgt.oid = fk.confrelid
      JOIN pg_namespace tns ON tns.oid = tgt.relnamespace
     WHERE m.disposition = 'shared'
       AND EXISTS (SELECT 1 FROM tenancy_exposure_manifest m2
                    WHERE m2.schema_name = tns.nspname AND m2.relation = tgt.relname
                      AND m2.disposition = 'scoped')
  LOOP
    kind := 'shared-references-scoped';
    detail := format('%s.%s is declared shared but references %s, which is tenant-scoped', r.schema_name, r.relation, r.target);
    RETURN NEXT;
  END LOOP;

  -- ---- multi-parent inheritance is refused ---------------------------------
  -- manifest_root() takes the first parent it finds. With two parents the
  -- declaration a child inherits would be decided by heap order rather than by
  -- a rule, so the answer is to refuse rather than to pick.
  FOR r IN
    SELECT ns.nspname, c.relname
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname NOT LIKE 'pg\_temp%' AND ns.nspname NOT LIKE 'pg\_toast%'
       AND (SELECT count(*) FROM pg_inherits i WHERE i.inhrelid = c.oid) > 1
  LOOP
    kind := 'multi-parent-inheritance';
    detail := format('%s.%s has more than one parent; which manifest declaration governs it is undefined', r.nspname, r.relname);
    RETURN NEXT;
  END LOOP;

  -- ---- every tenant-facing policy ------------------------------------------
  -- A policy is TENANT-FACING unless EVERY role it names is trusted. The
  -- previous form asked whether ANY named role was trusted, which exempted
  -- `TO app_rw, svc_scorer USING (true)` — RLS ORs permissive policies, so that
  -- one statement returned every tenant's corpus to an authenticated session
  -- and passed the gate. Default-deny: not-named means tenant-facing.
  --
  -- Partitions resolve to their root, so a partition's own policy is held to
  -- the parent's declaration.
  FOR r IN
    SELECT pol.schemaname, pol.tablename, pol.policyname, pol.cmd,
           coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '') AS expr,
           m.disposition
      FROM pg_policies pol
      JOIN pg_class c ON c.relname = pol.tablename
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = pol.schemaname
      JOIN pg_class root ON root.oid = manifest_root(c.oid)
      JOIN LATERAL (
        SELECT DISTINCT mm.disposition FROM tenancy_exposure_manifest mm
         WHERE mm.schema_name = pol.schemaname AND mm.relation = root.relname
           AND mm.disposition IN ('scoped','shared')
      ) m ON true
     WHERE pol.roles = '{public}'::name[]
        OR EXISTS (SELECT 1 FROM unnest(pol.roles) rr WHERE NOT (rr::text = ANY (trusted)))
  LOOP
    IF r.disposition = 'scoped' AND r.expr NOT LIKE '%current_workspace_id%' THEN
      kind := 'scoped-policy-unbounded';
      detail := format('%s.%s policy %s (%s) is tenant-facing and never mentions current_workspace_id',
                       r.schemaname, r.tablename, r.policyname, r.cmd);
      RETURN NEXT;
    END IF;
    -- A shared relation is READ-only to tenants. Its write privileges are
    -- declared `service`, but a policy is what makes a grant usable, and a
    -- tenant-facing write policy on shared reference data is cross-tenant
    -- corruption of the benchmark corpus rather than a leak.
    IF r.disposition = 'shared' AND r.cmd <> 'SELECT' THEN
      kind := 'shared-relation-writable';
      detail := format('%s.%s policy %s (%s) lets a tenant write shared reference data',
                       r.schemaname, r.tablename, r.policyname, r.cmd);
      RETURN NEXT;
    END IF;
  END LOOP;

  -- ---- declared-shared relations expose exactly the declared columns -------
  FOR r IN
    SELECT m.schema_name, m.relation, m.shared_columns,
           -- name AND type: `ALTER COLUMN version TYPE text` changed what the
           -- column can carry while leaving the name list identical.
           array_agg(a.attname::text || ':' || format_type(a.atttypid, NULL) ORDER BY a.attname) AS actual
      FROM tenancy_exposure_manifest m
      JOIN pg_class c ON c.relname = m.relation
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = m.schema_name
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE m.disposition = 'shared'
     GROUP BY m.schema_name, m.relation, m.shared_columns
  LOOP
    IF (SELECT array_agg(x ORDER BY x) FROM unnest(r.shared_columns) x) IS DISTINCT FROM r.actual THEN
      kind := 'shared-columns-changed';
      detail := format('%s.%s is declared shared with %s but has %s; a new column may carry tenant identity',
                       r.schema_name, r.relation, r.shared_columns, r.actual);
      RETURN NEXT;
    END IF;
  END LOOP;

  -- ---- stale manifest rows -------------------------------------------------
  FOR r IN
    SELECT DISTINCT m.schema_name, m.relation FROM tenancy_exposure_manifest m
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = m.schema_name AND c.relname = m.relation)
  LOOP
    kind := 'stale-manifest-row';
    detail := format('%s.%s is in the manifest but does not exist', r.schema_name, r.relation);
    RETURN NEXT;
  END LOOP;

  -- ---- CREATE on a schema the pinned search_path depends on ----------------
  -- Any untrusted role, not only the PUBLIC pseudo-role.
  FOR r IN
    -- Every schema in the database, not the manifest's ∪ 'public'. A definer
    -- function's pinned search_path is only one of the reasons this matters, and
    -- naming the schemas is the shape that failed nine times elsewhere.
    SELECT DISTINCT x.sch, g.rolname FROM (
      SELECT nspname AS sch FROM pg_namespace
       WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast')
         AND nspname NOT LIKE 'pg\_temp%' AND nspname NOT LIKE 'pg\_toast%'
    ) x
    CROSS JOIN LATERAL (
      SELECT rolname FROM pg_roles
       WHERE rolname NOT LIKE 'pg\_%' AND NOT (rolname = ANY (trusted)) AND NOT rolsuper
      UNION ALL SELECT 'public'
    ) g
    WHERE has_schema_privilege(g.rolname, x.sch, 'CREATE')
  LOOP
    kind := 'schema-create-granted';
    detail := format('%s has CREATE on schema %s; a definer function''s search_path can be shadowed', r.rolname, r.sch);
    RETURN NEXT;
  END LOOP;

  -- ---- SECURITY DEFINER functions, in every schema -------------------------
  -- A definer runs as its OWNER, so the owner must be one of the three trusted
  -- service roles and never the migration owner, a login role or anything a
  -- tenant can reach: auth_verifier for the context mechanism (0002, 0005),
  -- svc_onboard for onboarding and workspace state (0003, 0004; B2's decision,
  -- so the web tier keeps one credential and the writers run as the role 0000
  -- designed to write identity). On main this named auth_verifier alone; the
  -- lineage merged at 0008 owns its writers by svc_onboard by design. The
  -- scorer owns no definer and may not: it appends the corpus and nothing
  -- else, so a definer it owned would be a door into the corpus with no
  -- declared purpose (C0 audit, MINOR 2; failing case in deploy-check.test.ts).
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, o.rolname AS owner,
           EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) cf WHERE cf LIKE 'search\_path=%') AS pinned
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
      JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.prosecdef AND ns.nspname NOT IN ('pg_catalog','information_schema')
  LOOP
    IF r.owner NOT IN ('auth_verifier', 'svc_onboard') OR NOT r.pinned THEN
      kind := 'definer-function-unsafe';
      detail := format('%s (owner %s, search_path %s)', r.sig, r.owner, CASE WHEN r.pinned THEN 'pinned' ELSE 'UNPINNED' END);
      RETURN NEXT;
    END IF;
  END LOOP;

  FOR r IN
    -- regprocedure already schema-qualifies anything off the search_path, so it
    -- is not concatenated again.
    SELECT p.oid::regprocedure::text AS sig, g.rolname
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     CROSS JOIN LATERAL (
       SELECT rolname FROM pg_roles
        WHERE rolname NOT LIKE 'pg\_%' AND rolname <> 'auth_verifier' AND NOT rolsuper
        UNION ALL SELECT 'public'
     ) g
     WHERE p.prosecdef AND ns.nspname NOT IN ('pg_catalog','information_schema')
       -- DEFAULT-DENY: the intended tenant surface, by name. A new definer
       -- function is refused the day it is written, which is the opposite of the
       -- list that said "check only these five" and left the sixth unexamined.
       -- deploy_check is a deploy principal, not a tenant, and is excluded above
       -- only by being granted the gate's own functions explicitly.
       AND NOT (ns.nspname = 'public' AND p.oid::regprocedure::text IN (
              -- 0002: the context readers (PUBLIC) and the verifier (app_rw); 0005 adds the role reader
              'set_workspace_jwt(text)', 'current_workspace_id()', 'current_account_id()', 'current_workspace_role()',
              -- 0003: onboarding, owned by svc_onboard, app_rw only
              'ensure_account(uuid,text,text)', 'create_workspace(uuid,text)', 'workspaces_of(uuid)',
              -- 0004: workspace state writers, owned by svc_onboard, workspace from the verified context.
              -- The same twelve check-deploy.sql declares; either copy going stale fails the healthy database.
              'ws_required()', 'ws_put_cycle(text,date,text,text,jsonb)', 'ws_put_document(text,text,jsonb,integer)',
              'ws_file_request(text,text,jsonb,timestamp with time zone)',
              'ws_resolve_request(text,text,timestamp with time zone,text,text,text)'))
       -- The gate's own functions are permitted for the DEPLOY principal only,
       -- and reachability is MEMBER, not the literal role name: `deployer` holds
       -- the grant through deploy_check, and excluding the name alone repeated
       -- the same mistake one level down.
       -- `g.rolname <> 'public'` first: has_table_privilege accepts the PUBLIC
       -- pseudo-role, pg_has_role raises on it. Without the guard a PUBLIC grant
       -- killed the gate with "role public does not exist" instead of reporting
       -- the fault — fail-closed, but it misdiagnoses, and the obvious fix
       -- (dropping the 'public' row) would blind the whole scan to PUBLIC grants.
       AND NOT (ns.nspname = 'public'
                AND p.oid::regprocedure::text IN ('tenancy_exposure_faults()', 'auth_key_health()', 'migration_record()')
                AND g.rolname <> 'public'
                AND pg_has_role(g.rolname, 'deploy_check', 'MEMBER'))
       AND has_function_privilege(g.rolname, p.oid, 'EXECUTE')
  LOOP
    kind := 'definer-function-exposed';
    detail := format('%s is executable by %s', r.sig, r.rolname);
    RETURN NEXT;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Role powers that live outside the privilege system
-- ---------------------------------------------------------------------------

-- assert_role_exclusivity() checks rolsuper and rolbypassrls. Membership in a
-- PREDEFINED role confers power that never appears in a table ACL, so none of
-- the reachability derivation above can see it: pg_execute_server_program is
-- `COPY ... FROM PROGRAM` — arbitrary command execution as the database OS user,
-- which ends the tenancy model outright. pg_read_all_data IS caught, because it
-- surfaces through has_table_privilege; that difference is exactly the boundary
-- of the derivation, and this closes it.
--
-- Whether these are grantable at all on the hosting target is a separate
-- question (Supabase's postgres is not a superuser; RDS blocks server programs).
-- The gate should object either way rather than depend on it.
CREATE OR REPLACE FUNCTION assert_role_powers() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  offenders text;
  dangerous constant text[] := ARRAY['pg_execute_server_program','pg_read_server_files',
                                     'pg_write_server_files','pg_maintain','pg_signal_backend'];
  streamers text;
BEGIN
  -- REPLICATION is an ATTRIBUTE, like BYPASSRLS, whose omission was a BLOCKER in
  -- audit 3. A replication connection streams the WAL, and RLS is not consulted
  -- on the WAL — so it is a total tenancy bypass that appears in no table ACL.
  -- rds_replication and Supabase's replication grant make it the realistic form
  -- on the hosting target.
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO streamers
    FROM pg_roles r
   WHERE r.rolreplication AND NOT r.rolsuper AND r.rolname NOT LIKE 'pg\_%';
  IF streamers IS NOT NULL THEN
    RAISE EXCEPTION 'these roles hold REPLICATION and can stream the whole database past RLS: %', streamers;
  END IF;
  SELECT string_agg(format('%s in %s', r.rolname, d.grp), '; ' ORDER BY r.rolname) INTO offenders
    FROM pg_roles r
   CROSS JOIN LATERAL unnest(dangerous) AS d(grp)
   WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\_%'
     AND EXISTS (SELECT 1 FROM pg_roles t WHERE t.rolname = d.grp)
     AND pg_has_role(r.rolname, d.grp, 'MEMBER');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'these roles hold server-level powers no policy can restrain: %', offenders;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Key health, readable by a deployer that is not a superuser
-- ---------------------------------------------------------------------------

-- The gate read auth_signing_keys directly. That table FORCEs RLS with a single
-- TO auth_verifier policy — the entire point of the design — so on the
-- production posture the design prescribes, a non-superuser deployer sees ZERO
-- rows and the gate fails with "no live row", which is the opposite of what is
-- wrong. The only way to make it pass was to deploy with BYPASSRLS and excuse
-- that role, waiving the single most important assertion in the file.
--
-- Counts only. No secret material crosses this boundary.
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

-- The migration record (0003, section 0) is FORCE RLS with one policy naming
-- the migration owner and no grant to anyone else, so the deploy principal
-- this file prescribes, a member of deploy_check that is neither superuser nor
-- owner, gets `permission denied for table schema_migrations` from
-- check-deploy.sql's record assertion (measured, C0 audit): the gate could not
-- be run as that principal at all. The same shape as auth_key_health(): a
-- definer owned by auth_verifier, which is granted the record for exactly
-- this, returns the names and nothing else, and the assertion refuses an empty
-- record rather than passing over it. Reconciled at the renumbering (C0,
-- 2026-09-15): main's deploy posture and the lineage's record check are both
-- kept.
CREATE OR REPLACE FUNCTION migration_record()
RETURNS TABLE(name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.name FROM schema_migrations m ORDER BY m.name
$$;

-- ---------------------------------------------------------------------------
-- 5. Ownership and grants
-- ---------------------------------------------------------------------------

-- The deploy principal. The gate's functions are granted to THIS role rather
-- than to PUBLIC: tenancy_exposure_faults() returns a ranked list of exactly
-- which relations are reachable-and-unreviewed, plus signatures and owners of
-- definer functions in schemas the caller cannot even enter. No tenant data and
-- no key material — but a targeting list, handed to the attacker. Grant
-- deploy_check to whatever role runs `pnpm db:check`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deploy_check') THEN CREATE ROLE deploy_check NOLOGIN; END IF;
END $$;

DO $$ BEGIN EXECUTE format('GRANT auth_verifier TO %I', current_user); END $$;

ALTER FUNCTION tenancy_exposure_faults() OWNER TO auth_verifier;
ALTER FUNCTION auth_key_health()          OWNER TO auth_verifier;
ALTER FUNCTION migration_record()         OWNER TO auth_verifier;
GRANT SELECT ON schema_migrations TO auth_verifier;
CREATE POLICY schema_migrations_verifier ON schema_migrations FOR SELECT TO auth_verifier USING (true);
-- Called from inside tenancy_exposure_faults(), which runs as auth_verifier, so
-- the owner must be able to execute it after the REVOKE below.
ALTER FUNCTION manifest_root(oid)         OWNER TO auth_verifier;

ALTER TABLE tenancy_exposure_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy_exposure_manifest FORCE  ROW LEVEL SECURITY;
GRANT SELECT ON tenancy_exposure_manifest TO auth_verifier;
CREATE POLICY manifest_verifier_only ON tenancy_exposure_manifest FOR ALL TO auth_verifier USING (true) WITH CHECK (true);
ALTER TABLE tenancy_exposure_manifest OWNER TO auth_verifier;

REVOKE ALL ON FUNCTION tenancy_exposure_faults() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_key_health()          FROM PUBLIC;
REVOKE ALL ON FUNCTION migration_record()         FROM PUBLIC;
REVOKE ALL ON FUNCTION manifest_root(oid)         FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_role_exclusivity()  FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_role_powers()       FROM PUBLIC;

GRANT EXECUTE ON FUNCTION tenancy_exposure_faults() TO deploy_check;
GRANT EXECUTE ON FUNCTION auth_key_health()         TO deploy_check;
GRANT EXECUTE ON FUNCTION migration_record()        TO deploy_check;
GRANT EXECUTE ON FUNCTION assert_role_exclusivity() TO deploy_check;
GRANT EXECUTE ON FUNCTION assert_role_powers()      TO deploy_check;

DO $$ BEGIN EXECUTE format('REVOKE auth_verifier FROM %I', current_user); END $$;

COMMIT;
