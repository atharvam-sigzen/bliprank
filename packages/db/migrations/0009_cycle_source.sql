-- 0009_cycle_source — a cycle records whether a person started it or the
-- daily loop did. MVP_PLAN C3 (PRODUCT_GOAL points 6 and 9). 2026-09-16.
--
-- HUMAN-OWNED (CLAUDE.md §4: RLS policies and the tenancy model). Written by an
-- agent session; ⚠️ HUMAN REVIEW REQUIRED before it is applied anywhere.
--
-- WHY. The daily loop files its cycles through the same ws_put_cycle a
-- hand-started scan uses, in the workspace of the person who switched the
-- domain on, as that person (ADR-0018 D6). Nothing in the row said which of
-- the two it was: a loop-filed cycle and the tracker's own hand-started one
-- were indistinguishable (the C2 tenancy review, "no actor on a loop-filed
-- cycle"). Point 9 wants every number's provenance to travel with it, and
-- point 6 wants the daily trend to be demonstrably the loop's work, so the
-- source is a column.
--
-- WHAT IT IS, AND IS NOT. `source` is `hand` or `loop`, taken from the result
-- the app wrote (`result.run.source`, stamped by the runner from the caller's
-- declaration: the loop says `loop`, every other path says nothing and gets
-- `hand`). It is the app tier's word, verified by nothing in the database,
-- because the loop has no identity of its own yet: a job's token is minted
-- for the tracking account and the verifier cannot tell it from a session
-- (ADR-0018 D6 records the service identity as the owner's alternative). When
-- that identity exists, a `loop` claim in the stamped context is what this
-- column should be checked against; until then the column is provenance, not
-- authorisation, and no decision reads it.
--
-- THE SIGNATURE OF ws_put_cycle IS UNCHANGED, deliberately: the deploy gate
-- declares the tenant-callable definers by signature in two places (the
-- exposure manifest, 0008, and check-deploy.sql), and a new signature would
-- be refused there until both were re-declared. Reading the source from the
-- result keeps the door as declared.
--
-- ONE TRANSACTION, the record first, the writing group granted and revoked
-- inside it, as every file from 0003 on (B3r; migrations.test.ts cuts this
-- file after its GRANT and proves the owner is left in no group).

BEGIN;

INSERT INTO schema_migrations (name) VALUES ('0009_cycle_source');

ALTER TABLE workspace_cycles ADD COLUMN source text NOT NULL DEFAULT 'hand' CHECK (source IN ('hand', 'loop'));

DO $$ BEGIN EXECUTE format('GRANT svc_onboard TO %I', current_user); END $$;

-- 0004's writer, with one addition: the source column, from the result's own
-- run stamp; anything but the two words is refused, as is a stamp that
-- disagrees with a stored row's source on re-write (a same-day re-write is
-- the same measurement, and the same measurement has one source).
CREATE OR REPLACE FUNCTION ws_put_cycle(p_host text, p_day date, p_algo_version text, p_comparison_basis text, p_result jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ws  uuid := ws_required();
  src text := coalesce(p_result->'run'->>'source', 'hand');
BEGIN
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'workspace: a cycle result must be an object'; END IF;
  IF p_result->>'status' IS DISTINCT FROM 'scanned' THEN RAISE EXCEPTION 'workspace: only a scanned cycle is filed, not %', coalesce(p_result->>'status', 'no status'); END IF;
  IF p_result->>'domain' IS DISTINCT FROM p_host THEN RAISE EXCEPTION 'workspace: the result names domain %, filed under %', p_result->>'domain', p_host; END IF;
  IF coalesce(p_result->'run'->>'day', p_day::text) IS DISTINCT FROM p_day::text THEN
    RAISE EXCEPTION 'workspace: the result was collected on %, filed under %', p_result->'run'->>'day', p_day;
  END IF;
  IF src NOT IN ('hand', 'loop') THEN RAISE EXCEPTION 'workspace: a cycle is started by hand or by the loop, not by %', src; END IF;
  INSERT INTO workspace_cycles (workspace_id, host, day, algo_version, comparison_basis, result, source)
  VALUES (ws, p_host, p_day, p_algo_version, p_comparison_basis, p_result, src)
  ON CONFLICT (workspace_id, host, day, algo_version) DO UPDATE
     SET result = EXCLUDED.result, written_at = now()
   WHERE workspace_cycles.comparison_basis = EXCLUDED.comparison_basis
     AND workspace_cycles.source = EXCLUDED.source;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace: % on % under % is already stored on another basis or from another source; a different measurement is not a re-write', p_host, p_day, p_algo_version
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

DO $$ BEGIN EXECUTE format('REVOKE svc_onboard FROM %I', current_user); END $$;

COMMIT;
