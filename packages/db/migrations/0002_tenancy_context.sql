-- 0002_tenancy_context — the tenant context stops living in a value the tenant
-- can write. Plus every other finding from the 2026-08-22 tenancy audit.
--
-- HUMAN-OWNED (CLAUDE.md §4: RLS policies and the tenancy model).
--
-- WHAT WAS WRONG (BLOCKER, found 2026-08-22, after 0001 was merged).
--
-- 0001 revoked EXECUTE on set_workspace(uuid) from the tenant and declared that
-- "the tenant role can no longer name a workspace at all". That control worked
-- and was beside the point. set_workspace() was never the authority —
-- current_workspace_id() was, and it read two GUCs:
--
--     current_setting('app.workspace_id')  /  current_setting('app.workspace_at')
--
-- Customised GUCs are USERSET. Any role sets them with a bare SET LOCAL, no
-- function call and no grant involved, and transaction_timestamp() is not a
-- secret — the caller just selects it. So the entire JWT verifier was an
-- OPTIONAL path. Reproduced on a non-superuser login role in app_rw only:
--
--     BEGIN;
--     SET LOCAL app.workspace_id = '<any workspace>';
--     SELECT set_config('app.workspace_at', transaction_timestamp()::text, true);
--     SELECT * FROM workspaces;      -- another tenant's row
--     SELECT * FROM accounts;        -- another tenant's user emails
--     SELECT * FROM score_rows;      -- another tenant's corpus slice
--
-- and the whole corpus by re-issuing set_config() per workspace id in the same
-- transaction. current_account_id() forged identically.
--
-- THE FIX. Context moves out of a GUC and into a table the tenant has no grant
-- on, written only by auth_verifier-owned code, keyed on (backend pid, xact id)
-- so it cannot outlive its transaction on a pooled connection. There is nothing
-- left for a tenant to set.

-- ---------------------------------------------------------------------------
-- 1. The context table
-- ---------------------------------------------------------------------------

-- UNLOGGED: this is per-connection scratch that is meaningless after a restart,
-- and it is written on every tenant transaction, so the WAL traffic would be
-- pure waste. One row per backend, upserted, so it cannot grow with traffic.
--
-- ACCEPTED CONSEQUENCE, stated rather than discovered later: THE TENANT READ
-- PATH IS NOW A WRITE PATH. set_workspace_jwt() INSERTs, so it fails with
-- "cannot execute INSERT in a read-only transaction" under SET TRANSACTION READ
-- ONLY or default_transaction_read_only=on, and an UNLOGGED table does not exist
-- on a physical standby at all. **Supabase read replicas are unavailable to
-- apps/web for as long as the context lives here.** Every tenant request also
-- consumes an xid and leaves one dead tuple on one hot row per backend, so this
-- table wants autovacuum attention that a table this small would not normally
-- get.
--
-- This is the price of the mechanism being sound, and it is not negotiable
-- downward: relaxing the write is what would put the context back somewhere the
-- tenant can reach. If replicas become necessary, that is an ADR — a signed
-- context in a GUC, verified per read, is the only shape that avoids the write,
-- and it puts an HMAC inside every RLS policy evaluation.
--
-- Backend-pid reuse is safe, and the reason is specific: xid8 is 64-bit and
-- monotonic, never reused, so a row left by a dead backend always carries a
-- strictly lower xact_id than any later transaction. Keying on the 32-bit xid,
-- or on a timestamp, would not have this property.
CREATE UNLOGGED TABLE auth_tenant_context (
  backend_pid  integer PRIMARY KEY,
  -- xid8, not a timestamp: the question is "was this stamped in THIS
  -- transaction", and a transaction id answers it exactly.
  xact_id      xid8        NOT NULL,
  workspace_id uuid        NOT NULL,
  account_id   uuid        NOT NULL,
  stamped_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE auth_tenant_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tenant_context FORCE  ROW LEVEL SECURITY;

-- No grant to app_rw, svc_scorer or svc_onboard. Deliberately absolute: the
-- entire point is that no application role can write its own context.
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_tenant_context TO auth_verifier;
CREATE POLICY tenant_context_verifier_only ON auth_tenant_context FOR ALL TO auth_verifier USING (true) WITH CHECK (true);

-- The only writer. Locked down exactly like set_workspace(uuid): no PUBLIC
-- EXECUTE, no application-role grant, so the only callers are the two
-- auth_verifier-owned functions below. check-deploy.sql asserts this.
CREATE OR REPLACE FUNCTION stamp_tenant_context(ws uuid, acct uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO auth_tenant_context (backend_pid, xact_id, workspace_id, account_id)
  VALUES (pg_backend_pid(), pg_current_xact_id(), ws, acct)
  ON CONFLICT (backend_pid) DO UPDATE
     SET xact_id      = EXCLUDED.xact_id,
         workspace_id = EXCLUDED.workspace_id,
         account_id   = EXCLUDED.account_id,
         stamped_at   = clock_timestamp();
END $$;

-- ---------------------------------------------------------------------------
-- 2. The readers every RLS policy depends on
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER so the policies can read a table the caller cannot.
--
-- pg_current_xact_id_if_assigned(), not pg_current_xact_id(): the plain form
-- ASSIGNS a transaction id, which would turn every read-only query that touches
-- a policy — including the scorer's — into an xid consumer. The "if assigned"
-- form returns NULL when none exists, and NULL cannot match a stored xid8, so a
-- transaction that never stamped a context gets no rows. Correct and free.
--
-- STABLE, so it is evaluated once per query rather than once per row.
CREATE OR REPLACE FUNCTION current_workspace_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.workspace_id FROM auth_tenant_context c
   WHERE c.backend_pid = pg_backend_pid()
     AND c.xact_id = pg_current_xact_id_if_assigned()
$$;

CREATE OR REPLACE FUNCTION current_account_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.account_id FROM auth_tenant_context c
   WHERE c.backend_pid = pg_backend_pid()
     AND c.xact_id = pg_current_xact_id_if_assigned()
$$;

-- ---------------------------------------------------------------------------
-- 3. Token verification, hardened (MINOR-1, MINOR-2, MINOR-6)
-- ---------------------------------------------------------------------------

-- MINOR-6: a token minted for one environment verified in another wherever the
-- signing key was shared. Issuer and audience are properties OF THE KEY, so
-- they cannot drift apart from it.
--
-- NULLABLE, AND THE CONSTRAINTS ARE `NOT VALID`. The first draft of this block
-- added them NOT NULL DEFAULT 'unset' with validating CHECKs, and it could not
-- be applied to any database that had run 0001 in service: such a database MUST
-- hold a signing key (check-deploy asserts it, and without one nobody can log
-- in), that row backfilled to 'unset', and the CHECK then rejected it. Verified:
-- the whole migration rolled back, leaving the GUC BLOCKER live in production.
--
-- So the table grandfathers what already exists and constrains only what is
-- written from here on. A legacy key with no issuer simply cannot verify a
-- token — the checks in set_workspace_jwt() are IS DISTINCT FROM, so NULL is a
-- mismatch and the key is inert. check-deploy then fails the deploy loudly
-- until a properly configured key exists. Fails closed at every step, and the
-- migration always applies.
ALTER TABLE auth_signing_keys ADD COLUMN issuer   text;
ALTER TABLE auth_signing_keys ADD COLUMN audience text;
-- MINOR-4. Defaulted rather than nullable: an unbounded default would be the
-- wrong direction to fail, and 12 hours is short enough to matter.
ALTER TABLE auth_signing_keys ADD COLUMN max_lifetime_s integer NOT NULL DEFAULT 43200;
-- Without a bound, `UPDATE ... SET max_lifetime_s = 2147483647` silently turns a
-- 12-hour ceiling into 68 years. Not tenant-reachable, but a control nothing
-- verified is not a control.
ALTER TABLE auth_signing_keys ADD CONSTRAINT auth_signing_keys_lifetime_sane
  CHECK (max_lifetime_s BETWEEN 60 AND 604800) NOT VALID;

ALTER TABLE auth_signing_keys
  ADD CONSTRAINT auth_signing_keys_live_is_configured CHECK (
    (retired_at IS NOT NULL AND retired_at <= now()) OR (
      length(kid) > 0 AND length(secret) >= 32
      AND issuer   IS NOT NULL AND length(issuer)   > 0
      AND audience IS NOT NULL AND length(audience) > 0
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION set_workspace_jwt(token text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  parts   text[];
  header  jsonb;
  payload jsonb;
  k       auth_signing_keys%ROWTYPE;
  ws      uuid;
  acct    uuid;
  now_s   bigint := extract(epoch FROM clock_timestamp())::bigint;
BEGIN
  IF token IS NULL THEN RAISE EXCEPTION 'auth: no token'; END IF;
  parts := string_to_array(token, '.');
  -- IS DISTINCT FROM, not <>: string_to_array('', '.') gives an empty array and
  -- array_length() is then SQL NULL, so `NULL <> 3` is NULL and the guard would
  -- do nothing. It was caught two checks later by the header type test, which is
  -- luck rather than design.
  IF array_length(parts, 1) IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'auth: malformed token'; END IF;

  BEGIN
    header  := convert_from(b64url_decode(parts[1]), 'utf8')::jsonb;
    payload := convert_from(b64url_decode(parts[2]), 'utf8')::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'auth: undecodable token';
  END;
  -- IS DISTINCT FROM throughout, never <>. jsonb_typeof(x->'missing') is SQL
  -- NULL, and `NULL <> 'string'` is NULL, which IF treats as false — so a token
  -- that simply OMITS a claim would skip the check that exists to require it.
  -- This is the same shape of mistake as the GUC this migration is fixing:
  -- a guard that looks present and does nothing.
  IF jsonb_typeof(header)  IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'auth: token header must be an object'; END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'auth: token payload must be an object'; END IF;

  -- Algorithm confusion is the classic JWT break: "alg":"none" and RS256-key-as-
  -- HMAC-secret both depend on the verifier trusting the header. This one accepts
  -- exactly one algorithm and reads the header for nothing else but the key id.
  IF header->>'alg' IS DISTINCT FROM 'HS256' THEN RAISE EXCEPTION 'auth: unsupported alg'; END IF;
  IF jsonb_typeof(header->'kid') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'auth: token has no kid'; END IF;

  -- One definition of "live", shared with the CHECK constraint: not retired, or
  -- retired at a future time. Scheduling a rotation must not kill the key now.
  SELECT * INTO k FROM auth_signing_keys s
   WHERE s.kid = header->>'kid' AND (s.retired_at IS NULL OR s.retired_at > now());
  IF NOT FOUND THEN RAISE EXCEPTION 'auth: unknown or retired key id'; END IF;

  -- Compare digests rather than the signatures themselves. NOT constant time —
  -- bytea equality is a length check plus memcmp, which short-circuits. It is
  -- sound for a different reason: what short-circuits is the comparison of two
  -- SHA-256 DIGESTS, so a timing oracle leaks a prefix of sha256(signature), and
  -- that does not yield the signature. Do not "simplify" this back to comparing
  -- the signatures directly, which would leak the signature prefix itself.
  IF digest(b64url_encode(hmac(parts[1] || '.' || parts[2], k.secret, 'sha256')), 'sha256')
     IS DISTINCT FROM digest(parts[3], 'sha256') THEN
    RAISE EXCEPTION 'auth: bad signature';
  END IF;

  -- MINOR-6. Bound the token to the environment that minted it, so a token from
  -- staging does not verify in production wherever a key is shared. `aud` may be
  -- an array per RFC 7519; we accept only a string, because a set-valued
  -- audience is a policy decision nobody here has made.
  IF jsonb_typeof(payload->'iss') IS DISTINCT FROM 'string' OR payload->>'iss' IS DISTINCT FROM k.issuer THEN
    RAISE EXCEPTION 'auth: issuer mismatch';
  END IF;
  IF jsonb_typeof(payload->'aud') IS DISTINCT FROM 'string' OR payload->>'aud' IS DISTINCT FROM k.audience THEN
    RAISE EXCEPTION 'auth: audience mismatch';
  END IF;

  -- MINOR-2. Gate on the JSON type before casting. Previously `exp` as the JSON
  -- string "9999999999" was accepted, while a float raised a raw 22P02 that
  -- never reached the auth: convention and echoed the attacker's value into the
  -- log. Every case failed closed, but a caller classifying failures by prefix
  -- saw a bad token as a database fault.
  IF jsonb_typeof(payload->'exp') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'auth: exp missing or not a number'; END IF;
  IF (payload->>'exp')::numeric <= now_s THEN RAISE EXCEPTION 'auth: token expired'; END IF;
  -- There is no revocation list. Membership is re-checked on every call, so
  -- removing someone takes effect on their next transaction; what this bounds is
  -- a stolen token belonging to a still-valid member. A key may not mint
  -- sessions that outlive its configured ceiling.
  IF (payload->>'exp')::numeric > now_s + k.max_lifetime_s THEN
    RAISE EXCEPTION 'auth: token lifetime exceeds the % second ceiling for this key', k.max_lifetime_s;
  END IF;
  IF payload ? 'nbf' THEN
    IF jsonb_typeof(payload->'nbf') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'auth: nbf is not a number'; END IF;
    IF (payload->>'nbf')::numeric > now_s THEN RAISE EXCEPTION 'auth: token not yet valid'; END IF;
  END IF;

  IF jsonb_typeof(payload->'sub') IS DISTINCT FROM 'string'
     OR jsonb_typeof(payload->'workspace_id') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'auth: token is missing sub or workspace_id';
  END IF;
  BEGIN
    acct := (payload->>'sub')::uuid;
    ws   := (payload->>'workspace_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'auth: sub or workspace_id is not a uuid';
  END;

  -- A validly signed token still does not get to name a workspace its subject is
  -- not a member of. The signature proves who; membership decides what.
  IF NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.account_id = acct AND m.workspace_id = ws) THEN
    RAISE EXCEPTION 'auth: account is not a member of that workspace';
  END IF;

  PERFORM stamp_tenant_context(ws, acct);
  RETURN ws;
END $$;

-- The owner-only path, for migrations, maintenance and the test harness. It now
-- stamps the same table rather than a GUC, so there is exactly one mechanism.
CREATE OR REPLACE FUNCTION set_workspace(ws uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  owner_acct uuid;
BEGIN
  SELECT m.account_id INTO owner_acct FROM workspace_members m
   WHERE m.workspace_id = ws ORDER BY m.account_id LIMIT 1;
  -- Raise rather than stamp a synthetic all-zero account. Nothing reads
  -- current_account_id() today; the day something does, a fabricated principal
  -- in the audit trail is worse than a failed maintenance call.
  IF owner_acct IS NULL THEN
    RAISE EXCEPTION 'set_workspace: workspace % has no members, so there is no account to stamp', ws;
  END IF;
  PERFORM stamp_tenant_context(ws, owner_acct);
END $$;

-- ---------------------------------------------------------------------------
-- 4. Ownership and grants
-- ---------------------------------------------------------------------------

ALTER FUNCTION stamp_tenant_context(uuid, uuid) OWNER TO auth_verifier;
ALTER FUNCTION current_workspace_id()           OWNER TO auth_verifier;
ALTER FUNCTION current_account_id()             OWNER TO auth_verifier;
ALTER FUNCTION set_workspace_jwt(text)          OWNER TO auth_verifier;
ALTER FUNCTION set_workspace(uuid)              OWNER TO auth_verifier;

-- Writers: nobody but the verifier's own code.
REVOKE ALL ON FUNCTION stamp_tenant_context(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_workspace(uuid)              FROM PUBLIC;

-- Readers: safe for anyone to call — they return that caller's own context or
-- nothing at all, and there is no argument to lie about.
GRANT EXECUTE ON FUNCTION current_workspace_id() TO PUBLIC;
GRANT EXECUTE ON FUNCTION current_account_id()   TO PUBLIC;

REVOKE ALL   ON FUNCTION set_workspace_jwt(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_workspace_jwt(text) TO app_rw;

-- ---------------------------------------------------------------------------
-- 5. MAJOR-1 — role exclusivity was blind to the mistake a human actually makes
-- ---------------------------------------------------------------------------

-- The old version enumerated pg_auth_members and filtered on the three GROUP
-- names, so it only saw a group role being a direct member of another. The real
-- deploy error is a LOGIN role granted two of them — `GRANT app_rw TO web_prod;
-- GRANT auth_verifier TO web_prod;` passed the check, and web_prod then read the
-- HS256 secret in plaintext and could forge a token for any workspace.
--
-- pg_has_role(..., 'USAGE') follows transitive membership, so an indirect grant
-- through an intermediate role is caught too.
--
-- Superusers are skipped: pg_has_role returns true for every role, so including
-- them would make this always fail. A superuser login role defeats the whole
-- model by definition; that is a deployment-posture question, and the assertion
-- below reports them rather than pretending to check them.
CREATE OR REPLACE FUNCTION assert_role_exclusivity() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  offenders text;
  supers    text;
BEGIN
  -- 'MEMBER', never 'USAGE'. pg_has_role(..., 'USAGE') asks whether privileges
  -- are AUTOMATICALLY INHERITED, and returns false for a NOINHERIT member. The
  -- attack is SET ROLE, not passive inheritance, and 'MEMBER' is the predicate
  -- for that. Verified: a NOINHERIT login role granted app_rw, svc_onboard AND
  -- auth_verifier scored false on all three under USAGE, passed this function
  -- and the whole deploy check, then ran `SET ROLE auth_verifier` and read the
  -- signing secret in plaintext. NOINHERIT is not exotic — it is the
  -- recommended posture for admin and service login roles, precisely so that
  -- privilege is opt-in per SET ROLE.
  SELECT string_agg(format('%s in {%s}', r.rolname, g.groups), '; ' ORDER BY r.rolname)
    INTO offenders
    FROM pg_roles r
    JOIN LATERAL (
      SELECT string_agg(grp, ', ' ORDER BY grp) AS groups, count(*) AS n
        FROM unnest(ARRAY['app_rw', 'svc_scorer', 'svc_onboard']) AS grp
       WHERE pg_has_role(r.rolname, grp, 'MEMBER')
    ) g ON true
   WHERE r.rolcanlogin AND NOT r.rolsuper AND g.n > 1;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'role exclusivity violated: %. Each login role must reach exactly one of app_rw / svc_scorer / svc_onboard.', offenders;
  END IF;

  -- auth_verifier owns the token verifier, the context writer and the signing
  -- secret. Nothing an application connects as may reach it, by any path.
  -- Both halves are needed: the login-role scan catches `GRANT auth_verifier TO
  -- web_prod`, and the group scan catches `GRANT auth_verifier TO app_rw`, which
  -- has no offending login role today but hands the capability to every future
  -- one. Checking only login roles would pass a database that is already wrong.
  SELECT string_agg(name, ', ' ORDER BY name) INTO offenders FROM (
    SELECT r.rolname AS name FROM pg_roles r
     WHERE r.rolcanlogin AND NOT r.rolsuper AND pg_has_role(r.rolname, 'auth_verifier', 'MEMBER')
    UNION
    SELECT grp FROM unnest(ARRAY['app_rw', 'svc_scorer', 'svc_onboard']) AS grp
     WHERE pg_has_role(grp, 'auth_verifier', 'MEMBER')
  ) reachers;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'role exclusivity violated: % can reach auth_verifier and therefore read the JWT signing secret and write tenant context.', offenders;
  END IF;

  -- The authority groups must not reach each other either. The scan above only
  -- has the login half, so `GRANT svc_onboard TO app_rw` passed in a database
  -- whose login roles had not been created yet — and then applied to every login
  -- role created afterwards.
  SELECT string_agg(format('%s -> %s', a, b), ', ' ORDER BY a, b) INTO offenders
    FROM unnest(ARRAY['app_rw', 'svc_scorer', 'svc_onboard']) AS a,
         unnest(ARRAY['app_rw', 'svc_scorer', 'svc_onboard']) AS b
   WHERE a <> b AND pg_has_role(a, b, 'MEMBER');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'role exclusivity violated: authority groups must not reach each other: %', offenders;
  END IF;

  -- A role that bypasses RLS reads every tenant with no token and no context,
  -- and every other assertion in this file is decoration for it. Verified: an
  -- app_rw login role with BYPASSRLS passed the entire deploy check and then
  -- read every workspace, account and score row.
  --
  -- BYPASSRLS matters more than SUPERUSER on the actual hosting target: managed
  -- Postgres (Supabase, RDS) will not let you create a superuser, but ALTER ROLE
  -- ... BYPASSRLS is available, so it is the realistic form of this mistake.
  --
  -- RAISE EXCEPTION, not WARNING. A WARNING does not fail psql under
  -- ON_ERROR_STOP, so the previous version reported the superuser case into a
  -- log nobody reads and passed the deploy.
  --
  -- The override is an ALLOWLIST of role names, not a boolean. A switch would
  -- have to be turned on to accept the one admin role every database has, and
  -- would then also accept the next role someone quietly grants BYPASSRLS to —
  -- which is the whole finding. Naming the roles keeps the exception scoped to
  -- the roles you actually decided about:
  --
  --   SET bliprank.rls_bypass_allowed = 'postgres, breakglass_ro';
  --
  -- EVERY role, not only rolcanlogin. RLS bypass is evaluated against the
  -- CURRENT user after SET ROLE, not the authenticated one, so a NOLOGIN role
  -- with BYPASSRLS is reachable and was invisible to the previous scan.
  -- Verified: `CREATE ROLE reporting NOLOGIN BYPASSRLS; GRANT app_rw TO
  -- reporting; GRANT reporting TO web_prod;` passed the whole deploy check, and
  -- web_prod read every tenant after one SET ROLE. So did the blunter
  -- `ALTER ROLE app_rw BYPASSRLS`, which needs no extra role at all and is the
  -- plausible reaction to "RLS is blocking my job".
  SELECT string_agg(format('%s(%s)', r.rolname, CASE WHEN r.rolsuper THEN 'SUPERUSER' ELSE 'BYPASSRLS' END), ', ' ORDER BY r.rolname)
    INTO supers
    FROM pg_roles r
   WHERE (r.rolsuper OR r.rolbypassrls) AND r.rolname NOT LIKE 'pg\_%'
     AND r.rolname <> ALL (
           SELECT btrim(x) FROM unnest(string_to_array(
             coalesce(current_setting('bliprank.rls_bypass_allowed', true), ''), ',')) AS x);

  IF supers IS NOT NULL THEN
    RAISE EXCEPTION 'these roles bypass RLS entirely and read every tenant: %. Remove the attribute, or name them in bliprank.rls_bypass_allowed to accept them deliberately.', supers;
  END IF;
END $$;

REVOKE ALL ON FUNCTION assert_role_exclusivity() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 6. MINOR-3, MINOR-4, MINOR-5 — the billing gate
-- ---------------------------------------------------------------------------

-- MINOR-4: pg_advisory_xact_lock and hashtext are both PUBLIC-executable, so a
-- tenant could hold the gate's exact key (verified: an app_rw-only login role
-- acquired it) and stall entitlement provisioning. hashtext also returns int4,
-- so unrelated workspaces collide in a 32-bit space.
--
-- MINOR-5: the lock was never tested. Deleting the trigger changed no assertion,
-- because PGlite is a single in-process connection and cannot open two
-- transactions at once — the race is untestable in this harness in either
-- direction.
--
-- Both go away by locking the row the gate already has to read. FOR UPDATE on
-- workspace_subscriptions is a tenant-unreachable lock (app_rw has SELECT only,
-- and a plain SELECT does not queue behind it), it needs no separate trigger,
-- and it is scoped to exactly one workspace with no hash collisions.
DROP TRIGGER IF EXISTS workspace_brands_a_billing_lock ON workspace_brands;
DROP FUNCTION IF EXISTS lock_workspace_for_entitlement();

CREATE OR REPLACE FUNCTION assert_entitlement_is_paid_for() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sub  workspace_subscriptions%ROWTYPE;
  held integer;
BEGIN
  -- The count below is a read-modify-write: two concurrent inserts on the last
  -- seat would both count N-1 and both proceed. Serialising on the subscription
  -- row fixes that at READ COMMITTED, where the second transaction re-reads
  -- after the first commits. Under SERIALIZABLE, SSI catches the write skew.
  -- REPEATABLE READ is the one level where neither holds: the second
  -- transaction's snapshot predates the first's commit, so it still counts N-1
  -- and no serialization failure is raised, because the two rows never conflict.
  -- Refuse rather than silently over-provision.
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'billing: entitlement writes are not safe at REPEATABLE READ; use READ COMMITTED or SERIALIZABLE'
      USING ERRCODE = 'invalid_transaction_state';
  END IF;

  SELECT * INTO sub FROM workspace_subscriptions s
   WHERE s.workspace_id = NEW.workspace_id
   FOR UPDATE;

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

  -- Correct for both operations without a TG_OP branch: on INSERT the new row
  -- does not exist yet, and on a move the row still counts against its OLD
  -- workspace, not this one. (Referencing OLD here would also break the INSERT
  -- path, where it is unassigned.)
  SELECT count(*) INTO held FROM workspace_brands wb WHERE wb.workspace_id = NEW.workspace_id;
  IF held >= sub.brand_limit THEN
    RAISE EXCEPTION 'billing: workspace % holds %/% brands on plan %; entitlement refused',
      NEW.workspace_id, held, sub.brand_limit, sub.plan
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

-- MINOR-3: both triggers were BEFORE INSERT only, while svc_onboard holds
-- UPDATE on workspace_brands. Verified: an entitlement was moved onto a
-- workspace with no subscription row at all, and three were bulk-moved onto a
-- workspace whose limit is 2. Not tenant-reachable, so it is a trusted-service
-- footgun rather than a leak — a workspace-merge feature in onboarding would
-- have minted unpaid entitlements silently.
DROP TRIGGER IF EXISTS workspace_brands_b_billing_gate ON workspace_brands;
CREATE TRIGGER workspace_brands_billing_gate
  BEFORE INSERT ON workspace_brands
  FOR EACH ROW EXECUTE FUNCTION assert_entitlement_is_paid_for();

CREATE TRIGGER workspace_brands_billing_gate_move
  BEFORE UPDATE OF workspace_id ON workspace_brands
  FOR EACH ROW WHEN (NEW.workspace_id IS DISTINCT FROM OLD.workspace_id)
  EXECUTE FUNCTION assert_entitlement_is_paid_for();

-- ---------------------------------------------------------------------------
-- 7. MAJOR-2 — the migration owner's standing membership of auth_verifier
-- ---------------------------------------------------------------------------

-- 0001 granted auth_verifier to the migration owner so it could transfer
-- ownership of the verifier function, and never revoked it. The design puts the
-- signing secret behind FORCE RLS with a single TO auth_verifier policy
-- precisely so that owning the table is not enough to read it; the standing
-- grant handed that back, permanently and invisibly — and on Supabase the
-- migration DSN and the app DSN are both `postgres`.
--
-- Invisible on PGlite for a weaker reason than production: there the owner is a
-- superuser, so the membership changes nothing. A non-superuser production
-- migrator keeps a real one.
--
-- OPERATIONAL NOTE: every ALTER FUNCTION ... OWNER TO above must happen BEFORE
-- this revoke. A future migration that CREATE OR REPLACEs any auth_verifier-
-- owned function must re-grant, do the work, and revoke again — as this one does.
-- MINOR: ensure_score_partition() tested `pg_class.relname = part` with no
-- namespace qualification, so a temp table with a partition's name made the
-- helper silently skip creation and the scorer then failed with "no partition of
-- relation score_rows found for row". Availability, not tenancy, but free to fix.
CREATE OR REPLACE FUNCTION ensure_score_partition(month_start date) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  part text := 'score_rows_' || to_char(month_start, 'YYYY_MM');
  nxt  date := (month_start + interval '1 month')::date;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = part AND n.nspname = 'public'
  ) THEN
    EXECUTE format('CREATE TABLE public.%I PARTITION OF score_rows FOR VALUES FROM (%L) TO (%L)', part, month_start, nxt);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', part);
    EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', part);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO svc_scorer', part);
    EXECUTE format('GRANT SELECT ON public.%I TO app_rw', part);
    EXECUTE format('CREATE POLICY scores_via_entitlement ON public.%I FOR SELECT USING (EXISTS (SELECT 1 FROM workspace_brands wb WHERE wb.brand_id = %I.brand_id AND wb.workspace_id = current_workspace_id()))', part, part);
    EXECUTE format('CREATE POLICY scorer_inserts_scores ON public.%I FOR INSERT TO svc_scorer WITH CHECK (true)', part);
    EXECUTE format('CREATE POLICY scorer_reads_scores ON public.%I FOR SELECT TO svc_scorer USING (true)', part);
  END IF;
END $$;
REVOKE ALL ON FUNCTION ensure_score_partition(date) FROM PUBLIC;

DO $$ BEGIN EXECUTE format('REVOKE auth_verifier FROM %I', current_user); END $$;
