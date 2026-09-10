-- 0003_accounts_identity — an account is a person Supabase Auth has verified,
-- an account has a kind, and a brand account owns exactly one workspace.
-- MVP_PLAN B2, owner decision D2 (PRODUCT_GOAL points 1 and 2). 2026-09-10.
--
-- HUMAN-OWNED (CLAUDE.md §4: RLS policies and the tenancy model). Written by an
-- agent session; ⚠️ HUMAN REVIEW REQUIRED before it is applied anywhere.
--
-- NUMBERING. `fix/tenancy-deploy-gate` carries an unmerged
-- 0003_tenancy_exposure_manifest.sql (ADR-0007). Two files cannot share a
-- number in one lineage: that file is renumbered 0005 when it merges, records
-- itself in schema_migrations as every file from here on does, and must
-- declare the three functions below. The record (section 0) is what makes
-- two files with one number impossible rather than merely noticed: the
-- second INSERT fails on the number's unique index before the file changes
-- anything (MVP_PLAN B3r, item 4).
--
-- ONE TRANSACTION. Section 3 grants the migration owner svc_onboard to
-- transfer function ownership and revokes it at the end; a failure between
-- the two used to leave the owner a standing member with unbounded write on
-- identity (oversight review 2026-09-10, B3r item 1). The file-level BEGIN
-- means a mid-file failure leaves nothing, and migrations.test.ts runs the
-- file statement by statement, as psql does, cut after the GRANT, to prove it.
--
-- WHAT THIS DOES NOT TOUCH. The tenant context mechanism of 0002 — the
-- unlogged context table, its readers, set_workspace_jwt() — is unchanged, and
-- so is every policy app_rw reads through. Identity here is the SAME model:
-- a workspace is read only through a token the database verifies, and a token
-- only stamps a workspace its subject is a member of. What 0003 adds is the
-- step BEFORE a workspace exists: who the person is, and how they come to own
-- one.
--
-- THE TRUST BOUNDARY, stated once. The three functions below take `auth_uid`,
-- the id of a Supabase Auth user, as an argument, and ensure_account() also
-- takes the user's EMAIL, which selects a pre-provisioned row to adopt. Both
-- are trust-carrying. The web tier passes the id and email of the user whose
-- session it has just verified with the Supabase server, and only when that
-- server says the email is confirmed — exactly the fact it already asserts as
-- `sub` when it mints a workspace token for set_workspace_jwt(). The database
-- cannot verify a Supabase session itself (that would put Supabase's JWT
-- secret in this database, which the 0002 design refuses for our own key), so
-- the boundary is the same one the token's `sub` already sits on: the
-- server's verification of the session.
--
-- BECAUSE auth_uid IS A CAPABILITY, THE TENANT ROLE MAY NOT READ IT. 0000
-- granted app_rw SELECT on accounts at table level, which would have extended
-- to the new column and let one workspace's member read a co-member's auth
-- uid and then name that account to these functions (found by the 2026-09-10
-- tenancy audit, with a working proof). The grant is narrowed to columns
-- below; auth_uid never leaves the definer boundary.
--
-- What app_rw gains through these functions is bounded to their bodies: it
-- still holds no INSERT, UPDATE or DELETE on any identity table (the
-- tenant-isolation suite asserts that), and the functions run as svc_onboard,
-- the role 0000 designed to write identity. Every SECURITY DEFINER function
-- an application role may execute is declared in check-deploy.sql and in the
-- rls suite's standing sweep; one that is not declared fails both.
--
-- WHY FUNCTIONS AND NOT A SECOND DSN. 0000 imagined onboarding on "a different
-- DSN". A web tier holding a svc_onboard login role holds unbounded write on
-- accounts, workspaces and members; three definer functions with fixed bodies
-- are the smaller surface, and the web tier keeps exactly one role, app_rw.
--
-- THE ONE-WORKSPACE RULE is enforced where the row is written — a trigger on
-- workspace_members — not in the function that usually writes it, so a direct
-- write by svc_onboard obeys it too. It locks the account row first, so two
-- concurrent creations for one brand account serialise and the second fails
-- at READ COMMITTED and SERIALIZABLE; at REPEATABLE READ a lock-only tuple
-- does not raise and the recount would run on a stale snapshot, so the
-- trigger refuses that level outright, as 0002's billing gate does.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. The migration record: one applied file per number
-- ---------------------------------------------------------------------------

-- One row per applied file, keyed by name, and a unique index on the
-- four-digit number. Created here rather than in 0000 because 0000–0002 may
-- already be applied somewhere; they are backfilled. The ordered list on disk
-- is the migrations directory itself (packages/db/src/testing.ts reads it);
-- migrations.test.ts asserts the record equals that list after a full apply,
-- and check-deploy.sql asserts the record is gapless and still carries the
-- index. FORCE binds the owner, so the owner holds the one policy; no
-- application role holds any privilege here.
CREATE TABLE schema_migrations (
  name       text        PRIMARY KEY CHECK (name ~ '^[0-9]{4}_[a-z0-9_]+$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX schema_migrations_one_per_number ON schema_migrations ((left(name, 4)));
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations FORCE  ROW LEVEL SECURITY;
CREATE POLICY schema_migrations_owner ON schema_migrations FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
INSERT INTO schema_migrations (name) VALUES ('0000_init'), ('0001_tenancy_identity'), ('0002_tenancy_context');

-- ---------------------------------------------------------------------------
-- 1. Accounts: the auth identity and the kind
-- ---------------------------------------------------------------------------

-- Nullable: rows provisioned before a person signs in (seed, a pre-created
-- agency account) exist without one, and ensure_account() adopts such a row
-- by email on first sign-in.
ALTER TABLE accounts ADD COLUMN auth_uid uuid UNIQUE;

-- A pre-provisioned row may be adopted by the first confirmed sign-in with
-- its email only inside a window an operator set. NULL = never adoptable:
-- without this, a fresh sign-in whose session carried a chosen email could
-- become any unclaimed account (audit MAJOR-1).
ALTER TABLE accounts ADD COLUMN adoptable_until timestamptz;


-- brand = one workspace of their own; agency = many client workspaces. The
-- kind is chosen at first sign-in and is a fact about the account, not about
-- any workspace: the same workspace shape serves both, and the personas
-- differ in what the account may own and which experience the app renders.
ALTER TABLE accounts ADD COLUMN kind text NOT NULL DEFAULT 'brand' CHECK (kind IN ('brand', 'agency'));

-- The tenant role reads accounts by column, never the capability column.
REVOKE SELECT ON accounts FROM app_rw;
GRANT SELECT (id, email, created_at, kind) ON accounts TO app_rw;

-- ---------------------------------------------------------------------------
-- 2. A brand account owns at most one workspace
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_brand_owns_one_workspace() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  acct_kind text;
  owned     integer;
BEGIN
  IF NEW.role <> 'owner' THEN RETURN NEW; END IF;
  -- At REPEATABLE READ the FOR UPDATE below does not raise for a tuple that
  -- was only locked, and the recount sees a snapshot from before the other
  -- writer committed: both would pass. Refuse the level, as 0002 does.
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'identity: owner writes are not safe at REPEATABLE READ; use READ COMMITTED or SERIALIZABLE';
  END IF;
  -- Lock the account so two concurrent owner inserts for one brand account
  -- serialise here; the second one recounts after the first commits.
  SELECT a.kind INTO acct_kind FROM accounts a WHERE a.id = NEW.account_id FOR UPDATE;
  IF acct_kind IS DISTINCT FROM 'brand' THEN RETURN NEW; END IF;
  -- On an UPDATE the row being changed still exists under its OLD key and
  -- must not count against itself (a move keeps the count at one).
  SELECT count(*)::int INTO owned FROM workspace_members m
   WHERE m.account_id = NEW.account_id AND m.role = 'owner' AND m.workspace_id <> NEW.workspace_id
     AND NOT (TG_OP = 'UPDATE' AND m.workspace_id = OLD.workspace_id AND m.account_id = OLD.account_id);
  IF owned > 0 THEN
    RAISE EXCEPTION 'identity: a brand account owns one workspace; account % already owns one', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workspace_members_brand_owns_one
  BEFORE INSERT OR UPDATE OF role, account_id, workspace_id ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION assert_brand_owns_one_workspace();

-- The rule holds in both directions: an agency that owns several workspaces
-- cannot be relabelled a brand while it does.
CREATE OR REPLACE FUNCTION assert_kind_change_keeps_rule() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE owned integer;
BEGIN
  IF NEW.kind = 'brand' AND OLD.kind IS DISTINCT FROM 'brand' THEN
    SELECT count(*)::int INTO owned FROM workspace_members m WHERE m.account_id = NEW.id AND m.role = 'owner';
    IF owned > 1 THEN
      RAISE EXCEPTION 'identity: account % owns % workspaces and cannot become a brand account', NEW.id, owned
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER accounts_kind_keeps_rule
  BEFORE UPDATE OF kind ON accounts
  FOR EACH ROW EXECUTE FUNCTION assert_kind_change_keeps_rule();

-- ---------------------------------------------------------------------------
-- 3. Onboarding, as three definer functions the tenant role may call
-- ---------------------------------------------------------------------------

-- The migration owner must be a member to transfer ownership; revoked at the
-- end, as 0002 does for auth_verifier.
DO $$ BEGIN EXECUTE format('GRANT svc_onboard TO %I', current_user); END $$;

-- The account for a verified auth user: found by auth_uid; else a row
-- provisioned by email and still inside its adoption window is adopted; else
-- created. An email already bound to ANOTHER auth user, or provisioned with
-- no window, is an explicit refusal rather than a constraint error, so the
-- app can say so. `kind` is set only on creation — a later call with a
-- different kind does not relabel an account, because the rule above is
-- about what the account already owns.
CREATE OR REPLACE FUNCTION ensure_account(p_auth_uid uuid, p_email text, p_kind text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE acct uuid;
BEGIN
  IF p_auth_uid IS NULL OR p_email IS NULL OR p_email = '' THEN
    RAISE EXCEPTION 'identity: ensure_account needs an auth uid and an email';
  END IF;
  IF p_kind IS DISTINCT FROM 'brand' AND p_kind IS DISTINCT FROM 'agency' THEN
    RAISE EXCEPTION 'identity: kind must be brand or agency';
  END IF;
  SELECT a.id INTO acct FROM accounts a WHERE a.auth_uid = p_auth_uid;
  IF FOUND THEN RETURN acct; END IF;
  UPDATE accounts a SET auth_uid = p_auth_uid, adoptable_until = NULL
   WHERE a.email = p_email AND a.auth_uid IS NULL AND a.adoptable_until > now()
   RETURNING a.id INTO acct;
  IF FOUND THEN RETURN acct; END IF;
  IF EXISTS (SELECT 1 FROM accounts a WHERE a.email = p_email) THEN
    RAISE EXCEPTION 'identity: that email already belongs to another sign-in' USING ERRCODE = 'unique_violation';
  END IF;
  -- Two confirms racing for one new user: the loser's INSERT conflicts on
  -- auth_uid and reads the winner's row.
  INSERT INTO accounts (auth_uid, email, kind) VALUES (p_auth_uid, p_email, p_kind)
  ON CONFLICT (auth_uid) DO UPDATE SET auth_uid = EXCLUDED.auth_uid
  RETURNING id INTO acct;
  RETURN acct;
END $$;

-- A workspace owned by the account behind `auth_uid`. The one-workspace rule
-- is the trigger's, so a brand account's second call raises check_violation.
-- An agency account is bounded too: `kind` is chosen by the person at first
-- sign-in, and without a ceiling "agency" would be unbounded row creation
-- from an unpaid sign-up (audit MINOR-2). Fifty is a ceiling on abuse, not a
-- plan limit; billing (MVP_PLAN D2) sets the real one per plan.
CREATE OR REPLACE FUNCTION create_workspace(p_auth_uid uuid, p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  acct  uuid;
  ws    uuid;
  owned integer;
BEGIN
  SELECT a.id INTO acct FROM accounts a WHERE a.auth_uid = p_auth_uid FOR UPDATE;
  IF acct IS NULL THEN RAISE EXCEPTION 'identity: no account for that auth uid'; END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'identity: a workspace needs a name'; END IF;
  SELECT count(*)::int INTO owned FROM workspace_members m WHERE m.account_id = acct AND m.role = 'owner';
  IF owned >= 50 THEN
    RAISE EXCEPTION 'identity: account % owns % workspaces, the ceiling', acct, owned USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO workspaces (name) VALUES (btrim(p_name)) RETURNING id INTO ws;
  INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (ws, acct, 'owner');
  RETURN ws;
END $$;

-- The workspaces an account is a member of, with the account itself: what the
-- app needs before any workspace context exists (a switcher, the first-run
-- screen). Reads are bounded to the one account the argument names.
CREATE OR REPLACE FUNCTION workspaces_of(p_auth_uid uuid)
RETURNS TABLE (account_id uuid, email text, kind text, workspace_id uuid, workspace_name text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.email, a.kind, m.workspace_id, w.name, m.role
    FROM accounts a
    LEFT JOIN workspace_members m ON m.account_id = a.id
    LEFT JOIN workspaces w ON w.id = m.workspace_id
   WHERE a.auth_uid = p_auth_uid
   ORDER BY w.created_at, w.id
$$;

ALTER FUNCTION ensure_account(uuid, text, text) OWNER TO svc_onboard;
ALTER FUNCTION create_workspace(uuid, text)     OWNER TO svc_onboard;
ALTER FUNCTION workspaces_of(uuid)              OWNER TO svc_onboard;

REVOKE ALL ON FUNCTION ensure_account(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_workspace(uuid, text)     FROM PUBLIC;
REVOKE ALL ON FUNCTION workspaces_of(uuid)              FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_account(uuid, text, text) TO app_rw;
GRANT EXECUTE ON FUNCTION create_workspace(uuid, text)     TO app_rw;
GRANT EXECUTE ON FUNCTION workspaces_of(uuid)              TO app_rw;

-- The migration owner is not left a standing member of the writing role.
DO $$ BEGIN EXECUTE format('REVOKE svc_onboard FROM %I', current_user); END $$;

INSERT INTO schema_migrations (name) VALUES ('0003_accounts_identity');

COMMIT;
