-- 0000_init — packages/db, PHASES.md 1.7.
-- Partitioned, immutable score storage + RLS-isolated tenancy from day one.
--
-- HUMAN-OWNED (CLAUDE.md §4: RLS policies and the tenancy model). Every policy
-- below is exercised by src/rls.test.ts (pglite — real Postgres, no infra) and
-- must survive tenancy-auditor review before anything ships on top of it.
--
-- SECURITY MODEL (hardened after the first tenancy-auditor pass):
--   * Authority lives in ROLES, never in GUCs. A GUC (app.workspace_id) can be
--     set by any connection, so it may only ever SCOPE reads under a role that
--     already has zero standing privilege. It must never GRANT anything.
--       - app_rw    : the tenant web app. Reads its own slice; cannot write the
--                     corpus, cannot self-grant entitlements, cannot mutate
--                     identity.
--       - svc_scorer: the scorer service. INSERTs score rows/aggregates. Not a
--                     member of app_rw; different DSN.
--       - svc_onboard: billing/onboarding. Writes accounts, workspaces,
--                     memberships and entitlements. Different DSN.
--     A tenant setting app.service='scorer' therefore achieves nothing — the
--     INSERT policy is TO svc_scorer, and roles cannot be self-assigned.
--   * Entitlement is GRANTED, not self-declared. A workspace sees a brand's
--     scores only if an entitlement row (written by svc_onboard) says so. The
--     tenant cannot register arbitrary brands to read the whole corpus.
--   * RLS is FORCED on every table (ENABLE does not bind the table owner;
--     migrations run as the owner). Partitions carry their own FORCE + policy —
--     a parent policy does not cover a direct partition query.
--   * Tenant context is transaction-scoped and stamped: a session-mode pooler
--     that leaks a GUC across transactions fails closed, not open.
--
-- Measurement is separate from tenancy (ARCHITECTURE §3.4): brands are global,
-- the corpus carries no workspace column, visibility is a filtered join.

-- ---------------------------------------------------------------------------
-- Roles (NOLOGIN; the app connects via login roles that are GRANTed these).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw')     THEN CREATE ROLE app_rw NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_scorer') THEN CREATE ROLE svc_scorer NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_onboard') THEN CREATE ROLE svc_onboard NOLOGIN; END IF;
END $$;

-- Tenant context. Returns the workspace ONLY when it was stamped in this same
-- transaction (transaction_timestamp() is constant within a txn, changes
-- between them). A stale GUC left on a pooled connection carries a stale
-- timestamp and resolves to NULL → no rows. Never errors, never defaults open.
CREATE OR REPLACE FUNCTION set_workspace(ws uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.workspace_id', ws::text, true);           -- is_local => true
  PERFORM set_config('app.workspace_at', transaction_timestamp()::text, true);
END $$;

CREATE OR REPLACE FUNCTION current_workspace_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN current_setting('app.workspace_at', true) = transaction_timestamp()::text
    THEN NULLIF(current_setting('app.workspace_id', true), '')::uuid
    ELSE NULL
  END
$$;

-- ---------------------------------------------------------------------------
-- Tenancy tables
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id)
);

-- ---------------------------------------------------------------------------
-- Shared measurement corpus (no workspace columns — deliberately)
-- ---------------------------------------------------------------------------
CREATE TABLE brands (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL,
  category  text NOT NULL,
  aliases   jsonb NOT NULL DEFAULT '[]',
  domains   jsonb NOT NULL DEFAULT '[]',
  UNIQUE (name, category)
);

-- Entitlements: the ONLY authority surface for reading the corpus. Written by
-- svc_onboard (billing/onboarding), never by the tenant. `relation` records
-- why the workspace may see the brand; it does not grant anything by itself.
CREATE TABLE workspace_brands (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id     uuid NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
  relation     text NOT NULL CHECK (relation IN ('own', 'competitor')),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  granted_by   uuid REFERENCES accounts(id),
  PRIMARY KEY (workspace_id, brand_id)
);

CREATE TABLE prompt_banks (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category  text NOT NULL,
  locale    text NOT NULL,
  geo       text NOT NULL,
  prompts   jsonb NOT NULL,
  version   integer NOT NULL DEFAULT 1,
  UNIQUE (category, locale, geo, version)
);

-- Score rows: immutable, version-stamped (rule R5), monthly-partitioned by day
-- (ARCHITECTURE §3.3). `day` is scheduler-assigned (ADR-0003), so partition
-- routing is not tenant-controlled. No DEFAULT partition: a row outside the
-- provisioned range fails loudly rather than poisoning pruning (a maintenance
-- job pre-creates next month — see the partition helper at the foot of this file).
CREATE TABLE score_rows (
  cell_key      text NOT NULL CHECK (cell_key ~ '^[0-9a-f]{64}$'),  -- ADR-0003 cache key
  day           date NOT NULL,
  engine        text NOT NULL,
  locale        text NOT NULL,
  geo           text NOT NULL,
  brand_id      uuid NOT NULL REFERENCES brands(id),
  algo_version  text NOT NULL,            -- rule R5: never mutate, re-version
  runs          integer NOT NULL CHECK (runs > 0),
  mentions      integer NOT NULL CHECK (mentions >= 0 AND mentions <= runs),
  citations     integer NOT NULL CHECK (citations >= 0 AND citations <= runs),
  first_pos_sum integer,
  sampled       jsonb NOT NULL DEFAULT '[]',
  scored_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cell_key, brand_id, algo_version, day)
) PARTITION BY RANGE (day);

CREATE TABLE score_rows_2026_08 PARTITION OF score_rows FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE score_rows_2026_09 PARTITION OF score_rows FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE INDEX score_rows_brand_day ON score_rows (brand_id, day);

CREATE TABLE score_aggregates (
  brand_id      uuid NOT NULL REFERENCES brands(id),
  engine        text NOT NULL,
  period_start  date NOT NULL,
  period        text NOT NULL CHECK (period IN ('day', 'week')),
  algo_version  text NOT NULL,
  signal        text NOT NULL CHECK (signal IN ('mention', 'citation', 'sentiment')),
  successes     integer NOT NULL CHECK (successes >= 0),
  trials        integer NOT NULL CHECK (trials >= successes),
  sampled       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (brand_id, engine, period, period_start, algo_version, signal)
);

-- ---------------------------------------------------------------------------
-- Grants. Least privilege per role. Immutability (rule R5) is a grant fact:
-- nobody gets UPDATE/DELETE on the corpus.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO app_rw, svc_scorer, svc_onboard;

-- Tenant app: read its slice; no corpus writes, no identity writes, no self-grant.
GRANT SELECT ON workspaces, workspace_members, workspace_brands, accounts, brands, prompt_banks TO app_rw;
GRANT SELECT ON score_rows, score_aggregates TO app_rw;

-- Scorer: append-only to the corpus.
GRANT SELECT, INSERT ON score_rows, score_aggregates TO svc_scorer;
GRANT SELECT ON brands, prompt_banks TO svc_scorer;

-- Onboarding/billing: identity + entitlements + brand/prompt-bank curation.
GRANT SELECT, INSERT, UPDATE, DELETE ON accounts, workspaces, workspace_members, workspace_brands TO svc_onboard;
GRANT SELECT, INSERT, UPDATE ON brands, prompt_banks TO svc_onboard;

-- Default privileges: future tables (e.g. next month's partition) are readable
-- by app_rw only if a migration says so — never auto-granted.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Row-level security. FORCE binds the owner too. Fail closed everywhere.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','workspaces','workspace_members','workspace_brands',
                           'brands','prompt_banks','score_rows','score_aggregates',
                           'score_rows_2026_08','score_rows_2026_09']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Tenancy tables: a workspace sees itself, its members, its entitlements.
CREATE POLICY workspace_self          ON workspaces        FOR SELECT USING (id = current_workspace_id());
CREATE POLICY members_of_workspace    ON workspace_members FOR SELECT USING (workspace_id = current_workspace_id());
CREATE POLICY brand_links_of_workspace ON workspace_brands FOR SELECT USING (workspace_id = current_workspace_id());
-- Accounts: visible only to co-members of the current workspace (read-only for app_rw).
CREATE POLICY accounts_in_workspace ON accounts FOR SELECT USING (EXISTS (
  SELECT 1 FROM workspace_members m
  WHERE m.account_id = accounts.id AND m.workspace_id = current_workspace_id()
));

-- Corpus reads: only for entitled brands of the current workspace.
CREATE POLICY scores_via_entitlement ON score_rows FOR SELECT USING (EXISTS (
  SELECT 1 FROM workspace_brands wb
  WHERE wb.brand_id = score_rows.brand_id AND wb.workspace_id = current_workspace_id()
));
CREATE POLICY aggregates_via_entitlement ON score_aggregates FOR SELECT USING (EXISTS (
  SELECT 1 FROM workspace_brands wb
  WHERE wb.brand_id = score_aggregates.brand_id AND wb.workspace_id = current_workspace_id()
));
-- Same policy on each partition (a direct partition query does not inherit the parent's).
CREATE POLICY scores_via_entitlement ON score_rows_2026_08 FOR SELECT USING (EXISTS (
  SELECT 1 FROM workspace_brands wb WHERE wb.brand_id = score_rows_2026_08.brand_id AND wb.workspace_id = current_workspace_id()
));
CREATE POLICY scores_via_entitlement ON score_rows_2026_09 FOR SELECT USING (EXISTS (
  SELECT 1 FROM workspace_brands wb WHERE wb.brand_id = score_rows_2026_09.brand_id AND wb.workspace_id = current_workspace_id()
));

-- Brands: not globally readable. A workspace sees a brand only if it is entitled
-- to it (own or competitor). Category discovery for onboarding is svc_onboard's job.
CREATE POLICY brands_entitled ON brands FOR SELECT USING (EXISTS (
  SELECT 1 FROM workspace_brands wb
  WHERE wb.brand_id = brands.id AND wb.workspace_id = current_workspace_id()
));

-- Prompt banks are shared reference data (category-keyed, no tenant column).
-- Readable by any authenticated context; customer-private banks, if ever built,
-- go in a separate RLS'd table, never a nullable column here.
CREATE POLICY prompt_banks_shared ON prompt_banks FOR SELECT USING (true);

-- Writes: role-based, not GUC-based.
CREATE POLICY scorer_inserts_scores ON score_rows       FOR INSERT TO svc_scorer WITH CHECK (true);
CREATE POLICY scorer_inserts_scores ON score_rows_2026_08 FOR INSERT TO svc_scorer WITH CHECK (true);
CREATE POLICY scorer_inserts_scores ON score_rows_2026_09 FOR INSERT TO svc_scorer WITH CHECK (true);
CREATE POLICY scorer_inserts_agg    ON score_aggregates  FOR INSERT TO svc_scorer WITH CHECK (true);

-- Onboarding has full run of identity + entitlement tables (no tenant scoping —
-- it is the trusted writer). Explicit ALL policy so FORCE RLS does not lock it out.
CREATE POLICY onboard_all_accounts   ON accounts          FOR ALL TO svc_onboard USING (true) WITH CHECK (true);
CREATE POLICY onboard_all_workspaces ON workspaces        FOR ALL TO svc_onboard USING (true) WITH CHECK (true);
CREATE POLICY onboard_all_members    ON workspace_members FOR ALL TO svc_onboard USING (true) WITH CHECK (true);
CREATE POLICY onboard_all_wbrands    ON workspace_brands  FOR ALL TO svc_onboard USING (true) WITH CHECK (true);
CREATE POLICY onboard_all_brands     ON brands            FOR ALL TO svc_onboard USING (true) WITH CHECK (true);
CREATE POLICY onboard_all_banks      ON prompt_banks      FOR ALL TO svc_onboard USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Partition maintenance (ARCHITECTURE §3.3: raw rows expire ~90 days).
-- A scheduled job calls ensure_score_partition() ahead of each month and drops
-- partitions older than the retention window. DELETE-based expiry is impossible
-- by design (no DELETE grant on score_rows) and unnecessary: DROP the partition.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ensure_score_partition(month_start date) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  part text := 'score_rows_' || to_char(month_start, 'YYYY_MM');
  nxt  date := (month_start + interval '1 month')::date;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part) THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF score_rows FOR VALUES FROM (%L) TO (%L)', part, month_start, nxt);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', part);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO svc_scorer', part);
    EXECUTE format('GRANT SELECT ON %I TO app_rw', part);
    EXECUTE format('CREATE POLICY scores_via_entitlement ON %I FOR SELECT USING (EXISTS (SELECT 1 FROM workspace_brands wb WHERE wb.brand_id = %I.brand_id AND wb.workspace_id = current_workspace_id()))', part, part);
    EXECUTE format('CREATE POLICY scorer_inserts_scores ON %I FOR INSERT TO svc_scorer WITH CHECK (true)', part);
  END IF;
END $$;
