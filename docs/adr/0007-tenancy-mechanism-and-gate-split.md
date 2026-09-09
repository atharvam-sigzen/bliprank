# ADR-0007 — The tenancy mechanism ships; the deploy gate is redesigned, not patched

**Status:** Accepted · **CLOSED 2026-09-09** · **Date:** 2026-08-24 · **Phase:** P1 (binds every phase gate)

> **THE GATE IS CLOSED.** `fix/tenancy-deploy-gate` merged on 2026-09-09:
> migration 0003, `deploy-check.test.ts`, and all three assertions this ADR
> listed as absent — the exposure manifest, `assert_role_powers()` and
> `auth_key_health()` — now execute rather than being described in a comment.
> 168/168 in `packages/db`. The two open findings in §4 are answered and
> measured; see the closing note at the foot of this file. Everything below is
> preserved as written, because the reasoning is why the redesign was right.
**Relates to:** R7 (tenancy is verified mechanically) · PHASES.md standing suite item 3

## Context

Branch `fix/tenancy-context-blocker` set out to close one BLOCKER and produced two
separable things. This ADR records why they separate, and on what terms.

**The mechanism.** Until migration 0002, tenant identity was carried in a
customised GUC (`app.workspace_id`). Customised GUCs are `USERSET`: any role can
set one with a bare `SET LOCAL`, needing no grant of any kind. Every RLS policy
in the schema consulted that GUC, so any authenticated tenant could read every
other tenant's rows with one statement and no privilege. Migration 0002 moves the
context into an `UNLOGGED` table owned by `auth_verifier`, keyed
`(pg_backend_pid(), pg_current_xact_id())`, with no grant to any application
role; `current_workspace_id()` became `SECURITY DEFINER` reading that table.

**The gate.** `packages/db/scripts/check-deploy.sql` asserts, at deploy time
against the real database, that the configuration around that mechanism is sound.
Login roles are created outside migrations, so this cannot be a constraint — it
has to be a check where the roles actually are.

Seven independent adversarial audits ran against the branch. The mechanism held
all seven, with every attempted bypass blind — including the bare `SET LOCAL`
path the audits were explicitly instructed to try first, run as a real
non-superuser `LOGIN` principal rather than as the test harness's superuser.

The gate did not hold. Its failure has a shape worth naming.

## The failure pattern

Audits 1–4 each found a BLOCKER in the gate, and three were the same bug: an
assertion that names an **arrangement** rather than deriving the **property**. A
proxy, a role list, `pg_has_role(…, 'USAGE')`, `rolcanlogin`, a function-name
list, a relkind list, a grantee name, the schema (nine separate times), the
policy command. Each round enumerated more shapes; each audit found a shape not
enumerated. Proving "no unsafe configuration exists" by listing unsafe
configurations is unbounded by construction.

Audit 4 prompted an inversion — migration 0003's `tenancy_exposure_manifest`,
which requires every reachable object to be *declared* and faults on
reachable-and-undeclared, so an unanticipated schema, relkind, verb or grantee
fails by default. That was the right direction. It did not converge.

**Rounds 5, 6 and 7 each found that the previous round's fix had opened the next
hole.** Not new ground — the fix itself:

| Round | The hole the previous fix opened |
|---|---|
| 5 | The manifest match was blind to the *grantee*, so a grant to the login role rather than to `app_rw` was undeclared and unnoticed. |
| 6 | `manifest_root()` propagated the *declaration* down an inheritance tree without propagating the *obligation*, so an unprotected partition inherited approval. |
| 7 | Declaration resolved on the child's schema and obligation on the root's. `CREATE TABLE archive.accounts (LIKE public.accounts); ALTER TABLE public.accounts INHERIT archive.accounts;` shed the duty and kept the approval. |

Round 7 also found the gate could not pass its own target posture at all: with
the tables owned by a non-superuser — what Supabase does by default, and what
0001 states the design exists to survive — it produced 54 faults. It had only
ever been exercised where the owner was a superuser. A gate that fails on the
correct configuration has one predictable remedy, `|| true` in the pipeline, and
that is the outcome the file exists to prevent.

Three rounds of a fix generating its successor is a different failure mode from
four rounds of finding unenumerated shapes. The first says the enumeration is
incomplete. The second says the approach is wrong.

This has cost seven rounds on a deploy-time check for a database with no
customers, no data and no application query layer, while `format.ts`,
`spend-ledger.ts`, the R2/Upstash setup and gate G0 were all frozen behind it.

## Decision

**1. Migration 0002 and its verification merge to `master` now.**

Merging: `0002_tenancy_context.sql`, the corrected `0001` header, `schema.ts`,
`rls.test.ts` (53 tests, including the standing adversarial-path class), and
`tenant-isolation.test.ts` (15 tests — two seeded tenants, real reads and writes
across every scoped relation, row sets asserted disjoint).

`tenant-isolation.test.ts` derives its subject from `pg_policies` rather than
from 0003's manifest, so it does not depend on the gate. That is also the better
property: anything `app_rw` can read whose policy consults the tenant context is
in scope by construction, declared or not.

`check-deploy.test.ts` (20 tests) merges with it. The gate's own rule — *an
assertion with no failing case is indistinguishable from one that does nothing* —
applies to the reduced gate too, so each of its six remaining assertions ships
with the unsafe database it refuses. Trimming the suite immediately earned its
keep: the dropped-context-reader case failed, because
`has_function_privilege('app_rw','set_workspace(uuid)')` **raises** on a
signature that does not exist, so a missing reader reported `function
"set_workspace(uuid)" does not exist` instead of the assertion's own message. The
deploy failed either way and the operator got the wrong reason. Fixed by running
the existence assertion first. On the branch that case passed, because its
expectation was an alternation the other branch satisfied — the same pattern that
hid three earlier BLOCKERs, and a finding the redesign inherits.

**2. The deploy gate does not merge, and is not called a checklist.**

Staying on `fix/tenancy-deploy-gate`: `0003_tenancy_exposure_manifest.sql` and
`deploy-check.test.ts` (78 tests, each building a deliberately-broken database).
`check-deploy.sql` on `master` keeps only what holds without the derivation —
role exclusivity, the `pg_class` RLS sweep, the context readers, the bare-GUC
regression, pgcrypto resolution — and states in its own header that it is
partial, why, and by when.

Three assertions are deliberately absent rather than reimplemented: the exposure
manifest, `assert_role_powers()` (predefined-role membership, which appears in no
table ACL), and live signing-key health. The last one needs `auth_key_health()`
from 0003; until it merges, a deploy with no live key fails at the first login
attempt instead of at deploy time.

**3. The gate must be closed before G1. Not "before launch".**

PHASES.md's standing suite item 3 runs the RLS suite at every gate, and G1 is the
pipeline gate — 10,000 answers durably stored across five engines. That is the
first gate where real collected rows exist to be isolated. "Before launch" has no
date attached and would let this slip indefinitely; G1 does.

**4. The next attempt derives the subject from the catalog, and is its own task.**

Not another round of patch-the-hole-found-and-re-audit. The gate enumerates every
RLS-relevant object from Postgres's own catalog — `pg_class` across all relkinds,
`pg_inherits` for both partitioning and legacy inheritance, views and their
`security_invoker` setting, real ownership via `relowner` — and requires each
object *found* to prove coverage. No hand-written exemption or inclusion list:
those are what missed the arrangement nobody anticipated, seven times.

0003 is the starting point, not the baseline. It already inverted the
enumeration; what it did not do is key declaration and obligation to the same
object, or treat ownership as a principal. Both are consequences of the same
mistake — resolving a property against something other than the object itself.

Two findings carry forward into it. **Assertion order is load-bearing**: a
catalog predicate that raises rather than returning false ends the gate early and
reports the wrong reason, so existence must be established before privilege is
queried. And **an expectation written as an alternation is not a failing case**;
`deploy-check.test.ts` has several, each of which can be satisfied by the branch
that is not under test.

## Consequences

- `master` gains DB-level tenancy enforcement that survived seven adversarial
  audits. This is what R7 and the p1/db-schema decision (D) required.
- `master` has **no complete deploy-time gate** until the redesign lands. Six
  assertions remain, each with a failing case; the exposure manifest,
  `assert_role_powers()` and signing-key health do not. A misconfiguration in a
  class those three covered — a new object kind reachable by a tenant, a
  predefined-role grant, a deploy with no live key — will not be caught here.
- **The tenant read path is now a write path.** `current_workspace_id()` reads a
  table that `set_workspace_jwt()` writes, so Supabase read replicas are
  unavailable to `apps/web` while context lives in `auth_tenant_context`. Open
  architectural question, documented rather than worked around.
- `format.ts` and `spend-ledger.ts` review, R2/Upstash setup and G0 are unblocked.
- Seven audit reports and the branch history are preserved on
  `fix/tenancy-deploy-gate`. The redesign starts from evidence, not from memory.

## Rejected alternatives

**Merge the whole branch and note the gate is open.** The gate would be on
`master` in a state three consecutive audits found unsound, and "open" written in
a progress file has no mechanism behind it. A partial gate that says so in its
own header, with a named deadline, is honest; a full gate that is wrong is worse
than an absent one because it reports success.

**Attempt an eighth round in the same style.** Rounds 5–7 give the base rate: the
expected outcome is a new hole created by the fix. The cost is another round of
everything else frozen.

**Keep 0002 unmerged until the gate is closed.** The mechanism is the part that
actually protects customer data and it is verified. Holding it back protects
nothing and blocks four other workstreams.

**Defer the gate to "before launch".** Explicitly rejected by the decision above.
It is the phrasing under which this would never be closed.


---

# Closing note — 2026-09-09

Merged as `integrate/tenancy-deploy-gate`. **168/168 in `packages/db`.**

## §4's two open findings, answered

This ADR left two, and the branch's last two commits were *titled* as if they
answered them. Titles are not evidence. Each now has a passing failing-case:

| §4 finding | Test that proves it |
|---|---|
| key declaration and obligation to the same object | `audit 7 › a same-named parent in another schema does not shed the obligation` |
| treat ownership as a principal | `audit 7 › the gate passes with the tables owned by a NON-superuser` + `› but an owner that can log in, or that a tenant can reach, is refused` |

`audit 6` additionally delivers declaration propagation down partition trees,
`LIKE INCLUDING ALL`, legacy `INHERITS` and multi-parent inheritance.
`assert_role_powers()` refuses `REPLICATION` logins, `pg_maintain` and
`pg_signal_backend` — none of which appears in any table ACL, which was the point.

## What the merge nearly lost, and what the run then proved

The branch **dropped** `master`'s `app_rw`/`set_workspace(uuid)` EXECUTE
assertion. It was re-added at the merge on the principle that a merge is the
easiest place to lose an assertion, and that "the manifest probably covers it" is
not the standard for deleting one from a security gate.

The test run then settled it. The unsafe database is refused — by the **manifest**,
first, reporting `[definer-function-exposed] set_workspace(uuid) is executable by
app_rw`. So the manifest *does* subsume it, and this ADR's central claim is
demonstrated rather than argued: the manifest **derived** a fault nobody had
enumerated. The re-added assertion is now known-redundant rather than
assumed-redundant, and is kept as the second line for the case where a
declaration lies.

The same happened to `master`'s hand-written `pg_class` RLS sweep, which is gone:
`[scoped-without-forced-rls] public.score_rows INHERITS a scoped declaration but
does not FORCE row level security`. The manifest knows *why* the relation is
scoped; the sweep only knew RLS was off.

Both tests had pinned the old message text. Retargeted to the property — a test
that pins a string is a test of the string.

## Two suites, neither a superset

`check-deploy.test.ts` (21) was **not** superseded by `deploy-check.test.ts` (78).
Five of its cases are absent from the newer file, including the failing case for
the assertion above. Both survive. The older one needed 0003 added to its
migration list, because the gate it exercises now calls functions 0003 defines.

## One thing the merge added that neither side had

`tenant-isolation.test.ts` derived scoped relations from `pg_policies` on
`master` and from the manifest on the branch. Each catches what the other cannot
— an undeclared scoped relation, and a declaration the catalog does not support.
Both derivations are kept, plus a third test asserting they **agree**. If the
manifest and the catalog disagree about what is scoped, one of them is wrong, and
finding that out from a test beats finding it out from a tenant.

## The process failure, which outlived the technical one

This sat 16 days. The deadline was "before G1" precisely because *"'before
launch' has no date attached and would let this slip indefinitely; G1 does."*
That reasoning assumed gates fire. **No gate has ever been run** — G0 unrun, G1
never attempted, G2 NOT RUN, G3 blocked — so the deadline never came due, and
work continued two phases past P1 on top of an open security gate.

A deadline pinned to an event that never happens is not a deadline. If a future
item needs forcing, pin it to a date.
