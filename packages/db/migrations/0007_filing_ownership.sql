-- 0007_filing_ownership — who filed a request is recorded, and a member may
-- replace only the pending filing it made; an owner or admin may replace
-- any. MVP_PLAN B3d item 4, from the oversight pass on B3c. 2026-09-15.
--
-- HUMAN-OWNED (CLAUDE.md §4: RLS policies and the tenancy model). Written by
-- an agent session on the owner's instruction; ⚠️ HUMAN REVIEW REQUIRED
-- before it is applied anywhere.
--
-- WHY. ws_file_request (0004) kept one pending request per (workspace, kind,
-- host) by deleting whatever pending row stood and inserting the new one,
-- whoever had filed it. So one member could displace another member's
-- filing before an operator saw it, and the operator would apply the
-- displacer's request under the displaced member's silence.
--
-- WHAT. workspace_requests gains filed_by, the filing account's id as text
-- (the shape resolved_by has). ws_file_request stamps it from the verified
-- context, never from an argument, and when a pending request stands it
-- replaces that request only when the caller filed it or the caller's
-- stamped role is owner or admin; otherwise it refuses
-- (insufficient_privilege) and nothing changes. A pending row from before
-- this migration names no filer and is an owner's or admin's to replace. The
-- one-pending-per-host index, the twenty-resolved history and the write
-- path through the definer function are unchanged; the deploy check's
-- derivation still sees a writer that takes its workspace from
-- ws_required() and, since the insert names no status, no decision. One
-- transaction, the owner in svc_onboard only between the GRANT and the
-- REVOKE (B3r item 1).
BEGIN;

INSERT INTO schema_migrations (name) VALUES ('0007_filing_ownership');

ALTER TABLE workspace_requests ADD COLUMN filed_by text;

DO $$ BEGIN EXECUTE format('GRANT svc_onboard TO %I', current_user); END $$;

CREATE OR REPLACE FUNCTION ws_file_request(p_kind text, p_host text, p_body jsonb, p_requested_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ws    uuid := ws_required();
  me    text := current_account_id()::text;
  role  text := current_workspace_role();
  filer text;
  standing boolean;
  id    uuid;
BEGIN
  IF jsonb_typeof(p_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'workspace: a request must be an object'; END IF;
  -- B3d item 4: the pending request that stands may be replaced by the
  -- account that filed it, or by an owner or admin; a row that names no
  -- filer (from before 0007) only by an owner or admin.
  SELECT r.filed_by INTO filer FROM workspace_requests r
   WHERE r.workspace_id = ws AND r.kind = p_kind AND r.host = p_host AND r.status = 'pending';
  standing := FOUND;
  IF standing AND coalesce(role, '') NOT IN ('owner', 'admin') AND (filer IS NULL OR filer IS DISTINCT FROM me) THEN
    RAISE EXCEPTION 'workspace: a pending % request for % was filed by another account; an owner or admin can replace it', p_kind, p_host
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM workspace_requests r WHERE r.workspace_id = ws AND r.kind = p_kind AND r.host = p_host AND r.status = 'pending';
  INSERT INTO workspace_requests (workspace_id, kind, host, body, requested_at, filed_by)
  VALUES (ws, p_kind, p_host, p_body, coalesce(p_requested_at, now()), me)
  RETURNING workspace_requests.id INTO id;
  -- The file store kept twenty resolved requests per host; so does this (0004, audit m6).
  DELETE FROM workspace_requests r
   WHERE r.workspace_id = ws AND r.kind = p_kind AND r.host = p_host AND r.status <> 'pending'
     AND r.id IN (SELECT o.id FROM workspace_requests o
                   WHERE o.workspace_id = ws AND o.kind = p_kind AND o.host = p_host AND o.status <> 'pending'
                   ORDER BY o.requested_at DESC OFFSET 20);
  RETURN id;
END $$;

DO $$ BEGIN EXECUTE format('REVOKE svc_onboard FROM %I', current_user); END $$;

COMMIT;
