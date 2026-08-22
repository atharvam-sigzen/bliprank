-- 0001_tenancy_identity — closes the two invariants 0000 declared it could not
-- enforce, plus the billing gate. Decisions taken 2026-08-22.
--
-- HUMAN-OWNED (CLAUDE.md §4: RLS policies and the tenancy model).
--
-- >>> CORRECTION, 2026-08-22. The paragraph below was WRONG when it was
-- >>> written, reviewed, approved and merged. It claims the tenant role can no
-- >>> longer name a workspace. It could: current_workspace_id(), not
-- >>> set_workspace(), was the authority, and it read a USERSET GUC that any
-- >>> role sets with a bare `SET LOCAL` — no function, no grant. The verifier
-- >>> built here was an OPTIONAL path around an open door. Fixed in
-- >>> 0002_tenancy_context.sql; read that file with this one. The text is kept
-- >>> unedited below because a migration is a record, and because the specific
-- >>> way it was wrong is the reason the adversarial-path test category exists.
--
-- (D) DB-LEVEL TENANCY IDENTITY. 0000 left set_workspace(ws) unbound: app_rw
--     naming any workspace read it, so the web app was the authorization
--     boundary and one SQL injection in the shared app_rw role was a full
--     cross-tenant read. Decision: do not accept app-level-only. The tenant role
--     can no longer name a workspace at all. It presents a signed token, the
--     database verifies the signature itself, and the workspace comes out of the
--     verified payload — never out of an argument the caller chose.
--
-- (C) ROLE EXCLUSIVITY. 0000 asserted it in the test suite, which proves it
--     about a fixture database and nothing about a deployment. Decision: an
--     automated deploy-time check that fails loudly — assert_role_exclusivity()
--     below, run by packages/db/scripts/check-deploy.sql in the deploy pipeline
--     (`pnpm --filter @bliprank/db db:check`).
--
-- (B) BILLING GATE. Decision: block-before-create. An entitlement that is not
--     paid for is refused by a BEFORE INSERT trigger, so the row never exists.
--     Never create-then-check-then-delete: that pattern is visible to a
--     concurrent reader, and a crash between the create and the delete leaves a
--     free entitlement behind.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- (D) Verified tenant identity
-- ---------------------------------------------------------------------------

-- The verifier is its own role so the function can read what it must without
-- app_rw being able to read any of it. SECURITY DEFINER runs as the function
-- OWNER, and FORCE ROW LEVEL SECURITY binds owners too — so the verifier needs
-- real policies, not the assumption that owning a table is enough. On PGlite the
-- migration owner is a superuser and would bypass RLS regardless; production
-- owners are not superusers, which is exactly the difference this arrangement
-- exists to survive.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_verifier') THEN CREATE ROLE auth_verifier NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO auth_verifier;
-- The migration owner must be a member to transfer ownership of the function.
DO $$ BEGIN EXECUTE format('GRANT auth_verifier TO %I', current_user); END $$;

-- Signing keys. No grant to any application role, so app_rw cannot read the
-- secret it would need to forge a token. `kid` lets a key be rotated without a
-- flag day: both keys are live until the old one is retired.
CREATE TABLE auth_signing_keys (
  kid         text PRIMARY KEY,
  secret      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz
);
ALTER TABLE auth_signing_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_signing_keys FORCE  ROW LEVEL SECURITY;
GRANT SELECT ON auth_signing_keys TO auth_verifier;
CREATE POLICY signing_keys_verifier_only ON auth_signing_keys FOR SELECT TO auth_verifier USING (true);

-- base64url, the JWT wire form: '+/' become '-_' and the padding is dropped.
CREATE OR REPLACE FUNCTION b64url_decode(s text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT decode(translate(s, '-_', '+/') || repeat('=', (4 - length(s) % 4) % 4), 'base64')
$$;

CREATE OR REPLACE FUNCTION b64url_encode(b bytea) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  -- encode() wraps at 76 columns; the newlines are not part of the value.
  SELECT rtrim(translate(replace(encode(b, 'base64'), E'\n', ''), '+/', '-_'), '=')
$$;

-- The tenant context, established from a token the caller cannot forge.
--
-- Returns the workspace it stamped. Raises on anything it will not accept —
-- an invalid token must abort the transaction, not silently produce an empty
-- result that reads like "this workspace has no data".
--
-- The membership check is here rather than in the row policies deliberately: it
-- runs once per transaction instead of once per row, and the policies already
-- key off current_workspace_id(), so a workspace that fails this check is
-- indistinguishable from no context at all.
CREATE OR REPLACE FUNCTION set_workspace_jwt(token text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  parts   text[];
  header  jsonb;
  payload jsonb;
  secret  text;
  ws      uuid;
  acct    uuid;
  now_s   bigint := extract(epoch FROM clock_timestamp())::bigint;
BEGIN
  IF token IS NULL THEN RAISE EXCEPTION 'auth: no token'; END IF;
  parts := string_to_array(token, '.');
  IF array_length(parts, 1) <> 3 THEN RAISE EXCEPTION 'auth: malformed token'; END IF;

  BEGIN
    header  := convert_from(b64url_decode(parts[1]), 'utf8')::jsonb;
    payload := convert_from(b64url_decode(parts[2]), 'utf8')::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'auth: undecodable token';
  END;

  -- Algorithm confusion is the classic JWT break: "alg":"none" and RS256-key-as-
  -- HMAC-secret both depend on the verifier trusting the header. This one accepts
  -- exactly one algorithm and reads the header for nothing else but the key id.
  IF header->>'alg' IS DISTINCT FROM 'HS256' THEN RAISE EXCEPTION 'auth: unsupported alg'; END IF;

  SELECT k.secret INTO secret FROM auth_signing_keys k
   WHERE k.kid = COALESCE(header->>'kid', '') AND k.retired_at IS NULL;
  IF secret IS NULL THEN RAISE EXCEPTION 'auth: unknown or retired key id'; END IF;

  -- Compare digests rather than the signatures themselves: string equality exits
  -- at the first differing byte, which leaks the prefix to a patient caller.
  IF digest(b64url_encode(hmac(parts[1] || '.' || parts[2], secret, 'sha256')), 'sha256')
     IS DISTINCT FROM digest(parts[3], 'sha256') THEN
    RAISE EXCEPTION 'auth: bad signature';
  END IF;

  IF (payload->>'exp') IS NULL THEN RAISE EXCEPTION 'auth: token has no expiry'; END IF;
  IF (payload->>'exp')::bigint <= now_s THEN RAISE EXCEPTION 'auth: token expired'; END IF;
  IF (payload->>'nbf') IS NOT NULL AND (payload->>'nbf')::bigint > now_s THEN RAISE EXCEPTION 'auth: token not yet valid'; END IF;

  BEGIN
    acct := (payload->>'sub')::uuid;
    ws   := (payload->>'workspace_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'auth: token is missing sub or workspace_id';
  END;
  IF acct IS NULL OR ws IS NULL THEN RAISE EXCEPTION 'auth: token is missing sub or workspace_id'; END IF;

  -- A validly signed token still does not get to name a workspace its subject is
  -- not a member of. The signature proves who; membership decides what.
  IF NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.account_id = acct AND m.workspace_id = ws) THEN
    RAISE EXCEPTION 'auth: account is not a member of that workspace';
  END IF;

  PERFORM set_config('app.workspace_id', ws::text, true);
  PERFORM set_config('app.account_id',   acct::text, true);
  PERFORM set_config('app.workspace_at', transaction_timestamp()::text, true);
  RETURN ws;
END $$;

ALTER FUNCTION set_workspace_jwt(text) OWNER TO auth_verifier;
GRANT SELECT ON workspace_members TO auth_verifier;
CREATE POLICY members_readable_by_verifier ON workspace_members FOR SELECT TO auth_verifier USING (true);

REVOKE ALL ON FUNCTION set_workspace_jwt(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_workspace_jwt(text) TO app_rw;

-- The unverified path is closed to the tenant. set_workspace() survives for
-- migrations, maintenance and the test harness, all of which run as the owner;
-- app_rw has no EXECUTE on it and therefore no way to name a workspace directly.
REVOKE ALL ON FUNCTION set_workspace(uuid) FROM PUBLIC;

-- The account behind the current context, for audit columns and member views.
CREATE OR REPLACE FUNCTION current_account_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN current_setting('app.workspace_at', true) = transaction_timestamp()::text
    THEN NULLIF(current_setting('app.account_id', true), '')::uuid
    ELSE NULL
  END
$$;

-- ---------------------------------------------------------------------------
-- (C) Role exclusivity, checkable at deploy time
-- ---------------------------------------------------------------------------

-- A login role in two authority groups defeats the role-based model 0000 is
-- built on: svc_onboard + app_rw in one role means a tenant connection can write
-- its own entitlements. Login roles are created outside the migration, so this
-- cannot be a constraint — it is an assertion the deploy pipeline runs, from
-- scripts/check-deploy.sql, where the roles actually are.
CREATE OR REPLACE FUNCTION assert_role_exclusivity() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%s in {%s}', r.rolname, grp.groups), '; ' ORDER BY r.rolname)
    INTO offenders
    FROM pg_roles r
    JOIN LATERAL (
      SELECT string_agg(g.rolname, ', ' ORDER BY g.rolname) AS groups, count(*) AS n
        FROM pg_auth_members m
        JOIN pg_roles g ON g.oid = m.roleid
       WHERE m.member = r.oid AND g.rolname IN ('app_rw', 'svc_scorer', 'svc_onboard')
    ) grp ON true
   WHERE r.rolcanlogin AND grp.n > 1;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'role exclusivity violated: %. Each login role must be in exactly one of app_rw / svc_scorer / svc_onboard.', offenders;
  END IF;

  -- auth_verifier owns the token verifier and can read the signing secret. No
  -- application role may borrow it.
  SELECT string_agg(g.rolname, ', ' ORDER BY g.rolname) INTO offenders
    FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.member
    JOIN pg_roles v ON v.oid = m.roleid AND v.rolname = 'auth_verifier'
   WHERE g.rolname IN ('app_rw', 'svc_scorer', 'svc_onboard');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'role exclusivity violated: % may read the JWT signing secret via auth_verifier.', offenders;
  END IF;
END $$;

REVOKE ALL ON FUNCTION assert_role_exclusivity() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- (B) Billing gate — block before create
-- ---------------------------------------------------------------------------

CREATE TABLE workspace_subscriptions (
  workspace_id       uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan               text NOT NULL CHECK (plan IN ('trial', 'starter', 'growth', 'scale')),
  status             text NOT NULL CHECK (status IN ('active', 'past_due', 'cancelled')),
  brand_limit        integer NOT NULL CHECK (brand_limit >= 0),
  current_period_end timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workspace_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_subscriptions FORCE  ROW LEVEL SECURITY;

GRANT SELECT ON workspace_subscriptions TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_subscriptions TO svc_onboard;

CREATE POLICY subscription_of_workspace ON workspace_subscriptions FOR SELECT USING (workspace_id = current_workspace_id());
CREATE POLICY onboard_all_subscriptions ON workspace_subscriptions FOR ALL TO svc_onboard USING (true) WITH CHECK (true);

-- BEFORE INSERT, so an unpaid entitlement never exists — not for a concurrent
-- reader, not in the WAL, and not if the process dies before it can clean up.
CREATE OR REPLACE FUNCTION assert_entitlement_is_paid_for() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sub  workspace_subscriptions%ROWTYPE;
  held integer;
BEGIN
  SELECT * INTO sub FROM workspace_subscriptions s WHERE s.workspace_id = NEW.workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing: workspace % has no subscription; entitlement refused', NEW.workspace_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF sub.status <> 'active' THEN
    RAISE EXCEPTION 'billing: subscription for workspace % is %; entitlement refused', NEW.workspace_id, sub.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF sub.current_period_end <= now() THEN
    RAISE EXCEPTION 'billing: subscription for workspace % lapsed at %; entitlement refused', NEW.workspace_id, sub.current_period_end
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO held FROM workspace_brands wb WHERE wb.workspace_id = NEW.workspace_id;
  IF held >= sub.brand_limit THEN
    RAISE EXCEPTION 'billing: workspace % holds %/% brands on plan %; entitlement refused',
      NEW.workspace_id, held, sub.brand_limit, sub.plan
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

-- Counting held brands and then inserting is a read-modify-write: two concurrent
-- INSERTs on the last seat both count N-1 and both proceed. This lock is what
-- actually holds the limit — the primary key bounds duplicates, not cardinality.
-- Trigger name order matters: BEFORE triggers fire alphabetically, and this one
-- has to run before the counting gate, hence the "_a_" / "_b_" prefixes.
CREATE OR REPLACE FUNCTION lock_workspace_for_entitlement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Advisory rather than a row lock on workspaces: it needs no write privilege
  -- on the identity table, and it is released with the transaction either way.
  PERFORM pg_advisory_xact_lock(hashtext('workspace_brands:' || NEW.workspace_id::text));
  RETURN NEW;
END $$;

CREATE TRIGGER workspace_brands_a_billing_lock
  BEFORE INSERT ON workspace_brands
  FOR EACH ROW EXECUTE FUNCTION lock_workspace_for_entitlement();

CREATE TRIGGER workspace_brands_b_billing_gate
  BEFORE INSERT ON workspace_brands
  FOR EACH ROW EXECUTE FUNCTION assert_entitlement_is_paid_for();
