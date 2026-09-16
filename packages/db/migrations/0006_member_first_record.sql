-- 0006_member_first_record — a first category record is a measurement's
-- precondition, not a decision: ws_put_document allows version 1 of a
-- category-record for any member and keeps the owner/admin rule for every
-- other write. MVP_PLAN B3d item 2, decided by the oversight session on
-- 2026-09-15 (the owner may overrule), reversing the consequence 0005's
-- header recorded. 2026-09-15.
--
-- HUMAN-OWNED (CLAUDE.md §4: RLS policies and the tenancy model). Written by
-- an agent session on the owner's instruction; ⚠️ HUMAN REVIEW REQUIRED
-- before it is applied anywhere.
--
-- WHY. 0005 made every document write an owner's or admin's act. That also
-- covered the first category record a scan or preview writes, so a member
-- could not start measuring a new domain, and the routes refused such a
-- request before anything ran (the B3c review's stopgap). The oversight pass
-- decided the first record is not a correction: nothing is re-derived, no
-- earlier version is superseded, and it is the precondition of the
-- measurement a member is entitled to start. Corrections — version 2 and up
-- of the record, every version of a competitor override or a custom prompt
-- set, resolving a request — stay an owner's or admin's.
--
-- WHAT DOES NOT CHANGE. The role is still verified against membership and
-- stamped (0005); the writer still takes its workspace from the verified
-- context (ws_required); the write-once and expected-version rules hold, so
-- two members cannot both land version 1; the deploy check's derivation
-- (every writer of a decision reads current_workspace_role()) is satisfied by
-- the body below and the check runs unchanged; ws_resolve_request is
-- unchanged. One transaction, the owner in svc_onboard only between the
-- GRANT and the REVOKE (B3r item 1).
BEGIN;

INSERT INTO schema_migrations (name) VALUES ('0006_member_first_record');

DO $$ BEGIN EXECUTE format('GRANT svc_onboard TO %I', current_user); END $$;

-- 0004's ws_put_document with 0005's role check narrowed: the check needs the
-- version, so it follows the lock and the version computation; a member
-- correcting against a stale version is told about the version first.
CREATE OR REPLACE FUNCTION ws_put_document(p_kind text, p_host text, p_body jsonb, p_expect_version integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ws   uuid := ws_required();
  role text := current_workspace_role();
  next_version integer;
BEGIN
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
  -- B3d item 2: version 1 of a category record is any member's write; every
  -- other write applies a decision and is an owner's or admin's (0005),
  -- read from the context the verifier stamped, never from an argument.
  IF NOT (p_kind = 'category-record' AND next_version = 1) AND coalesce(role, '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'workspace: only an owner or admin applies a decision; this session is %', coalesce(role, 'without a role')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO workspace_documents (workspace_id, kind, host, version, body) VALUES (ws, p_kind, p_host, next_version, p_body);
  RETURN next_version;
END $$;

DO $$ BEGIN EXECUTE format('REVOKE svc_onboard FROM %I', current_user); END $$;

COMMIT;
