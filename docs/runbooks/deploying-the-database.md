# Runbook — deploying the database

**Status:** STANDING. The gate is live on every deploy; §1 is a permanent
operational item with no completion date.
**Written:** 2026-09-09 · **For:** whoever runs `pnpm db:check` against a real database
**Relates to:** ADR-0007 (tenancy mechanism and gate split) · R7 (tenancy is
verified mechanically) · migrations 0001–0003

The deploy gate closed on 2026-09-09. `packages/db/scripts/check-deploy.sql` now
refuses a misconfigured database instead of describing what it would have
checked. This runbook exists for the one thing that can quietly switch the most
important part of it off.

---

## 0. What is true right now

Checked 2026-09-09, read-only, against `main`:

| | |
|---|---|
| `bliprank.rls_bypass_allowed` in `.env` / `.env.local` | **not present** |
| …anywhere outside test files | **not present** — `git grep` finds it only in migration 0002, the gate itself, and five test files |
| Production value | **unset**, which is the safe state and the one to keep |
| Gate assertions | all three live: `assert_role_powers()`, the exposure-manifest fault sweep, `auth_key_health()` |
| Deploy command | `pnpm --filter @bliprank/db db:check` (needs `DATABASE_URL`) |

---

## 1. ⚠️ `bliprank.rls_bypass_allowed` — the standing item

### What it is

An **allowlist of role names** that are excused from the gate's superuser /
`BYPASSRLS` assertion. Migration 0002:

```sql
WHERE (r.rolsuper OR r.rolbypassrls) AND r.rolname NOT LIKE 'pg\_%'
  AND r.rolname <> ALL (… bliprank.rls_bypass_allowed …)
```

Any role named there stops being reported. Everything else about that role is
unchanged — **it still bypasses RLS.** The setting does not restrain it; it
silences the alarm about it.

### What it waives

The single most important assertion in the file. A role with `BYPASSRLS` reads
**every tenant's rows**, in every table, regardless of any policy. No amount of
correct policy writing constrains it, and the exposure manifest cannot see it
either — RLS bypass appears in no table ACL.

Two things migration 0002 records as *verified*, not theorised:

- `CREATE ROLE reporting NOLOGIN BYPASSRLS; GRANT app_rw TO reporting; GRANT
  reporting TO web_prod;` passed the entire deploy check, and `web_prod` read
  every tenant after one `SET ROLE`.
- `ALTER ROLE app_rw BYPASSRLS` does the same with no extra role at all — and is
  the plausible reaction to *"RLS is blocking my job"*.

The check covers **every** role, not only ones that can log in, because bypass is
evaluated against the current user after `SET ROLE`, not the authenticated one.

### Why it exists at all

PGlite's session user is a superuser, so the test harness would fail every run
without it. Managed Postgres (Supabase, RDS) will not let you create a superuser,
but `ALTER ROLE … BYPASSRLS` is available — so a real database usually has
exactly one legitimately privileged admin role.

It is an allowlist rather than a boolean **on purpose**. A switch would have to
be turned on to accept the one admin role every database has, and would then also
accept the next role someone quietly grants `BYPASSRLS` to — which is the whole
finding. Naming roles keeps the exception scoped to the ones somebody actually
decided about.

### THE RULE

> **In production, `bliprank.rls_bypass_allowed` stays unset.**
>
> If it ever needs a value, every name in it is a role that can read every
> customer's data, and each one is a deliberate, recorded decision — not a step
> in getting a deploy to pass.

Before adding a name, all four:

1. **Say why the role has `BYPASSRLS` at all.** The usual honest answer is that
   it should not, and the fix is `ALTER ROLE … NOBYPASSRLS`, not an allowlist
   entry.
2. **Confirm no application path can reach it** — no `GRANT <that role> TO
   <anything an app connects as>`. The `reporting` → `web_prod` chain above
   passed every check and leaked everything.
3. **Record the decision** where the next person will find it: an ADR if it is
   permanent, this runbook's §5 if it is temporary, with the date it is removed.
4. **Set it in the deploy command's own environment**, never in a committed
   file. A value in `.env` is a decision nobody re-reads.

### The failure mode to watch for

The gate raising `these roles bypass RLS entirely and read every tenant: …`
during a deploy at an inconvenient hour, and someone making it pass by naming the
role instead of removing the attribute. The exception message itself offers that
route — *"Remove the attribute, or name them in `bliprank.rls_bypass_allowed` to
accept them deliberately"* — and the second half is much easier than the first at
2am. **That is the moment this runbook exists for.**

---

## 2. The gate reports its own waivers — read that line

`check-deploy.sql` prints the allowlist on every run, whatever it contains:

```
RLS-bypass roles excused by bliprank.rls_bypass_allowed:
(none)
```

**`(none)` is the expected output in production.** Anything else is either a
decision made under §1 or a decision nobody made. There is no third case.

This line is the cheapest possible audit: it needs no query, no access and no
tooling — just reading the deploy log to the end.

---

## 3. Running the gate

```bash
DATABASE_URL='postgres://…' pnpm --filter @bliprank/db db:check
```

Runs `psql -v ON_ERROR_STOP=1 -f scripts/check-deploy.sql`. `ON_ERROR_STOP` is
load-bearing: the assertions `RAISE EXCEPTION` rather than `WARNING`, because a
warning does not fail psql and an earlier version reported the superuser case
into a log nobody read while passing the deploy.

The gate needs a principal that can execute its functions. Grant the
`deploy_check` role (`NOLOGIN`, created by migration 0003) to whoever runs it:

```sql
GRANT deploy_check TO <the deploying role>;
```

The gate's functions are granted to `deploy_check` rather than `PUBLIC` because
`tenancy_exposure_faults()` returns a ranked list of exactly which relations are
reachable-and-unreviewed — no tenant data and no key material, but a targeting
list.

**It does not need `BYPASSRLS`.** That was true of an earlier version and was the
trap: `auth_key_health()` exists specifically so a non-superuser deployer can
check signing-key health against a table that forces RLS. If a deploy seems to
need `BYPASSRLS` to pass, that is the bug, not the configuration.

---

## 4. What the gate does not cover

So nobody reads a green deploy as more than it is:

- **It is a deploy-time inspector.** It refuses a bad database; it does not
  enforce anything at runtime. Runtime enforcement is migrations 0001–0002 and
  the policies themselves.
- **Disjointness is proven elsewhere.** `packages/db/src/tenant-isolation.test.ts`
  seeds two tenants, performs real reads and writes, and asserts the visible row
  sets do not intersect. A policy that merely *mentions* `current_workspace_id()`
  passes every catalog check and fails that one — `USING (current_workspace_id()
  IS NOT NULL)` returned both tenants' rows while passing every static assertion
  ever written.
- **The manifest is a declaration.** Declare a scoped relation as `shared` and
  the gate accepts it. The two derivations in `tenant-isolation.test.ts` — one
  from the manifest, one from the live catalog — plus the test asserting they
  agree are what catch a declaration that lies.

---

## 5. Standing exceptions

None. If §1 ever adds one, it goes here with the date it is removed.

| Role | Why | Decided by | Remove by |
|---|---|---|---|
| _(none)_ | | | |
