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

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

CREATE TABLE workspace_cycles (
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  host             text        NOT NULL CHECK (host = lower(host) AND host <> ''),
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
  host         text        NOT NULL CHECK (host = lower(host) AND host <> ''),
  version      integer     NOT NULL CHECK (version >= 1),
  body         jsonb       NOT NULL,
  written_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, kind, host, version)
);

CREATE TABLE workspace_requests (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  kind         text        NOT NULL CHECK (kind IN ('category', 'competitors', 'custom-prompts')),
  host         text        NOT NULL CHECK (host = lower(host) AND host <> ''),
  body         jsonb       NOT NULL,
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

CREATE OR REPLACE FUNCTION ws_put_cycle(p_host text, p_day date, p_algo_version text, p_comparison_basis text, p_result jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ws uuid := ws_required();
BEGIN
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'workspace: a cycle result must be an object'; END IF;
  INSERT INTO workspace_cycles (workspace_id, host, day, algo_version, comparison_basis, result)
  VALUES (ws, p_host, p_day, p_algo_version, p_comparison_basis, p_result)
  ON CONFLICT (workspace_id, host, day, algo_version) DO UPDATE
     SET result = EXCLUDED.result, comparison_basis = EXCLUDED.comparison_basis, written_at = now();
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
  -- which every writer of this workspace already references.
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
-- ws_required() is read by the four writers, which run as svc_onboard.
GRANT EXECUTE ON FUNCTION ws_required()                                            TO svc_onboard, app_rw;
GRANT EXECUTE ON FUNCTION ws_put_cycle(text, date, text, text, jsonb)              TO app_rw;
GRANT EXECUTE ON FUNCTION ws_put_document(text, text, jsonb)                       TO app_rw;
GRANT EXECUTE ON FUNCTION ws_file_request(text, text, jsonb, timestamptz)          TO app_rw;
GRANT EXECUTE ON FUNCTION ws_resolve_request(text, text, timestamptz, text, text, text) TO app_rw;

DO $$ BEGIN EXECUTE format('REVOKE svc_onboard FROM %I', current_user); END $$;
