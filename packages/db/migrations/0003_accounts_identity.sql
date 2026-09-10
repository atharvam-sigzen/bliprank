-- 0003_accounts_identity — an account is a person Supabase Auth has verified,
-- an account has a kind, and a brand account owns exactly one workspace.
-- MVP_PLAN B2, owner decision D2 (PRODUCT_GOAL points 1 and 2). 2026-09-10.
--
-- HUMAN-OWNED (CLAUDE.md §4: RLS policies and the tenancy model). Written by an
-- agent session; ⚠️ HUMAN REVIEW REQUIRED before it is applied anywhere.
--
-- NUMBERING. `fix/tenancy-deploy-gate` carries an unmerged
-- 0003_tenancy_exposure_manifest.sql (ADR-0007). Two files cannot share a
-- number in one lineage; whichever merges second is renumbered, and the
-- manifest, when it merges, must declare the three functions below.
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
-- the id of a Supabase Auth user, as an argument. The web tier passes the id
-- of the user whose session it has just verified with the Supabase server —
-- exactly the fact it already asserts as `sub` when it mints a workspace token
-- for set_workspace_jwt(). The database cannot verify a Supabase session
-- itself (that would put Supabase's JWT secret in this database, which the
-- 0002 design refuses for our own key), so the boundary is the same one the
-- token's `sub` already sits on: the server's verification of the session.
-- What app_rw gains through these functions is bounded to their bodies: it
-- still holds no INSERT, UPDATE or DELETE on any identity table (the
-- tenant-isolation suite asserts that), and the functions run as svc_onboard,
-- the role 0000 designed to write identity.
--
-- WHY FUNCTIONS AND NOT A SECOND DSN. 0000 imagined onboarding on "a different
-- DSN". A web tier holding a svc_onboard login role holds unbounded write on
-- accounts, workspaces and members; three definer functions with fixed bodies
-- are the smaller surface, and the web tier keeps exactly one role, app_rw.
--
-- THE ONE-WORKSPACE RULE is enforced where the row is written — a trigger on
-- workspace_members — not in the function that usually writes it, so a direct
-- write by svc_onboard obeys it too. It locks the account row first, so two
-- concurrent creations for one brand account serialise and the second fails.

-- ---------------------------------------------------------------------------
-- 1. Accounts: the auth identity and the kind
-- ---------------------------------------------------------------------------

-- Nullable: rows provisioned before a person signs in (seed, a pre-created
-- agency account) exist without one, and ensure_account() adopts such a row
-- by email on first sign-in.
ALTER TABLE accounts ADD COLUMN auth_uid uuid UNIQUE;

-- brand = one workspace of their own; agency = many client workspaces. The
-- kind is chosen at first sign-in and is a fact about the account, not about
-- any workspace: the same workspace shape serves both, and the personas
-- differ in what the account may own and which experience the app renders.
ALTER TABLE accounts ADD COLUMN kind text NOT NULL DEFAULT 'brand' CHECK (kind IN ('brand', 'agency'));

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
  -- Lock the account so two concurrent owner inserts for one brand account
  -- serialise here; the second one recounts after the first commits.
  SELECT a.kind INTO acct_kind FROM accounts a WHERE a.id = NEW.account_id FOR UPDATE;
  IF acct_kind IS DISTINCT FROM 'brand' THEN RETURN NEW; END IF;
  SELECT count(*)::int INTO owned FROM workspace_members m
   WHERE m.account_id = NEW.account_id AND m.role = 'owner' AND m.workspace_id <> NEW.workspace_id;
  IF owned > 0 THEN
    RAISE EXCEPTION 'identity: a brand account owns one workspace; account % already owns one', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workspace_members_brand_owns_one
  BEFORE INSERT OR UPDATE OF role, account_id ON workspace_members
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
-- provisioned by email is adopted; else created. `kind` is set only on
-- creation — a later call with a different kind does not relabel an account,
-- because the rule above is about what the account already owns.
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
  UPDATE accounts a SET auth_uid = p_auth_uid
   WHERE a.email = p_email AND a.auth_uid IS NULL
   RETURNING a.id INTO acct;
  IF FOUND THEN RETURN acct; END IF;
  -- Two confirms racing for one new user: the loser's INSERT conflicts on
  -- auth_uid and reads the winner's row.
  INSERT INTO accounts (auth_uid, email, kind) VALUES (p_auth_uid, p_email, p_kind)
  ON CONFLICT (auth_uid) DO UPDATE SET auth_uid = EXCLUDED.auth_uid
  RETURNING id INTO acct;
  RETURN acct;
END $$;

-- A workspace owned by the account behind `auth_uid`. The one-workspace rule
-- is the trigger's, so a brand account's second call raises check_violation.
CREATE OR REPLACE FUNCTION create_workspace(p_auth_uid uuid, p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  acct uuid;
  ws   uuid;
BEGIN
  SELECT a.id INTO acct FROM accounts a WHERE a.auth_uid = p_auth_uid;
  IF acct IS NULL THEN RAISE EXCEPTION 'identity: no account for that auth uid'; END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'identity: a workspace needs a name'; END IF;
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
