-- 0004_workspace_state — the grader's per-domain state, scoped by workspace:
-- cycles, the versioned documents (category record, competitor override,
-- custom prompt set) and the requests visitors file. MVP_PLAN B3, owner
-- decision D3 (PRODUCT_GOAL points 1, 7, 9). 2026-09-10.
--
-- HUMAN-OWNED (CLAUDE.md §4: RLS policies and the tenancy model). Written by an
-- agent session; ⚠️ HUMAN REVIEW REQUIRED before it is applied anywhere.
--
-- WHAT MOVES HERE. Until now `services/grader/data-live` held, per machine,
-- whole-file JSON stores keyed by host: results/cycles/<host>/<day>.json,
-- domain-categories.json, competitor-overrides.json, custom-prompts.json and
-- the three *-requests.json files. Their shapes are TypeScript types in
-- services/grader/src (cycles.ts, resolve-category.ts, override-store.ts,
-- custom-prompts.ts, category-requests.ts, competitor-overrides.ts) and their
-- invariants — write-once first decision, version N+1 on every change,
-- history kept whole, one pending request per host, an optimistic check on
-- resolve — live in those modules. This migration keeps the documents as
-- jsonb (the TypeScript type stays the schema) and makes the structural
-- invariants the database's: the key columns, the version sequence, one
-- pending per host, and who may write.
--
-- Raw answers are NOT here (R4): they stay in R2 behind the collector's blob
-- store, indexed in Upstash. What a cycle row holds is the scored result the
-- app already serves, one row per (workspace, host, day, algo_version).
--
-- WHO WRITES, AND HOW THE WORKSPACE IS CHOSEN. The tenant role holds SELECT
-- only, as on every other table. Writes go through SECURITY DEFINER functions
-- owned by svc_onboard, and every one of them takes the workspace from
-- current_workspace_id() — the context set_workspace_jwt() stamped from a
-- verified token — never from an argument. A caller with no context is
-- refused; a caller can therefore write into exactly the workspace its token
-- named, and only a member's token names it (0002). This is the 0003 pattern
-- (definer functions with fixed bodies) with the trust boundary one step
-- tighter: nothing the caller passes chooses the tenant.
--
-- R5 for cycles. A cycle row is keyed by algo_version as well as by day: a
-- re-score under a new version is a NEW row and the old one stays; a re-write
-- under the same version replaces the row, which ADR-0012 permits only
-- because same-version means same rules (the file store's idempotent
-- same-day re-write, made explicit).
--
-- Versioned documents are INSERT-only: version N+1 is a new row and the
-- earlier rows ARE the `superseded` history the TypeScript types carry. No
-- UPDATE or DELETE is granted on them to anyone but the migration owner.
-- Requests are the one place a row changes state (pending → applied |
-- declined), and only through ws_resolve_request with the same optimistic
-- check the file store makes.

-- ONE TRANSACTION. The GRANT/REVOKE pair around the definer functions must
-- not be left half-done by a failure between them: a migration owner left a
-- standing member of svc_onboard holds unbounded write on identity and state
-- (2026-09-10 tenancy audit, m7). check-deploy.sql asserts the property too.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

-- Hosts are bounded at the DNS limit and bodies at 64 KiB on the tables a
-- visitor can reach through a filing route (audit m5); a cycle result is
-- the app's own scored output and carries its own bounds.
CREATE TABLE workspace_cycles (
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  host             text        NOT NULL CHECK (host = lower(host) AND host <> '' AND length(host) <= 253),
  day              date        NOT NULL,
  algo_version     text        NOT NULL CHECK (algo_version <> ''),
  comparison_basis text        NOT NULL,
  result           jsonb       NOT NULL,
  written_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, host, day, algo_version)
);

CREATE TABLE workspace_documents (
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  kind         text        NOT NULL CHECK (kind IN ('category-record', 'competitor-override', 'custom-prompts')),
  host         text        NOT NULL CHECK (host = lower(host) AND host <> '' AND length(host) <= 253),
  version      integer     NOT NULL CHECK (version >= 1),
  body         jsonb       NOT NULL CHECK (pg_column_size(body) < 65536),
  written_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, kind, host, version)
);

CREATE TABLE workspace_requests (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  kind         text        NOT NULL CHECK (kind IN ('category', 'competitors', 'custom-prompts')),
  host         text        NOT NULL CHECK (host = lower(host) AND host <> '' AND length(host) <= 253),
  body         jsonb       NOT NULL CHECK (pg_column_size(body) < 65536),
  requested_at timestamptz NOT NULL DEFAULT now(),
  status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'declined')),
  resolved_at  timestamptz,
  resolved_by  text,
  note         text,
  CHECK ((status = 'pending') = (resolved_at IS NULL))
);
-- One pending request per (workspace, kind, host): filing again replaces.
CREATE UNIQUE INDEX workspace_requests_one_pending ON workspace_requests (workspace_id, kind, host) WHERE status = 'pending';
CREATE INDEX workspace_requests_by_host ON workspace_requests (workspace_id, kind, host, requested_at);

-- ---------------------------------------------------------------------------
-- 2. RLS: the tenant reads its own workspace; the writer role writes
-- ---------------------------------------------------------------------------

ALTER TABLE workspace_cycles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_cycles    FORCE  ROW LEVEL SECURITY;
ALTER TABLE workspace_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_documents FORCE  ROW LEVEL SECURITY;
ALTER TABLE workspace_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_requests  FORCE  ROW LEVEL SECURITY;

GRANT SELECT ON workspace_cycles, workspace_documents, workspace_requests TO app_rw;
GRANT SELECT, INSERT         ON workspace_cycles, workspace_documents TO svc_onboard;
GRANT UPDATE (result, comparison_basis, written_at) ON workspace_cycles TO svc_onboard;
GRANT SELECT, INSERT, DELETE ON workspace_requests TO svc_onboard;
GRANT UPDATE (status, resolved_at, resolved_by, note) ON workspace_requests TO svc_onboard;

CREATE POLICY cycles_of_workspace    ON workspace_cycles    FOR SELECT USING (workspace_id = current_workspace_id());
CREATE POLICY documents_of_workspace ON workspace_documents FOR SELECT USING (workspace_id = current_workspace_id());
CREATE POLICY requests_of_workspace  ON workspace_requests  FOR SELECT USING (workspace_id = current_workspace_id());

CREATE POLICY onboard_all_cycles    ON workspace_cycles    FOR ALL TO svc_onboard USING (true) WITH CHECK (true);
CREATE POLICY onboard_all_documents ON workspace_documents FOR ALL TO svc_onboard USING (true) WITH CHECK (true);
CREATE POLICY onboard_all_requests  ON workspace_requests  FOR ALL TO svc_onboard USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. The writers: definer functions that take the workspace from the context
-- ---------------------------------------------------------------------------

DO $$ BEGIN EXECUTE format('GRANT svc_onboard TO %I', current_user); END $$;

-- The one line every writer starts with. Raises when no verified context is
-- stamped in this transaction, so a writer cannot be reached without a token.
CREATE OR REPLACE FUNCTION ws_required() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ws uuid;
BEGIN
  ws := current_workspace_id();
  IF ws IS NULL THEN RAISE EXCEPTION 'workspace: no verified tenant context in this transaction'; END IF;
  RETURN ws;
END $$;

-- The file store's own guards, kept (cycles.ts: a cycle is filed only when
-- it is `scanned`, under a day it can establish, and a file whose inner day
-- or domain disagrees with its name is skipped, "because a wrong one would
-- put this cycle's number on another cycle's point of the trend"). And the
-- basis is provenance (contracts/basis.ts): a same-day, same-version write
-- on a DIFFERENT basis is not the same measurement and is refused, never
-- replaced (audit M2, M3).
CREATE OR REPLACE FUNCTION ws_put_cycle(p_host text, p_day date, p_algo_version text, p_comparison_basis text, p_result jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ws uuid := ws_required();
BEGIN
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'workspace: a cycle result must be an object'; END IF;
  IF p_result->>'status' IS DISTINCT FROM 'scanned' THEN RAISE EXCEPTION 'workspace: only a scanned cycle is filed, not %', coalesce(p_result->>'status', 'no status'); END IF;
  IF p_result->>'domain' IS DISTINCT FROM p_host THEN RAISE EXCEPTION 'workspace: the result names domain %, filed under %', p_result->>'domain', p_host; END IF;
  IF coalesce(p_result->'run'->>'day', p_day::text) IS DISTINCT FROM p_day::text THEN
    RAISE EXCEPTION 'workspace: the result was collected on %, filed under %', p_result->'run'->>'day', p_day;
  END IF;
  INSERT INTO workspace_cycles (workspace_id, host, day, algo_version, comparison_basis, result)
  VALUES (ws, p_host, p_day, p_algo_version, p_comparison_basis, p_result)
  ON CONFLICT (workspace_id, host, day, algo_version) DO UPDATE
     SET result = EXCLUDED.result, written_at = now()
   WHERE workspace_cycles.comparison_basis = EXCLUDED.comparison_basis;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace: % on % under % is already stored on another basis; a different measurement is not a re-write', p_host, p_day, p_algo_version
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- The next version of a document, computed here so a caller cannot choose
-- one: N+1 over what the workspace already holds for that kind and host.
CREATE OR REPLACE FUNCTION ws_put_document(p_kind text, p_host text, p_body jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ws   uuid := ws_required();
  next_version integer;
BEGIN
  IF jsonb_typeof(p_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'workspace: a document must be an object'; END IF;
  -- Serialise two writers of one document: the lock is the workspace row,
  -- which every writer of this workspace already references. That holds at
  -- READ COMMITTED and SERIALIZABLE; at REPEATABLE READ a lock-only tuple
  -- does not raise and max(version) would come from a stale snapshot, so the
  -- level is refused, as 0002's gate and 0003's trigger refuse it (audit M4).
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'workspace: document writes are not safe at REPEATABLE READ; use READ COMMITTED or SERIALIZABLE'
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  PERFORM 1 FROM workspaces w WHERE w.id = ws FOR UPDATE;
  SELECT coalesce(max(d.version), 0) + 1 INTO next_version FROM workspace_documents d
   WHERE d.workspace_id = ws AND d.kind = p_kind AND d.host = p_host;
  INSERT INTO workspace_documents (workspace_id, kind, host, version, body) VALUES (ws, p_kind, p_host, next_version, p_body);
  RETURN next_version;
END $$;

-- Filing replaces the pending request for that host, as the file store did;
-- the replaced row is removed, the resolved ones are history.
CREATE OR REPLACE FUNCTION ws_file_request(p_kind text, p_host text, p_body jsonb, p_requested_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ws uuid := ws_required();
  id uuid;
BEGIN
  IF jsonb_typeof(p_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'workspace: a request must be an object'; END IF;
  DELETE FROM workspace_requests r WHERE r.workspace_id = ws AND r.kind = p_kind AND r.host = p_host AND r.status = 'pending';
  INSERT INTO workspace_requests (workspace_id, kind, host, body, requested_at)
  VALUES (ws, p_kind, p_host, p_body, coalesce(p_requested_at, now()))
  RETURNING workspace_requests.id INTO id;
  -- The file store kept twenty resolved requests per host; so does this,
  -- because an unauthenticated filing route with unbounded retention is a
  -- row-growth surface (audit m6).
  DELETE FROM workspace_requests r
   WHERE r.workspace_id = ws AND r.kind = p_kind AND r.host = p_host AND r.status <> 'pending'
     AND r.id IN (SELECT o.id FROM workspace_requests o
                   WHERE o.workspace_id = ws AND o.kind = p_kind AND o.host = p_host AND o.status <> 'pending'
                   ORDER BY o.requested_at DESC OFFSET 20);
  RETURN id;
END $$;

-- The optimistic check the file store makes: the pending request must still
-- be the one the operator read (same requested_at), else nothing changes and
-- false comes back.
CREATE OR REPLACE FUNCTION ws_resolve_request(p_kind text, p_host text, p_expect_requested_at timestamptz, p_status text, p_by text, p_note text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ws uuid := ws_required();
  n  integer;
BEGIN
  IF p_status NOT IN ('applied', 'declined') THEN RAISE EXCEPTION 'workspace: a request resolves to applied or declined'; END IF;
  IF p_by IS NULL OR btrim(p_by) = '' THEN RAISE EXCEPTION 'workspace: a resolution names who made it'; END IF;
  UPDATE workspace_requests r
     SET status = p_status, resolved_at = now(), resolved_by = btrim(p_by), note = p_note
   WHERE r.workspace_id = ws AND r.kind = p_kind AND r.host = p_host AND r.status = 'pending'
     AND r.requested_at = p_expect_requested_at;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

ALTER FUNCTION ws_required()                                            OWNER TO auth_verifier;
ALTER FUNCTION ws_put_cycle(text, date, text, text, jsonb)              OWNER TO svc_onboard;
ALTER FUNCTION ws_put_document(text, text, jsonb)                       OWNER TO svc_onboard;
ALTER FUNCTION ws_file_request(text, text, jsonb, timestamptz)          OWNER TO svc_onboard;
ALTER FUNCTION ws_resolve_request(text, text, timestamptz, text, text, text) OWNER TO svc_onboard;

REVOKE ALL ON FUNCTION ws_required()                                            FROM PUBLIC;
REVOKE ALL ON FUNCTION ws_put_cycle(text, date, text, text, jsonb)              FROM PUBLIC;
REVOKE ALL ON FUNCTION ws_put_document(text, text, jsonb)                       FROM PUBLIC;
REVOKE ALL ON FUNCTION ws_file_request(text, text, jsonb, timestamptz)          FROM PUBLIC;
REVOKE ALL ON FUNCTION ws_resolve_request(text, text, timestamptz, text, text, text) FROM PUBLIC;
-- ws_required() is read by the four writers, which run as svc_onboard, and by
-- nothing else. The tenant role deliberately holds no EXECUTE on it: a policy
-- written through this wrapper would not name current_workspace_id, so the
-- standing sweeps could not see it as scoped; without EXECUTE such a policy
-- raises for the tenant instead of returning rows (oversight review
-- 2026-09-10, B3r item 2).
GRANT EXECUTE ON FUNCTION ws_required()                                            TO svc_onboard;
GRANT EXECUTE ON FUNCTION ws_put_cycle(text, date, text, text, jsonb)              TO app_rw;
GRANT EXECUTE ON FUNCTION ws_put_document(text, text, jsonb)                       TO app_rw;
GRANT EXECUTE ON FUNCTION ws_file_request(text, text, jsonb, timestamptz)          TO app_rw;
GRANT EXECUTE ON FUNCTION ws_resolve_request(text, text, timestamptz, text, text, text) TO app_rw;

DO $$ BEGIN EXECUTE format('REVOKE svc_onboard FROM %I', current_user); END $$;

INSERT INTO schema_migrations (name) VALUES ('0004_workspace_state');

COMMIT;
