-- 0005_workspace_role_claim — the role a session holds in its workspace
-- travels in the workspace token, is verified against workspace_members when
-- the token is presented, is stamped into the tenant context beside the
-- workspace and the account, and the two definer writers that APPLY a
-- decision (ws_put_document, ws_resolve_request) refuse unless that role is
-- owner or admin. MVP_PLAN B3c item 8 (PRODUCT_GOAL points 7 and 9).
-- 2026-09-15.
--
-- HUMAN-OWNED (CLAUDE.md §4: RLS policies and the tenancy model). Written by
-- an agent session on the owner's instruction; ⚠️ HUMAN REVIEW REQUIRED
-- before it is applied anywhere.
--
-- WHAT WAS WRONG. B4 made corrections operator actions: an owner or admin
-- applies, a member files a request. The database enforced membership on
-- every write (ws_required) and nothing about role, and the token carried no
-- role, so the whole of "who may apply" was one TypeScript boolean,
-- applies() in apps/public/lib/workspace-access.ts; a route that wrote a
-- document without it wrote as a member (B4 audit MAJOR 1, B3c).
--
-- THE DESIGN. The server reads the role from workspaces_of (0003) when it
-- mints and asserts it in the token as it asserts `sub`. The database does
-- NOT trust the assertion: set_workspace_jwt re-reads workspace_members and
-- refuses a token whose claim disagrees, so a token minted before a demotion
-- cannot act with the old role, and a token that names no role cannot act at
-- all. What is stamped is the verified role. The writers read it through
-- current_workspace_role(), a definer reader shaped exactly like
-- current_workspace_id(): the caller's own context or nothing, and no
-- argument to lie about.
--
-- WHAT A MEMBER CAN STILL DO. File a request (ws_file_request) and file a
-- cycle (ws_put_cycle): neither applies a decision.
--
-- ⚠️ CONSEQUENCE FOR A HUMAN TO WEIGH. ws_put_document is also how a FIRST
-- category record is written when a domain is scanned or previewed, so under
-- this rule a member's session cannot record a first category: a member's
-- preview or scan of a domain with no record fails at the record write,
-- before anything is spent. If a member should be able to start a first
-- scan, the rule below is where that is decided (version 1 of a
-- category-record by any member; every other write by an owner or admin),
-- and it is one condition in ws_put_document. Today no member exists on the
-- deployment: members are added by the onboarding role only, and D1 has not
-- been built.
--
-- ONE TRANSACTION, as 0003 and 0004: the migration owner joins two writing
-- groups to replace verifier-owned and svc_onboard-owned functions, and a
-- failure between a GRANT and its REVOKE must leave no standing membership
-- (B3r item 1; migrations.test.ts cuts this file after its first GRANT and
-- asserts that).
BEGIN;

-- The migration record first (0003, section 0).
INSERT INTO schema_migrations (name) VALUES ('0005_workspace_role_claim');

-- ---------------------------------------------------------------------------
-- 1. The context carries the role
-- ---------------------------------------------------------------------------

-- Nullable: a row stamped by the two-argument path before this migration
-- carries none, and none is refused by every writer below. The check is the
-- one workspace_members.role carries (0000).
ALTER TABLE auth_tenant_context ADD COLUMN role text CHECK (role IN ('owner', 'admin', 'member'));

-- ---------------------------------------------------------------------------
-- 2. The verifier's functions (owned by auth_verifier, 0002 §4 and §7)
-- ---------------------------------------------------------------------------

DO $$ BEGIN EXECUTE format('GRANT auth_verifier TO %I', current_user); END $$;

-- The only writer, now three-argument. The two-argument form is dropped so
-- that no path can stamp a context without deciding a role.
DROP FUNCTION stamp_tenant_context(uuid, uuid);
CREATE FUNCTION stamp_tenant_context(ws uuid, acct uuid, member_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO auth_tenant_context (backend_pid, xact_id, workspace_id, account_id, role)
  VALUES (pg_backend_pid(), pg_current_xact_id(), ws, acct, member_role)
  ON CONFLICT (backend_pid) DO UPDATE
     SET xact_id      = EXCLUDED.xact_id,
         workspace_id = EXCLUDED.workspace_id,
         account_id   = EXCLUDED.account_id,
         role         = EXCLUDED.role,
         stamped_at   = clock_timestamp();
END $$;
ALTER FUNCTION stamp_tenant_context(uuid, uuid, text) OWNER TO auth_verifier;
REVOKE ALL ON FUNCTION stamp_tenant_context(uuid, uuid, text) FROM PUBLIC;

-- The reader, shaped exactly as current_workspace_id(): STABLE, definer,
-- keyed on this backend and this transaction, nothing to pass. Safe for
-- anyone to call for the same reason the other two readers are.
CREATE FUNCTION current_workspace_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.role FROM auth_tenant_context c
   WHERE c.backend_pid = pg_backend_pid()
     AND c.xact_id = pg_current_xact_id_if_assigned()
$$;
ALTER FUNCTION current_workspace_role() OWNER TO auth_verifier;
GRANT EXECUTE ON FUNCTION current_workspace_role() TO PUBLIC;

-- 0002's verifier, every check kept in its order, plus the role section
-- after membership: a non-member is still told only that it is not one.
CREATE OR REPLACE FUNCTION set_workspace_jwt(token text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  parts       text[];
  header      jsonb;
  payload     jsonb;
  k           auth_signing_keys%ROWTYPE;
  ws          uuid;
  acct        uuid;
  member_role text;
  now_s       bigint := extract(epoch FROM clock_timestamp())::bigint;
BEGIN
  IF token IS NULL THEN RAISE EXCEPTION 'auth: no token'; END IF;
  parts := string_to_array(token, '.');
  IF array_length(parts, 1) IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'auth: malformed token'; END IF;

  BEGIN
    header  := convert_from(b64url_decode(parts[1]), 'utf8')::jsonb;
    payload := convert_from(b64url_decode(parts[2]), 'utf8')::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'auth: undecodable token';
  END;
  -- IS DISTINCT FROM throughout, never <> (0002): an omitted claim must not
  -- pass by being NULL.
  IF jsonb_typeof(header)  IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'auth: token header must be an object'; END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'auth: token payload must be an object'; END IF;

  IF header->>'alg' IS DISTINCT FROM 'HS256' THEN RAISE EXCEPTION 'auth: unsupported alg'; END IF;
  IF jsonb_typeof(header->'kid') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'auth: token has no kid'; END IF;

  SELECT * INTO k FROM auth_signing_keys s
   WHERE s.kid = header->>'kid' AND (s.retired_at IS NULL OR s.retired_at > now());
  IF NOT FOUND THEN RAISE EXCEPTION 'auth: unknown or retired key id'; END IF;

  -- Digests compared, not signatures (0002): a timing oracle on this
  -- comparison leaks a prefix of sha256(signature), which yields nothing.
  IF digest(b64url_encode(hmac(parts[1] || '.' || parts[2], k.secret, 'sha256')), 'sha256')
     IS DISTINCT FROM digest(parts[3], 'sha256') THEN
    RAISE EXCEPTION 'auth: bad signature';
  END IF;

  IF jsonb_typeof(payload->'iss') IS DISTINCT FROM 'string' OR payload->>'iss' IS DISTINCT FROM k.issuer THEN
    RAISE EXCEPTION 'auth: issuer mismatch';
  END IF;
  IF jsonb_typeof(payload->'aud') IS DISTINCT FROM 'string' OR payload->>'aud' IS DISTINCT FROM k.audience THEN
    RAISE EXCEPTION 'auth: audience mismatch';
  END IF;

  IF jsonb_typeof(payload->'exp') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'auth: exp missing or not a number'; END IF;
  IF (payload->>'exp')::numeric <= now_s THEN RAISE EXCEPTION 'auth: token expired'; END IF;
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

  -- A validly signed token still does not get to name a workspace its subject
  -- is not a member of. The signature proves who; membership decides what.
  SELECT m.role INTO member_role FROM workspace_members m WHERE m.account_id = acct AND m.workspace_id = ws;
  IF NOT FOUND THEN RAISE EXCEPTION 'auth: account is not a member of that workspace'; END IF;

  -- B3c item 8: the token names the role the server read when it minted;
  -- the database re-reads membership and refuses a claim that disagrees, so
  -- a token minted before a demotion cannot act with the old role, and a
  -- token that names no role cannot act at all. The message names neither
  -- value: the caller holds a signed token for this account and learns only
  -- that its claim is wrong.
  IF jsonb_typeof(payload->'role') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'auth: token is missing role'; END IF;
  IF payload->>'role' IS DISTINCT FROM member_role THEN RAISE EXCEPTION 'auth: token role does not match membership'; END IF;

  PERFORM stamp_tenant_context(ws, acct, member_role);
  RETURN ws;
END $$;

-- The owner-only path, for migrations, maintenance and the test harness,
-- stamps the workspace's owner where there is one, then an admin, then any
-- member (0002 took the first account by id, which under the rule below
-- could be a member that no maintenance write may act as).
CREATE OR REPLACE FUNCTION set_workspace(ws uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  principal uuid;
  principal_role text;
BEGIN
  SELECT m.account_id, m.role INTO principal, principal_role FROM workspace_members m
   WHERE m.workspace_id = ws
   ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.account_id
   LIMIT 1;
  IF principal IS NULL THEN
    RAISE EXCEPTION 'set_workspace: workspace % has no members, so there is no account to stamp', ws;
  END IF;
  PERFORM stamp_tenant_context(ws, principal, principal_role);
END $$;

DO $$ BEGIN EXECUTE format('REVOKE auth_verifier FROM %I', current_user); END $$;

-- ---------------------------------------------------------------------------
-- 3. The writers that apply a decision (owned by svc_onboard, 0004 §3)
-- ---------------------------------------------------------------------------

DO $$ BEGIN EXECUTE format('GRANT svc_onboard TO %I', current_user); END $$;

-- 0004's ws_put_document, verbatim, plus the role check first: applying a
-- decision is an owner's or admin's act, read from the context the verifier
-- stamped and never from an argument. NULL (no role stamped) is refused
-- with the rest. The write-once and expected-version rules are unchanged.
CREATE OR REPLACE FUNCTION ws_put_document(p_kind text, p_host text, p_body jsonb, p_expect_version integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ws   uuid := ws_required();
  next_version integer;
BEGIN
  IF coalesce(current_workspace_role(), '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'workspace: only an owner or admin applies a decision; this session is %', coalesce(current_workspace_role(), 'without a role')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(p_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'workspace: a document must be an object'; END IF;
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'workspace: document writes are not safe at REPEATABLE READ; use READ COMMITTED or SERIALIZABLE'
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  PERFORM 1 FROM workspaces w WHERE w.id = ws FOR UPDATE;
  SELECT coalesce(max(d.version), 0) + 1 INTO next_version FROM workspace_documents d
   WHERE d.workspace_id = ws AND d.kind = p_kind AND d.host = p_host;
  IF p_expect_version IS NULL THEN RAISE EXCEPTION 'workspace: a document write names the version it read (0 for none)'; END IF;
  IF next_version - 1 <> p_expect_version THEN
    RAISE EXCEPTION 'workspace: % for % is at version %, not %; read it again before deciding', p_kind, p_host, next_version - 1, p_expect_version
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO workspace_documents (workspace_id, kind, host, version, body) VALUES (ws, p_kind, p_host, next_version, p_body);
  RETURN next_version;
END $$;

-- 0004's ws_resolve_request, verbatim, plus the same check: marking a
-- request applied or declined is the operator's act.
CREATE OR REPLACE FUNCTION ws_resolve_request(p_kind text, p_host text, p_expect_requested_at timestamptz, p_status text, p_by text, p_note text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ws uuid := ws_required();
  n  integer;
BEGIN
  IF coalesce(current_workspace_role(), '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'workspace: only an owner or admin applies a decision; this session is %', coalesce(current_workspace_role(), 'without a role')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_status NOT IN ('applied', 'declined') THEN RAISE EXCEPTION 'workspace: a request resolves to applied or declined'; END IF;
  IF p_by IS NULL OR btrim(p_by) = '' THEN RAISE EXCEPTION 'workspace: a resolution names who made it'; END IF;
  UPDATE workspace_requests r
     SET status = p_status, resolved_at = now(), resolved_by = btrim(p_by), note = p_note
   WHERE r.workspace_id = ws AND r.kind = p_kind AND r.host = p_host AND r.status = 'pending'
     AND r.requested_at = p_expect_requested_at;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

DO $$ BEGIN EXECUTE format('REVOKE svc_onboard FROM %I', current_user); END $$;

COMMIT;
