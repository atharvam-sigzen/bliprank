# BlipRank — Progress Record

**As of:** 2026-08-24 · **master:** `0ac22df` · **First commit:** 2026-08-18 · **Tests:** 503 passing, 26 files, all offline

A status record, not a plan and not a pitch. `docs/PHASES.md` says what is in
scope; this file says what actually exists. Everything below is checked against
`git log`, the ADRs and the files named. Where something is unverified it says
so. Update it at every phase transition.

---

## 1. Where we are

**Phase P0 — Foundation. Gate G0 is active and has not run.**

The pilot machinery is complete, reviewed and tested end to end against
fixtures. **Zero real answers have been collected.** No engine has returned a
parseable response. There is no measured $/answer, no measured latency, no ρ̂_u,
no DEFF and no n_eff.

The block is external: the OpenWeb Ninja account has no active API
subscriptions. All five surfaces return `HTTP 403: You are not subscribed to
this API` — recorded verbatim in
`services/collector/pilot/data/2026-08-20/failures.jsonl`. The runner, the
budget guard, the canary dispatch and the analysis pipeline all behaved
correctly; there is no code defect to fix here. Atharva is resolving the
subscription on the provider dashboard.

**Spend to date: $4.150** against the pilot's $75 cap, from
`services/collector/pilot/data/2026-08-20/ledger.json` (last written
2026-08-20T06:34:32Z):

| Engine              | Attempts | Charged (payg) |
| ------------------- | -------- | -------------- |
| chatgpt             | 130      | $0.910         |
| gemini              | 130      | $0.910         |
| copilot             | 130      | $0.910         |
| google-ai-mode      | 130      | $1.040         |
| google-ai-overviews | 76       | $0.380         |
| **Total**           | **596**  | **$4.150**     |

Every one of those 596 attempts was a 403. **Zero answers were stored** — the
day's data directory holds only `meta.json`, `ledger.json` and
`failures.jsonl`. The figure is what our own ledger charged itself at
pay-as-you-go rates before the guard stopped; the provider most likely billed
$0 for calls against an unsubscribed API. It is stated as $4.150 because that
is what the ledger records, and the ledger is the artefact `/cost-audit`
reconciles against the invoice.

Of G0's nine criteria, **one has an executable result**: the Wilson
implementation agrees with statsmodels to ≤ 1e-9 (PASS). The other eight are
`NOT RUN`. Per `docs/PHASES.md`, a criterion with no executable check is
`NOT RUN`, not `PASS`.

**No gate — G0, G1 or any later gate — has been passed.**

Since this record was first written, a parallel fixture-and-free-tier track has
built a good deal more (§2): the real R2 transport, the QStash runner, the
deterministic scorer and citation classifier, both UI scaffolds, a fleet-safe
spend ledger and a collection heartbeat. **None of it changes the line above.**
Every one of those is verified against fixtures or published test vectors, not
against a live service or a collected answer, and several carry explicitly
provisional numbers awaiting G0. The test count going up is not evidence about
the product.

---

## 2. What's built

### P0 deliverables

**`packages/contracts` — the `EngineAdapter` contract** (`c1ee871`, ADR-0001).
Hand-written, as PHASES 0.3 requires. It carries a required `collectionPath`
field (`official-api` | `third-party-grounded`) on every adapter, because
ADR-0001 replaced the PRD's unkeepable "official APIs only" constraint with a
stronger one we can keep: no metric published without its collection path
visible. `normalise()` is pure and synchronous so the whole contract suite runs
from fixtures with zero network.

**`packages/stats` — Wilson intervals** (`f7322e9`, `6a4b102`; branch
`p0/stats-wilson`, fast-forwarded into master). Verified against
`statsmodels.stats.proportion.proportion_confint(method='wilson')` 0.14.6 /
scipy 1.17.1 — **1,023 reference cases** (341 grid points × α = 0.20, 0.05,
0.01) agreeing to **≤ 1e-9**, the exact G0 threshold. A first version passed
every test while hardcoding z in the denominator; `stats-reviewer` found the
blind spot, and the fix was mutation-verified. Human-owned per CLAUDE.md §4.

**Cache key schema** (`2827773`, ADR-0003).
`sha256(JSON[normalised_prompt, engine, locale, geo, date_bucket])`.
Serialised as a JSON array so field order *is* the schema and a prompt
containing a delimiter cannot collide. Normalisation is NFKC → lowercase →
collapse whitespace → strip terminal punctuation, with
`NORMALISATION_VERSION` **stored beside the row, not hashed** — hashing it
would invalidate 100% of the cache on every normaliser bump, including prompts
whose normalised form did not change. Provider is deliberately excluded from
the key; path-qualified lookups (`${cell.key}:${adapterId}`) handle
alternate-path re-collection. R6 makes this shape un-retrofittable, which is
why it was fixed before the first answer was stored.

**The G0 statistical fix** (`45534bd`, `5eb9bc3`, `81b6879`, `3c76f2e`). The
original criterion asked for a Wilson half-width threshold at the Starter
default of 5 runs. That is arithmetically impossible to fail or pass: at n = 5,
p̂ = 0.25 the interval is [0.05, 0.66] *whatever the engine does*, so the check
measured arithmetic, not evidence. An intermediate restatement was also wrong —
single-day ANOVA ρ̂ charges fixed between-prompt heterogeneity and reads ≈ 0.25
even under perfect independence, so every engine would have failed regardless
of behaviour. That was caught by running the pipeline offline before spending.

What replaced it: the gate is on the **day×cell correlation** from the two-day
re-collection, ρ̂_u = (D − 1)/[(m − 1)(1 + D/(2m − 1))] — the exact inversion of
E[D], after `stats-reviewer` showed the naive (D − 1)/(m − 1) over-reads by
~10% — judged on its **95% bootstrap upper confidence limit**, with
DEFF = 1 + 4ρ̂_u ≤ 1.5 and n_eff = 150 / DEFF ≥ 100. Single-day ANOVA ρ̂ is
retained as a reported upper bound only. An integrity row guards against a
cached provider passing the variance rows trivially (D's CI not entirely below
1; < 50% of day-2 texts byte-identical to day 1).

**Consequence: Day 2 collection is now mandatory.** Without the second day the
design-effect and precision rows are `NOT RUN` — they cannot be estimated from
one day. A one-day pilot does not produce a G0 verdict.

**Pilot runner and analysis** (`81833de`, `5690076`, `675bf40`). Per-pilot
(not per-day) hard cap charged before every attempt, canary-first dispatch so a
dead engine costs one call rather than a 64-wide concurrency window, engine
skip on prior rejection, `--preview`, `--doctor`, `--fixture`, `--stub`, and a
run lock. These are what kept a fully unsubscribed key to $4.15 instead of $75.

### The v2.1 scaffold merge (2026-08-20)

Hand-merged, file by file, so it could not revert reviewed fixes (`8293d85`,
`380744d`, `4d2da5d`, `dc22169`, `52cf438`, `b038654`).

- **ADR-0005 — citation source classification**, deterministic classes
  owned / video / community / review / earned_media / competitor / reference /
  other. Class is stored on the score row rather than derived at query time
  (R5), and `other` is never silently reclassified as `owned`. The premise:
  most AI citations come from earned media the customer does not own, so
  "is this our domain?" is the right primitive and not enough on its own.
- **Renumbered from the ZIP's ADR-0003**, which would have collided with our
  cache-key schema at 0003 and the Ruflo decision at 0004. Same content,
  new number; the rest of the repo references 0005.
- **Contract change:** `normalise()` now preserves structured citation metadata
  (publisher, date, video timestamp, community thread id) instead of flattening
  a citation to its top-level domain — once dropped at normalisation, those
  fields cannot be recovered downstream, and the P2.1b classifier needs them.
- **Explicitly not taken from the ZIP:** the G0 restatement, the R4 per-cell
  wording, and the METHODOLOGY collection-path table — the ZIP's versions were
  older than our reviewed fixes.

### P1 (fixture-only) — current status

| #   | Item                                               | Status                                                                                                                                                                                                                                                                                                                             |     |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 1.1 | QStash production runner | **Done** (`1619447`, `38a0667`). A cron fans a cycle into one message per cell; QStash delivers each to an HTTP endpoint that verifies an HS256 token (issuer, destination, expiry, and the body hash — without which a valid token could be reattached to a job asking for 5000 runs) and hands the cell to the orchestrator. The status mapping IS the spend control: QStash retries any non-2xx, so a job that failed after burning its attempts returns 200 and dead-letters; non-2xx is reserved for "nothing was spent". **Never exercised against real QStash.** |
| 1.2 | OpenWeb Ninja adapter + fixtures | **Done** — five surfaces, `--doctor` probe, citation metadata preserved (ADR-0005). |
| 1.3 | Second provider stubbed | **Done** (`f111d5e`). `stubsearch` speaks a deliberately different dialect (HTML body, rank-ordered sources, v2 envelope) and passes the same conformance suite as the real adapter. This is the proof ADR-0001 §2 demands: the abstraction is exercised, not asserted. |
| 1.4 | Cache key + Redis index, shared prompt-pool dedupe | **Done** (`52cac9a`, `d6528e4`, `4d3a5a1`, `27652c2`). `AnswerIndex` over an injectable KV (memory + Upstash REST), atomic per-cell claim so 15 agency clients on one category cause one collection. Wired into `CollectionOrchestrator` — the cache-check → collect-on-miss → single-blob-write funnel. |
| 1.5 | R2 storage, one object per cell | **Done** (`1d80396`). Hand-rolled SigV4 over R2's S3 REST API, no AWS SDK: three verbs against one bucket does not justify that dependency, and a signer checked against AWS's own published vectors is easier to trust than an SDK we cannot see into. `assertSafeKey` refuses keys containing dot segments, because `new URL()` resolves them *before* signing — such a key would be signed and sent for a different object, the same wrong object both times, so it would succeed silently. **Never exercised against a real bucket.** |
| 1.6 | Rate-limit budget manager | **Done** (`a392f95`). `RateBudget` interface with `LocalRateBudget` (continuous token buckets, key sharding, UTC window, injectable clock) behind it. The interface is the point: it is what makes the P5 Vercel → Hetzner migration a swap rather than a rewrite. |
| 1.7 | `packages/db` schema + RLS                         | **Mechanism done** (`af9fa1a`, then `0ac22df`). Merged 2026-08-22 after the three open decisions; the tenant context was moved out of a self-settable GUC on 2026-08-24 and has held seven independent adversarial audits. **The deploy-time gate is NOT done** and is required before G1 — ADR-0007, `fix/tenancy-deploy-gate`. See below. |     |

**Review findings that changed the code.** `measurement-engineer` returned two
verified BLOCKERs on the orchestrator, both fixed in `27652c2`:

- The R2 object key was cell-only while the index key was path-qualified, so an
  alternate-path re-collection silently overwrote the primary provider's stored
  answers and misattributed the index pointer. ADR-0003 now records the object
  identity as *one object per cell per collection path*.
- Any under-target collection — budget stop **or** ordinary retry attrition —
  marked the cell collected forever, and the cache check never compared stored
  runs against requested runs. The cell would be served as a hit with a
  permanently capped `n`: a silent R8 violation. A partial cell now falls
  through and completes on a later cycle.

**`p1/db-schema` — merged 2026-08-22 (`af9fa1a`).** 821 insertions across
`packages/db/{migrations/0000_init.sql, src/schema.ts, src/rls.test.ts}`:
partitioned score tables, FORCE ROW LEVEL SECURITY on every table and
partition, transaction-stamped workspace context, no default partition, and
role-based authority (`app_rw` / `svc_scorer` / `svc_onboard`). 17 RLS tests on
PGlite — real Postgres in-process, so the policies are executed rather than
described.

`tenancy-auditor` reviewed it twice. Pass 1 found **three BLOCKERs**: a tenant
could self-issue entitlements and read the entire corpus; the `app.service`
GUC was self-settable, allowing corpus poisoning; and the test suite proved
almost nothing. The schema was rewritten to role-based authority in response.
Pass 2 verdict: *no cross-tenant leak reachable through the product path; the
three BLOCKERs and five MAJORs are genuinely fixed.* Durability fixes from that
second pass are in `18cde63`.

**The three decisions that blocked the merge, taken 2026-08-22** and
implemented in `0001_tenancy_identity.sql` (`f658900`):

1. **DB-level tenancy identity, not app-level-only.** The tenant presents an
   HS256 token; `set_workspace_jwt()` verifies the signature *inside Postgres*
   against a secret in a table no application role can read, pins the algorithm
   (so `alg:none` and RS256-as-HMAC are refused), checks
   `kid`/`iss`/`aud`/`exp`/`nbf`, and requires the subject to actually be a
   member of the workspace the token names. The signature proves who; membership
   decides what. The verified context is written to `auth_tenant_context`, keyed
   on `(backend_pid, xact_id)`, which no application role has any grant on —
   **see the incident below for why it is a table and not a GUC.**
2. **Role exclusivity is checked where the roles are.** It was an assertion
   about a fixture database, which proves nothing about a deployment — login
   roles are created outside every migration. `assert_role_exclusivity()` plus
   `packages/db/scripts/check-deploy.sql` now run in the deploy pipeline, and a
   bad GRANT fails the deploy loudly. It also refuses any application role that
   can borrow `auth_verifier` and read the signing secret.
3. **Billing blocks before it creates.** A BEFORE INSERT trigger on
   `workspace_brands` refuses an entitlement with no subscription, a cancelled
   or lapsed one, or one over the plan's brand limit, so an unpaid entitlement
   never exists — not for a concurrent reader, not in the WAL, and not if the
   process dies mid-cleanup. An advisory lock serialises inserts per workspace,
   because count-then-insert is a read-modify-write and two concurrent claims on
   the last seat would otherwise both pass.

The RLS suite went from 17 tests to 34 and now drives `app_rw` through the token
path, so every pre-existing tenancy test is exercised against verified identity
rather than a named workspace.

#### Incident, 2026-08-22 — a claim was approved and merged before it was found false

`0001` shipped the JWT verifier above and stated, in the migration header, in
`check-deploy.sql`, in a passing test titled *"app_rw has no way to call the
unverified setter at all"*, and in the report that obtained sign-off, that the
tenant role could no longer name a workspace. **It could.** `set_workspace()`
was never the authority — `current_workspace_id()` was, and it read a customised
GUC. Postgres classifies those USERSET: any role sets one with a bare
`SET LOCAL`, no function call and no grant involved, and the transaction stamp
guarding it is not a secret. Two statements read another tenant's workspaces,
member accounts, entitlements, plan and corpus slice, and the whole corpus by
re-issuing `set_config()` per workspace id in the same transaction.

Reproduced on a non-superuser login role whose only membership is `app_rw`. The
hole was inherited from `0000`, so it had survived **two** prior
`tenancy-auditor` passes, and it survived them for the same reason it survived
review: every test established context through the sanctioned path and none
tried the unsanctioned one. **The test asserted a proxy for the property, the
proxy held, and the property did not.**

Fixed in `0002_tenancy_context.sql`: context moved into a table no application
role can write, keyed on `(backend_pid, xact_id)` so it cannot outlive its
transaction on a pooled connection. Nothing is deployed and no customer data
exists, so this was a fix-forward, not a breach.

**What it leaves behind is a standing test category**, documented at the top of
`packages/db/src/rls.test.ts`: for every policy that scopes on tenant context,
a test that establishes context by a *non-sanctioned* path and asserts zero
rows. Extended in the same commit as any new tenancy-relevant table. It is the
only part of that suite whose job is to be wrong.

The same pass closed a second real break: `assert_role_exclusivity()` passed a
login role granted both `app_rw` and `auth_verifier`, which then read the HS256
signing secret in plaintext and could forge a token for any workspace.

**The re-audit of that fix returned a second BLOCKER, and it is the more
instructive one.** The context mechanism itself held — thirteen non-sanctioned
paths were attempted against a real non-superuser login role and every one came
back blind. What did not hold was the migration: `0002` added `NOT NULL DEFAULT
'unset'` columns with validating CHECKs, and **could not be applied to any
database that had run `0001` in service**, because such a database must hold a
signing key, that row backfilled to `'unset'`, and the CHECK rejected it. The
whole migration rolled back, leaving the original BLOCKER live in production.
The test suite never saw it because it inserted the key *after* running all
three migrations — the one ordering in which an inapplicable migration looks
fine. A correct fix that cannot be deployed is not a fix.

Three MAJORs came with it, each with a working proof-of-concept: a login role
with `BYPASSRLS` read every tenant and **passed the entire deploy check** (on
managed Postgres you cannot create a superuser, but you can set that attribute);
the deploy check asserted its properties against a hardcoded list of three group
roles, so a login role granted EXECUTE on `set_workspace()` passed and then named
any workspace; and the "does this table scope on the tenant?" sweep existed only
in the test suite, so a new table with `USING (true)` passed the deploy and
served every tenant's rows.

The through-line in all three is the same as the original bug: **an assertion
that names a specific list rather than deriving the property**.

**Audit three found four more of exactly that**, each with a working
proof-of-concept ending in the plaintext HMAC signing secret: `pg_has_role(...,
'USAGE')` is blind to a `NOINHERIT` member, who reaches everything through
`SET ROLE` — a role granted all three authority groups *and* `auth_verifier`
passed the whole gate and read the secret; `rolcanlogin` is blind to `BYPASSRLS`
on a `NOLOGIN` role, and to `ALTER ROLE app_rw BYPASSRLS`, which needs no extra
role at all; the `SECURITY DEFINER` assertion named five functions, so a
six-line helper granted to `app_rw` returned the secret and the tenant then
forged a token and entered through the front door; and `relkind IN ('r','p')`
is blind to plain views. A fifth, `MAJOR`: write policies were never swept at
all — `with_check` was not read — so a legitimately authenticated WS1 session
inserted a row into WS2, invisible to the writer and read by the victim as its
own reconciliation data. On a product whose claim is that its numbers
reconcile, that is corruption of record rather than a leak.

The gate now derives every *subject* from the catalog — which roles, which
relkinds, which functions — and names only the objects an assertion is about.
Where a list is unavoidable it is **default-deny**: every `SECURITY DEFINER`
function is refused unless it is one of the three that form the intended
surface, so the next one fails the deploy the day it is written. The earlier
lists were default-allow, which is the bug.

`deploy-check.test.ts` builds a deliberately-broken database per assertion, on
the rule that an assertion with no failing case is indistinguishable from one
that does nothing — including the two the audit flagged as having none, the
bare-GUC regression and the pgcrypto resolution check.

**Audit four found four more, and at that point the approach was the problem.**
Every assertion in the gate pinned `schema = 'public'` — nine times — so a table
in a new schema **with no RLS at all** passed and returned both tenants' rows.
The policy *command* was named too, so `FOR DELETE USING (true)` and a `TRUNCATE`
grant both passed, and each let a fully authenticated WS1 session destroy WS2's
rows. `qual LIKE '%current_workspace_id%'` tests for a substring rather than a
scope, so `USING (current_workspace_id() IS NOT NULL)` passed and returned every
tenant. And the gate **could not pass on the production posture it prescribes**:
it read `auth_signing_keys` directly, which FORCEs RLS, so a non-superuser
deployer saw zero rows — the only way to make it pass was to deploy with
`BYPASSRLS` and excuse that role, waiving the single most important assertion in
the file.

Three rounds of patching a check that keeps being incomplete is not bad luck.
**Proving "no unsafe configuration exists" by listing unsafe configurations is
unbounded by construction** — the catalog can always express one more thing than
the list. So the enumeration inverted, into `0003_tenancy_exposure_manifest.sql`:
everything a non-trusted role can reach — every schema, every relkind, every
privilege, every `SECURITY DEFINER` function — must be **declared** in
`tenancy_exposure_manifest` with a disposition and a reason. Reachable-and-
undeclared is now the failure condition, so a new schema, object kind, verb or
grantee fails by default rather than needing to be predicted. `check-deploy.sql`
went from 380 lines to 130.

The other half is behavioural, in `packages/db/src/tenant-isolation.test.ts`: two
seeded tenants, real reads and writes across every scoped relation, asserting the
row sets are disjoint. That is the half a catalog check structurally cannot do —
a substring is not a scope, and no amount of inspecting `pg_policies` turns one
into the other. All five of audit four's attacks now fail the gate, and the gate
passes as a non-superuser deployer with no RLS bypass.

**Audit five found one assertion left in the old style, and it was the one with
no test.** The policy-scoping check exempted any policy whose role list mentioned
a service role, so `CREATE POLICY p ON score_rows FOR SELECT TO app_rw,
svc_scorer USING (true)` — one statement — passed the gate and returned every
tenant's corpus to an authenticated session. RLS ORs permissive policies, so
naming a service role alongside `app_rw` changes nothing about what `app_rw`
reads. The predicate asked whether *any* named role was trusted; the property is
whether *every* one is.

**Those two facts are the same fact.** The only assertion in the file without a
failing case was the only one that did not work. Every assertion now has one,
and the five it was missing are the reason this is worth writing down rather
than just fixing.

Audit five also closed: the manifest match ignored the grantee, so a privilege
declared `service` silently authorised it for tenants too; the `shared` column
test was a five-word case-sensitive regex that `brand_id`, `org_id`, `agency`,
`owner_id` and `"WorkspaceId"` all passed — and in this schema brand identity
*is* tenant identity, so shared columns are now declared rather than guessed;
partitions were seeded once at migration time, so `ensure_score_partition()` — a
correct maintenance job — failed the deploy on the 1st of every month, and a gate
that fails routinely gets `|| true`'d; predefined-role membership
(`pg_execute_server_program`) confers power that never appears in a table ACL, so
no privilege derivation could see it; and the gate's own functions were granted
to PUBLIC, handing a tenant a ranked list of exactly which relations are
reachable-and-unreviewed. They now go to a `deploy_check` role.

**Audit six found that the fix for the partition churn had opened a hole.**
Resolving a partition to its parent's declaration through `pg_inherits` stopped
the monthly false failure, and propagated the *declaration* downward while
leaving every *obligation* attached to the relation named in the manifest. A
partition created without RLS, an existing partition with RLS switched off, a
table staged with `LIKE ... INCLUDING ALL` (which does not copy RLS) and then
attached, and a legacy `INHERITS` child all passed the gate and returned another
tenant's rows to a legitimately authenticated session. Sticky, too:
`ensure_score_partition()` short-circuits on the relation already existing, so a
partition pre-created without RLS stays that way forever, and that helper's
normal behaviour is to grant every partition to `app_rw`.

The second was sharper. A **child of the shared relation** — carrying a correct
`workspace_id = current_workspace_id()` policy of its own, which is exactly what
`0000` instructs — reads nothing through itself and every tenant's private
prompt bank when read through the parent, because a parent applies the
*parent's* policy to its children's rows and a shared relation's policy is
`USING (true)`. A shared relation must be a leaf; no column-list comparison on
the parent can ever see this.

**And the correlation held a third time.** The three mechanisms whose only tests
asserted the gate *tolerates* something — `manifest_root()`, the `deploy_check`
exemption, `assert_role_powers()` — were the three that were broken. Each now
has a case requiring it to refuse.

**Audit seven found three more, two of them again created by the previous fix.**
The descendant sweep resolved the manifest on the *root's* schema while the two
other loops resolve it on the *child's*, so `CREATE TABLE archive.accounts (LIKE
public.accounts)` plus an `INHERIT` — a cold-storage move — shed the obligation
while keeping the declaration, and returned every tenant's user emails. And a
`scoped` declaration on a **view** carried no obligation at all: views have no
policies, the RLS duty was filtered to ordinary tables, and a plain view runs
with its owner's rights straight past RLS. The obligation is now derived from the
relation kind rather than filtered to one.

The third is the one worth remembering. **The gate could not pass the production
posture at all.** Ownership confers every privilege implicitly; the sweeps
excluded only superusers, which worked solely because PGlite's owner is one.
Reassigning the tables to a non-superuser — what Supabase does by default, and
what `0001` says the design exists to survive — produced 54 faults. The gate had
never been run against the shape it was written for, and the predictable remedy
(exempt the owner by name, or `|| true` in the pipeline) is what its own preamble
warns against. Owners are excluded per relation and constrained instead.

**Accepted consequence, recorded rather than discovered later:** the tenant read
path is now a write path. `set_workspace_jwt()` INSERTs, so it fails under
`default_transaction_read_only`, and the context table is `UNLOGGED` and so does
not exist on a physical standby. **Supabase read replicas are unavailable to
`apps/web` while the context lives here.** Every tenant request also consumes an
XID. This is the price of the mechanism being sound and is not negotiable
downward — relaxing the write is what would put the context back somewhere the
tenant can reach. If replicas become necessary that is an ADR, and the only
shape that avoids the write puts an HMAC inside every RLS policy evaluation.

**The branch split, 2026-08-24 (ADR-0007). The mechanism merged; the gate did
not.** Seven audits produced two separable outcomes, and continuing to treat
them as one was costing everything else in the project.

The mechanism held all seven, every attempted bypass blind, including the bare
`SET LOCAL` path each audit was instructed to try first as a real non-superuser
`LOGIN` principal. It is on `master`.

The gate did not converge, and the way it failed changed. Audits 1–4 kept
finding shapes the enumeration had not anticipated — an incompleteness argument,
which the manifest inversion was the right answer to. **Audits 5, 6 and 7 each
found that the previous round's fix had opened the next hole:** the manifest
match blind to the grantee; `manifest_root()` propagating the declaration down
the tree without the obligation; declaration keyed on the child's schema and
obligation on the root's. Three rounds of a fix generating its successor is a
different claim from four rounds of an incomplete list. The first says the list
is short. The second says the approach is wrong.

What merged: `0002_tenancy_context.sql`, the corrected `0001` header,
`schema.ts`, `rls.test.ts` (53 tests), `tenant-isolation.test.ts` (15 tests) and
`check-deploy.test.ts` (20 tests). The isolation suite now derives its subject
from `pg_policies` rather than from 0003's manifest, so it stands alone — and
that is the better property anyway.

The reduced gate keeps its own rule, so each of its six remaining assertions
ships with the unsafe database it refuses. That immediately paid: the
dropped-context-reader case failed, because `has_function_privilege()` **raises**
on a signature that does not exist — so a missing reader reported `function
"set_workspace(uuid)" does not exist` instead of the assertion's own message. The
deploy failed either way; the operator got the wrong reason. Fixed by asserting
existence first. On the branch that case passed, because its expectation was an
alternation the other branch satisfied — the same pattern that hid three earlier
BLOCKERs.

What did not, and stays on `fix/tenancy-deploy-gate`:
`0003_tenancy_exposure_manifest.sql` and `deploy-check.test.ts` (78 tests).
`check-deploy.sql` on `master` keeps only what holds without the catalog
derivation — role exclusivity, the `pg_class` RLS sweep, the context readers, the
bare-GUC regression, pgcrypto resolution — and says in its own header that it is
partial, why, and by when. Three assertions are deliberately absent rather than
reimplemented: the exposure manifest, `assert_role_powers()`, and live
signing-key health (which needs `auth_key_health()` from 0003; until then a
deploy with no live key fails at first login rather than at deploy time).

**The gate is open work with a hard deadline: it must be closed before G1, not
"before launch".** PHASES.md's standing suite item 3 runs the RLS suite at every
gate, and G1 is the first gate at which real collected rows exist to be isolated.
"Before launch" has no date attached and is the phrasing under which this would
never be closed.

**The next attempt is a redesign, not an eighth round.** Enumerate every
RLS-relevant object from Postgres's own catalog — `pg_class` across all relkinds,
`pg_inherits` for both partitioning and legacy inheritance, views and their
`security_invoker` setting, real ownership via `relowner` — and require every
object *found* to prove coverage. No hand-written exemption or inclusion list;
those are what missed the unanticipated arrangement, seven times. 0003 is the
starting point, not the baseline: it already inverted the enumeration, but it
resolved properties against something other than the object itself, which is the
single mistake underneath rounds 5, 6 and 7.

**Honest statement of what `master` now guarantees.** DB-level tenancy
enforcement that survived seven adversarial audits, plus a behavioural isolation
suite that catches what no catalog check can. It does **not** have a complete
deploy-time gate: a misconfiguration introduced by a deploy-time `GRANT` will not
be caught until the redesign lands. That is a real reduction against what the
branch tip claimed, and it is the reason the deadline is a gate rather than a
sentiment.

### P3 — the demo taxonomy, classifier and banks (2026-08-24, ADR-0008)

**Why this exists at all.** The 3.1 scoping report found the category classifier
unbuildable as specified: its output space did not exist. No taxonomy anywhere in
the repo or the plan, no granularity decision, no labelled set for G3's ≥95%
criterion, and two of the three named input signals with no provider, no key and
no cost line. Those questions are still open. **ADR-0008 answers none of them** —
it creates eight hand-authored categories so the application can be demonstrated
end to end, built so that adopting the real answer costs a deletion.

**The geo contradiction is resolved for these entries.** `prompt_banks` is
`UNIQUE(category, locale, geo, version)` while `/category-bank`'s own argument
hint is `india-d2c-skincare in`, putting the country in the slug *and* passing it
separately. The slug is now geo-free, and the deciding argument is R6 rather than
tidiness: the cache key already carries geo, so a geo-bearing slug fragments one
vertical into N banks whose prompts normalise identically — the same text
collected once per variant, into a different cell each time, no cache hit between
them. `/category-bank` still contradicts this and was left alone; correcting a
production artefact belongs with the production decision.

**The classifier is deterministic, and the reason is not R1.** A Haiku
classification is ~$0.0002 against a $0.18 scan, so cost is a weak argument here.
The category decides which bank runs, which decides `comparison_basis` — so a
non-deterministic classifier lets one domain land in different banks on different
days and the thing a number measures changes underneath the customer, which is
exactly what `compare()` refuses. Two offline signals: leader-domain match, then
whole-token domain keywords. Concatenated labels are never segmented (`mycrm.com`
is unclassified) because substring matching is how `compass.com` becomes a
password manager. Three outcomes, and **there is no default category**: a
fallback would be a silent `comparison_basis` change wearing a helpful face.

**Eight banks, 240 prompts, authored and then adversarially reviewed** across
three lenses — leader sets, prompt neutrality, cache-key duplication. The review
returned **50 findings including 5 blockers**, and they were not cosmetic:

- `zoho` as a bare alias matched "Zoho Books" and "Zoho People", both *leaders in
  other banks* — a live cross-brand collision that flips `mentioned`, not just a
  count.
- `monday.com` was an alias AND a domain in two banks, so one string resolved to
  two leader ids and any rollup joining on brand id double-counted the vendor.
- Apex `microsoft.com` on Dynamics, apex `adobe.com` on Adobe Commerce, apex
  `intuit.com` on QuickBooks, apex `atlassian.com` on Jira: `isOnDomain` matches
  subdomains, so each credited every sibling product's citation to one leader.
  The Jira case stole citations from Trello, a co-leader in the same bank.
- One prompt named Mailchimp outside brand-verification, making its mention rate
  on that cell structurally 100%.

All 50 were applied or explicitly declined with a reason. Nine attribution limits
that cannot be fixed host-side are recorded in the bank notes rather than papered
over — Zoho, Proton Pass and Adobe marketing pages live on paths, and host-only
matching cannot see them, so those citation rates are stated as lower bounds.

**A finding of the same class as the tenancy one.** The Grader's input check
carried a comment saying it had been hardened so `hello.txt` could not reach a
collection call. It had not: the regex accepts `hello.txt` and `report.pdf`,
because `.txt` is only "not a TLD" if you carry a 1,500-entry TLD list. Verified,
corrected in place, and the real guard named instead — an unclassified domain has
no category, so no bank, so no cycle is ever published.

**Attribution domains and classification domains turned out to be two jobs.**
Narrowing `domains` for attribution correctness made `zoho.com` unclassifiable,
which killed the demo's flagship case. `siteDomains` now carries the
classification-only signal, so `zoho.com` returns ambiguous across the three
categories Zoho really leads instead of the attribution list being widened back
and quietly re-breaking the scorer.

⚠️ **HUMAN REVIEW REQUIRED: services/scorer — case-sensitive alias matching.**
Three leaders cannot be counted correctly without it. Bare `notion` matches "the
notion that"; bare `kit` matches "media kit"; `gusto` matches "with gusto" and
`rippling` matches "a rippling effect". Notion and Kit are therefore matched only
through unambiguous forms and their mention rates are **lower bounds**; Gusto and
Rippling keep their bare aliases and are **upper bounds**. A test asserts the
bank note records the bias wherever a known-risk alias is used, so the caveat
cannot be dropped silently. Fixing it properly is a scoring-algorithm change: R5
version bump, golden-set diff, `stats-reviewer`. **Not touched.**

⚠️ **HUMAN REVIEW REQUIRED: services/collector/pilot/bank.json** — the review
found two defects in the G0 pilot bank, which is flagged for human review in its
own note. It lists `microsoft.com/en-us/dynamics-365`, a path that can never
match because `isOnDomain` compares hosts only, and a bare `freshworks` alias
that credits Freshdesk and Freshservice to Freshsales. **Not touched.**

Also open: `crm-software` now exists twice — the P0 pilot bank (100 prompts,
en-US/US) and a demo bank. They must be reconciled before either runs a real
cycle, or one category collects two different prompt sets.

**503 tests (was 461), 26 files.** 42 in `packages/taxonomy`: the classifier
against fixtures, the shipped banks as data, and the classifier against the real
banks — every leader domain must classify, every category must be reachable, and
the two genuine ambiguities (Zoho across three categories, HubSpot across two)
are asserted rather than resolved.

### Spend control, reworked twice under review

`services/collector/src/spend-ledger.ts` (`6c41ce3`, `47a5e75`). ⚠️ HUMAN-OWNED.

The P1.1 runner made an old assumption dangerous. `Budget` reads its ledger once
at construction and charges in memory — correct for the one-process pilot, wrong
for a fan-out to auto-scaling instances, where each cold container gets its own
ledger and `COLLECTION_BUDGET_USD_DAILY` silently becomes a ceiling *per
container*. `SpendLedger` is the seam; `KvSpendLedger` holds the cap in an atomic
shared counter, charging increment-then-check so two concurrent workers cannot
both take the last slot.

Two review passes reshaped the guard around it:

1. `LocalSpendLedger` lost its public constructor — reaching for the unsafe
   implementation now requires a written reason.
2. That guard **failed open**. It inferred "am I in a fleet?" from a list of PaaS
   environment markers, and a bare Hetzner CAX VM — the actual P5 target — sets
   none of them, so absence read as safety. Topology is now **declared**
   (`COLLECTOR_TOPOLOGY`), undeclared is refused, and the marker list survives
   only as a veto that can force `fleet` and never grant `single-process`.

Also from those passes: a shared high-water mark so a worker with a stuck clock
cannot write to a private stale window and collect a second cap; alerts on a
failed refund and a failed charge, both of which fail toward under-spending but
were previously silent about it.

### Collection heartbeat

`services/collector/src/collection-heartbeat.ts` (`6c41ce3`). Alarms on the
**absence of success**, not the presence of errors — because both transports
fail closed by design. A wrong QStash signing key or an expired R2 credential
produces no errors and no collection, and an error-rate alert cannot see a queue
that stopped being delivered. States: healthy / stale / dark / never-collected,
with never-collected deliberately not paging (a new deployment has never
collected, and paging on day one teaches everyone to ignore the alarm). Cache
hits are excluded: a hit proves the cache works, not that collection does.

### P2 — scoring (fixture-only, `f4f18d1`, `6378c92`)

| # | Item | Status |
| --- | --- | --- |
| 2.1 | Deterministic scorer | **Done, fixture-only.** No model call on any path (R1). URL masking so a brand appearing only in a link is cited but not *mentioned*; `position` is a rank among detected brands, not a character offset; explicit letter/digit/underscore boundaries rather than ``, which does not fire around `+` or `.`. A test pins that a score row carries **no** interval — one answer is one Bernoulli trial. |
| 2.1b | Citation source classifier | **Done, fixture-only.** ADR-0005 classes, identity before platform. The hard constraint has its own tests: no input reaches `owned` for an unlisted domain, including a provider-supplied publisher name — acting on that would make the class depend on which provider collected the run. |
| 2.5 | Golden set | **Skeleton only.** Harness plus 7 hand-built seed cases. Returns `NOT_RUN` below the 300-case target: agreement over a dozen answers is noise wearing a gate's clothes. |

`measurement-engineer` found **three BLOCKERs**, all reproduced before fixing:
nested aliases double-counted mentions (`Zoho` + `Zoho CRM` scored one
occurrence as two, inflating frequency for most brands); an empty string in
`brand.domains` made `cited` true for arbitrary URLs; and competitor labels
depended on array order, so an unordered query could change a stored field with
no change to the answer (R5). The harness gap that let the first one through —
`mentionCount` was not a labelled field, so a bug corrupting it was invisible
and would have passed G2 at 300/300 — is closed too.

### UI scaffolds (`56e8c53`, `6378c92`, `6c41ce3`)

`apps/web` (dashboard) and `apps/public` (Grader). Both build clean and static.
All data is fixture data, and both pages say so on the page.

`packages/stats/src/format.ts` is where R8 stops being a review comment: the
`Metric` type has no optional fields, so rendering a bare point estimate is a
compile error. `compare()` tests interval *overlap*, so a movement the sample
cannot resolve reads as "no significant change" with no colour, no arrow and no
emphasis. ⚠️ HUMAN-OWNED, and three things in it are explicitly **PROVISIONAL**:
the A–D grade thresholds (blocked from any live build — `BLIPRANK_ENV=live`
fails `next build`), `MIN_N_FOR_COMPARISON`, and the overlap test itself, which
is documented for customers in `METHODOLOGY.md` Known Limitations §6. All three
get their real values from G0 data.

`frontend-designer` found two CRITICALs: the confidence band was effectively
invisible (1.20:1 against the card, 1.02:1 against the gridlines it overlays),
and a metric rendered without its interval — in the scaffold built to
demonstrate R8. Both fixed.

**PHASES 3.4 — head-to-head with CI bands (2026-08-24).** `apps/public` gains
`lib/head-to-head.ts` (ordering, verdicts, geometry — pure), a dot-and-range SVG,
a fixture competitor set and 28 tests. A band is right for the trend chart, where
the x-axis is time and the space between cycles is real; brands are categorical,
so this is one interval per row with a marker at the estimate. Verdicts come from
`compare()` rather than being re-derived — every guard it already carries (algo
bump, collection path, `comparison_basis`, the n floor, mismatched precision)
applies unchanged to brand-vs-brand. Rows sort by point estimate *including* the
subject, and the subject's own interval is projected across every row, so a bar
that touches it is a brand the scan cannot separate from you whatever order it
sits in. A competitor with a HIGHER estimate and an overlapping interval has its
own test: if that ever returns "ahead", the chart has become a league table.

**The first CRITICAL was only half fixed, and the fix could not have worked.**
Measured rather than eyeballed: the band's stroke at `--color-secondary` 0.85 was
**2.98:1 against the card** — under the 3:1 its own comment claimed — and
**2.53:1 against the gridlines**, which is the half of the finding that survived.
Raising the opacity could never have closed it, because secondary at *full*
opacity is 3.01:1 on a gridline: that is the ceiling, so the colour had to change.
It is now `--color-primary` at full opacity (7.15:1), in both apps, with the
legend swatch corrected to match — a legend that misdescribes the chart is the
exact defect the comment beside it was written about.

The durable part is that contrast is now **enforced rather than reviewed**.
`apps/public/lib/head-to-head.test.ts` parses the real stylesheet, resolves the
custom properties, composites each mark over every surface it can sit on and
checks it against every surface it can sit *beside* — the full adjacency matrix,
because the reported 1.02:1 was the band over the CARD next to a bare GRIDLINE, a
pair a same-surface check never forms. It reproduces both original figures to two
decimals, which is what shows the harness measures the same thing the designer
measured by hand. A fix that depends on someone reviewing it again is not a fix.

**Free-scan size — decided 2026-08-24, and there is nowhere yet to configure it.**

The decision: a free scan must collect enough answers to clear
`MIN_N_FOR_COMPARISON`, so the head-to-head is not silently empty on the tier
most visitors see. Correct, and it turned out to be unimplementable today —
**there is no free-tier scan configuration anywhere in the repo.** Verified, not
assumed:

- `grep -rln grader services/ packages/` matches one doc comment in `format.ts`
  and nothing else. No Grader collection path exists in any service or package.
- The Grader "run" in `apps/public/app/page.tsx` is a `setTimeout` returning a
  fixture. No provider is contacted on any path.
- `CollectJob.runs` (`qstash.ts`) is a required per-job field with **no default**,
  and `publishCycle` has **no caller outside tests**. Nothing in the repo builds
  a collection cycle for the Grader or for any tier.
- The only job builder is the G0 pilot (`pilot/collect.ts`), a different thing:
  100 prompts × 5 engines × 10 runs against three known brands, driven by
  `bank.json` and CLI flags.
- `packages/contracts` has no tier or plan concept. `packages/db` has
  `plan: trial|starter|growth|scale` on subscriptions — billing tiers, not scan
  sizes, and the Grader is pre-signup so none of them applies.
- P3.1 (category classifier), P3.2 (200 prompt banks) and P3.3 (the real Grader
  run) are all unbuilt.

So the decision was recorded where it will bind instead of being implemented into
a config file nothing reads: **PHASES.md 3.3 and a new G3 functional criterion**,
with the fixture resized to the decided shape (20 prompts × 5 engines × 1 run =
100) so the scaffold demonstrates it.

**Sized on the degraded case, not the nominal one.** The G0 pilot got HTTP 403
from all five surfaces simultaneously, so two dark engines is a normal bad day
rather than pessimism. 20 × 5 leaves 48 answers on three surviving engines at 80%
yield; 12 × 5 leaves 28.8 and the chart goes silent on exactly the day a customer
is most likely to be looking. Breadth over depth, too: `n_eff = n / DEFF` and
DEFF grows with runs per cell rather than prompt count, so one run over many
prompts buys more effective sample than many runs over few for the same money.

⚠️ **COST FLAG — the free Grader only closes on Mega.** Per scan at one run per
cell across five engines: **$0.180 at Mega marginal**, $0.280 Ultra, $0.460 Pro,
**$0.680 pay-as-you-go**. G3's novel-domain criterion is ≤ $0.20. Mega passes
with a 10% margin; every other plan fails, pay-as-you-go by 3.4×. Even the bare
minimum that clears the floor with no failure margin (6 prompts × 5 engines) is
$0.204 at pay-as-you-go — over the gate before any resilience is bought.
`Budget` charges every *attempt* including retries (`maxAttempts: 3`), so
realised cost sits above nominal.

⚠️ **And the free surface shares one daily ceiling with paid collection.**
`COLLECTION_BUDGET_USD_DAILY` is a single global cap (`.env.example` ships 25),
not a per-tier or per-surface one. At $0.180 a scan that is ~138 novel-domain
grades a day before the ledger refuses **everything**, paid customers' cycles
included. Nothing was adjusted: per the standing instruction, budget logic is
HUMAN-OWNED and a cap change is a decision, not a side effect. The per-IP budget
cap in P3.6 is the intended control and is unbuilt.

Both numbers are downstream of a provisional one. `MIN_N_FOR_COMPARISON` is
pending G0's measured design effect, so the floor, the scan size and the cost per
grade all move when G0 runs. The floor is never written as a literal in the
Grader: `head-to-head.test.ts` imports the constant and fails if the scan stops
clearing it, degraded case included.

⚠️ **TRACKED, NOT FIXED — design-token contrast margin.** The competitor bars
(`.h2h__interval`, `.h2h__cap`) sit at **3.01:1**, passing WCAG 1.4.11 by 0.01.
The worst case is `--color-secondary` against `--color-border` where a horizontal
interval crosses a vertical gridline, and full opacity is already the ceiling for
that pair. Closing the margin means moving `--color-secondary` or
`--color-border`, which is a cross-app design-token change and out of scope for
3.4 — deliberately left rather than smuggled into a feature commit. The contrast
suite fails loudly if either token moves the wrong way, so this cannot regress
silently. **Next action:** decide the token change with the P3 design pass, when
a frontend design plugin is active again (see §4).

**`27652c2` — signed off 2026-08-22.** The R2 object identity change is now
recorded formally as **ADR-0003 Amendment 1**, and CLAUDE.md R4's shorthand was
corrected to match. The flag is closed.

⚠️ **HUMAN REVIEW REQUIRED** stands on the JWT verifier merged with
`p1/db-schema` — see above.

### Design audit and the pricing page (2026-08-25)

**The range-as-hero pass was audited against its own brief and four gaps
closed.** All four were geometry or comprehension faults that the contrast suite
structurally could not see, because it checks colour and these were about
position and wording.

1. **Marks escaped their plot at the extremes.** Close sits at 0.0% in the
   collected pipedrive.com scan, and a mark positioned by its centre loses half
   its body there: the head-to-head dot collar reached 5.5px past the plot edge
   and drew over the row's own label, and `.rail__needle` lost 3.5px of its 7px
   at both 0% and 100%. Both now travel the track minus their own width. Asserted
   on the rendered SVG, not eyeballed.

2. **A refused comparison did not say why, where a reader would see it.** The
   reason existed only in a paragraph below the chart. Hovering or tabbing to
   Close said "not comparable" and nothing more — the hardest verdict to render
   was the one given least explanation. `reasonFor` moved into the shared lib and
   now feeds the detail panel, the table and the prose from one source.

3. **A dashed bar with no legend entry, next to a dashed swatch meaning something
   else.** The legend's dashed box means "your interval, projected"; uncompared
   rows draw a dashed BAR. A reader checking the legend was actively misled.
   There is now an entry for it.

4. **The screen-reader path had strictly less than the visual one.** The table's
   verdict cell gave the verdict without the reason, and the glyphs are
   aria-hidden. It now carries the reason too.

**All six verdicts are rendered in a test**, against a constructed dataset,
because the committed scan only exercises four. `insufficient-data` is currently
UNREACHABLE from a live scan — every brand in a scan shares one `n`, so a scan
at n=85 cannot produce it — which is exactly the kind of branch that rots
silently until the first scan small enough to trigger it, live.

⚠️ **FLAGGED, NOT FIXED — `format.ts` is HUMAN-OWNED.** `formatInterval` renders
an exact-zero bound as `0`, not `0.0`: Close's interval prints `0–4.3%` while
every other row prints two decimals on both bounds. In a tabular-figures column
that is the one row whose decimals do not line up, and it is the row most likely
to be questioned. The render test asserts what ships rather than changing it.

**The pricing page is built** — `apps/public/app/pricing`, three tiers
(Starter $49/15 prompts, Pro $149/40, Growth $349/100), each cap shared between
app-curated and customer-added prompts, all re-checked daily across five
engines. Static in the strong sense: no payment provider, no account creation,
no cap enforcement, and the page says all three out loud. The shared cap is
demonstrated with a native `<input type="range">` whose two halves visibly take
from each other, because "shared" is routinely misread as two allowances and a
sentence cannot disprove that reading.

⚠️ **Three contrast failures were introduced and caught before commit**, all in
the new pricing work, all found by computing rather than by looking:

| Element | Was | Needed | Fix |
|---|---|---|---|
| Ink on `--color-primary` (flag, CTA, filled half) | 6.70:1 light, **2.31:1 dark** | 4.5:1 | `--color-on-primary`, which flips with the theme |
| Ink on `--color-secondary` (unfilled half) | 4.10:1 light, **3.48:1 dark** | 4.5:1 | half recoloured, ink tokenised |
| The split bar's two halves, against each other | **1.63:1 light, 1.51:1 dark** | 3:1 | filled half solid primary, unfilled `--color-muted` with a primary outline |

The third is the serious one and is the same mark-on-mark blind spot that hid
the trend band and the head-to-head dot: every colour passed against its own
surface, and the single boundary the bar exists to show was invisible. All three
are now assertions in the contrast suite.

Touch targets on the page were 30–32px and are now 44px.

⚠️ **PRE-EXISTING, UNRELATED, BLOCKS DEPLOY BUT NOT THE DEMO.** `next build` on
`apps/public` fails prerendering `/404` and `/500` with `<Html> should not be
imported outside of pages/_document`, which is the pages-router error fallback
masking the real cause. Confirmed pre-existing: it reproduces identically at
`6060f1a` with this work stashed. `next dev` is unaffected, so the demo runs;
ADR-0002's Cloudflare Pages deploy cannot ship until it is diagnosed. Its own
task.

598 tests, 30 files. Typecheck clean on both apps.

### Live scanning opened up, and the guard it cost (2026-08-25)

On an explicit instruction, the Grader now auto-scans any real domain that is not
already cached — no manual gate, no confirmation step. Three changes, and the
second one traded away a safety property that should be recorded as such.

**1. The taxonomy went from 8 categories to 14 plus a fallback.** New banks for
help desk, website builders, analytics, SEO tools, video conferencing and
e-signature, each with 6-8 leaders and 30 prompts in the mandated intent mix. The
fallback, `general-business-software`, has **no leaders and no keywords** — it
cannot be matched into, only fallen back to, and having no competitor set is the
design rather than an omission. See ADR-0008 Amendment 1.

Two apex conflicts surfaced while building it and were resolved rather than
papered over: `hostinger.com` (already leads web-hosting) was dropped from
website-builders, and `wix.com` is left deliberately ambiguous between website
builders and ecommerce because Wix genuinely leads both.

⚠️ **2. A REAL SPEND GUARD WAS REMOVED.** `runScan`'s PROPERTY 1 was *"a domain
that does not classify never spends"* — no category, no bank, no cell, no
provider call. That is gone: an uncategorised domain now costs a full scan. The
test that asserted it has been rewritten to assert the narrowed property and
carries a warning explaining what was traded and why.

What replaced it is narrower on purpose. `normaliseHost` accepts `report.pdf` —
documented long ago, and harmless only because unclassified used to buy nothing.
With that gone, a pasted filename would have bought a full scan, so
`looksLikeFilename` now refuses file extensions before the fallback is reached.
**Known cost:** `.zip` and `.mov` are real gTLDs and are refused.

**The remaining exposure is accepted, not solved:** any well-formed domain
spends, with no confirmation step. The provider quota is the only thing between a
typo and a scan.

**3. The quota-exhausted path was made honest.** The likeliest failure on stage,
so it is tested rather than reasoned about:

- The burst cap moved from 2/day to 12/day and is now a runaway backstop, not the
  operating limit — with 50 requests/engine/month and 17/scan, at most two scans
  can succeed per cycle, so the cap can never pre-empt the quota message. Asserted.
- The quota refusal now names what ran out, by how much, when it resets, that
  nothing was charged, and that cached domains still load.
- ⚠️ **An honesty bug was found and fixed in the process.** `no-answers` rendered
  as *"No engine returned a usable answer"* — which reads as a real finding of
  zero mentions. The same status is returned when every cell FAILED, i.e. when we
  learned nothing at all. Reporting a collection failure as a score of zero is
  precisely the substitution this product exists not to make, and running out of
  quota mid-scan is the likeliest way to trigger it. The two cases are now
  separate states with separate copy.
- A partial scan (quota exhausted mid-run) discloses that N of M requests did not
  come back and that the interval is correspondingly wider.

607 tests, 31 files. Typecheck clean.

### First Vercel deployment (2026-08-26)

apps/public deployed to Vercel as project bliprank-public (root directory
apps/public), a conscious interim deviation from ADR-0002's Cloudflare Pages
placement - the cost reasoning there is about acquisition-scale traffic, which
does not exist yet. Live scanning is expected OFF on this deploy (no flags, no
key set): the runner's ledger and lock are filesystem state serverless does not
have, so the public site is the fixture-honest build - bundled scans instant,
everything else refused honestly. First build failed on ERR_PNPM_IGNORED_BUILDS
(sharp): pnpm in CI hard-fails on unapproved dependency build scripts where the
same install locally only warns; fixed by recording pnpm.onlyBuiltDependencies
in the root package.json. Cross-link env vars (NEXT_PUBLIC_*) still to set once
both apps have URLs.

### Review item 4 — the interaction-design pass (2026-08-26)

Approved on before/after captures before commit, per the standing process. The
link system: primary-ink links with always-visible same-colour underlines
(8.74:1 dark / 6.89:1 light, computed), the grey hairline underline gone; the
back control restyled as a control (sans, no underline, aligned chevron with a
reduced-motion escape); ActionLink as the standalone-action pattern. Six
sentence-links split into short destination labels plus unlinked disclosure
prose, with a reviewer verifying no honesty clause shrank. In passing, the pass
surfaced a real red root typecheck (a union read without narrowing in
live-gate.test.ts, unseen because vitest never typechecks and per-app tsc never
looked) - fixed and committed separately. Parked minors: em-dashes in UI copy,
the web 404's sentence-link.

### The user's application review, batch 1 (2026-08-26)

Six review items were verified against the codebase before discussion, per the
production standard; five approved decisions landed as five scoped commits
(`ad29936..`), one per item, reviewer-audited:

- **Item 2** — one shared BackLink (chevron + named destination) on all eight
  pages that need one; both pricing pages had none, five ad-hoc shapes
  normalised, two duplicates removed.
- **Item 3** — the head-to-head moved into the measured record: brand dashboard
  and client pages now carry the same comparison the Grader shows, sigzen's
  zero-competitor prose intact and render-test-pinned.
- **Items 1 + 6a** — the switcher splits "Your workspaces" from labelled
  "Reference scans"; bundled demo records carry a REFERENCE SCAN margin note;
  the nav's Workspace anchor became a real /dashboard/workspace page.
- **Item 5a** — theme survives the origin boundary: ?theme= carried on
  cross-origin links both directions, boots persist it before first paint.
  Item 5b (folding the worked example into apps/public, amending ADR-0002)
  remains an open decision.
- **Reviewed major, fixed**: isScanResultFile validated nothing the render
  paths dereference — a corrupt session entry white-screened every surface
  through scans(). Full shape guard + four regression cases.

Item 4 (interaction-design pass) is next, presented as before/after captures
for approval before commit. 752 tests / 42 files; both apps typecheck and
build for production; crawl gate 12 routes, shoot 16 states.

### The Measurement Record through the MVP surfaces (2026-08-25 → 2026-08-26)

Fourteen commits, `b302830..9bf2fec`. Each carries its full reasoning; this is
the state they left behind.

**The Measurement Record** (`b302830`, `85fea17`, `823114a`, `81e70c2`,
`2dd09d9`): the redesign's foundation and its pages. Prussian ink on paper
stock, Newsreader/Plex Sans/Plex Mono as the three voices, the provenance
margin (R8 made spatial), cards dissolved into the record sheet. The preview
score (placeholder weights, no interval, never on a rail) and the agency
portfolio concept. All three instrument states (refusal, progress, not-scanned)
moved onto the paper.

**Tooling that changed how this is verified** (`c004fef`, `69aee6f`,
`e3c1625`, `f6bd000`): Playwright installed; `scripts/shoot.mjs` captures every
state in both viewports and themes with an R8 sweep on the rendered DOM;
`scripts/crawl.mjs` is the click-reachability gate (three personas, exits
non-zero on any unclickable served route). The `next build` "failure" was never
a repo defect — `.claude/settings.json` injected NODE_ENV=development; both
apps build clean under production and the demo runs on `next start`.

**Live data and the crash it exposed** (`bb94051`): sigzen.com was scanned live
(0.0% [0.0–4.3], n=85, fallback bank, no competitors by design) and the cached
file crashed the UI — `runGrader` returned a result without the run envelope
the route then cached. Fixed at the runner; `scanFor` became a registry. The
review found `run.spentUsd` had been the ledger's LIFETIME total printed as one
scan's cost (4.3× wrong); removed rather than guessed.
⚠️ HUMAN REVIEW REQUIRED stands on `services/grader/src/run.ts` spend
reporting (cumulative → marginal).

**The MVP surfaces** (`31e4c95`): brand dashboard (measured + pre-flight
states), agency portfolio with add-client, role-scoped navbar, Grader→Dashboard
handoff via localStorage workspace state. Domain LOCKED on the brand side
(Semrush pattern, for the history-keying reason); agencies add workspaces per
client.

**Agency pricing** (`9db336a`): $199/5/75 · $499/15/200 · $999/40/500, the
pool-versus-domains shortfall stated first (15.0/13.3/12.5 per domain against a
17-prompt cycle), every figure derived never literal, a test asserting each
tier IS short at max occupancy. "Most chosen" was a fabricated claim on a page
with no checkout — both pricing pages now say "Worked below".

**PLANNED, distinct from PREVIEW** (`3924e55`): preview = methodology not
final; planned = capability not built. Applied to the trend chart (no scheduler
exists — QStash has a handler nothing calls) and the schedule fact. The
`/agency/lifecycle` mockup shows the five-stage arc with not one invented
figure.

**The three-chrome fork** (`9bf2fec`): route decides the chrome — neutral
(Grader + both pricing pages, carrying the For brands / For agencies doors),
brand, agency. No chrome reads stored role (test-enforced). Per-client records
at `/agency/client/[domain]`; Manage Prompts (curated + custom against derived
would-allow caps, no plan attached and it says so); cycle status split into a
real "Last checked" and a PLANNED "Next check". The navigation audit's findings
(agency side reachable only via an accidental cross-app link; agency pricing
behind a footnote) closed. Review caught the portfolio pool drawn against the
BRAND tier and a cache-dependent two-React vitest resolution; both fixed with
regression tests.

**State now**: 736 tests / 41 files, both apps typecheck and build for
production, crawl gate exit 0 across three personas, 15 capture states clean.
Quota per provider `/usage` (authoritative, free): gemini 12 remaining is the
binding constraint — a full scan needs 17, so live collection self-refuses at
the gate. GRADER_LIVE_SCAN remains ON by explicit instruction.

### Material, interaction and pricing craft (2026-08-25)

A second design pass, built on the Instrument Serif / range-growth / ruler-tick
direction rather than replacing it. Three areas, and the verification is the
point of the entry.

**Material.** Cards, the stamp, the splitter panel and the detail tip now carry a
lit top edge (`--edge-light`, one inset hairline) over their shadow, which is
what makes a flat rectangle read as a panel. Every card lifts on hover, not just
the ones in a grid — the result card, the most-looked-at surface in the product,
previously did not respond to the pointer at all. The page background carries a
32px calibration grid, the ruler idea at page scale, held still under the content
on desktop pointers only (`background-attachment: fixed` stutters mobile Safari).

**Interaction.** ⚠️ **The primary form was entirely inline-styled** — the input
and the submit button, the two controls the whole demo runs through. That meant
no hover, no `:active`, no disabled treatment, colours the contrast suite is
structurally blind to, and a `transition` written inline **where
`prefers-reduced-motion` can never reach it**. All of it is now `.field` / `.btn`
/ `.btn--quiet` classes with hover, press, focus and disabled states. The focus
ring is drawn with `box-shadow` *in addition to* the global outline, so Windows
high-contrast mode — which discards shadows — keeps a visible ring.

**Pricing.** The featured tier is raised and capped with a 3px accent rail rather
than tinted, because a colour wash behind a price sits badly next to numbers this
product asks people to trust. The price is typeset (small raised currency mark,
3rem mono figure, tight tracking) and read to screen readers as one sentence
instead of "149 slash month US dollars per month". Feature rows get a hairline
marker rather than a tick — these are specifications, not benefits. The pool bar
and splitter carry the same calibration ticks as the range rail, so the two
signature components are visibly from one instrument.

**⚠️ TWO REAL FAILURES, BOTH FOUND BY COMPUTING RATHER THAN LOOKING.**

| Finding | Was | Needed | Fix |
|---|---|---|---|
| `.field` border used `--color-border` | **1.24:1** light, **1.28:1** dark | 3:1 (WCAG 1.4.11 — it is the only thing showing where the input is) | new `--color-field-border`, tuned to clear 3:1 on card, background *and* muted in both themes |
| `.btn--primary:hover` shade | unverified | 4.5:1 | computed: 7.73 light / 9.35 dark. In dark the mix moves *toward* the light foreground, i.e. away from the dark ink — the direction had to be checked, not assumed |

**Four new test groups, and each was mutation-tested to prove it bites:**

- **WCAG 2.3.3 coverage** — parses both stylesheets, brace-matches every
  `prefers-reduced-motion` block, and fails if any selector declares a
  transition or animation without an escape. Verified by injecting an uncovered
  rule and watching it fail. Also bans inline `transition`/`animation` in TSX,
  which no media query can reach.
- **Control contrast** — field border on three surfaces, the computed hover mix,
  the quiet button on both its grounds, the featured accent. Verified by
  weakening the border token and watching it fail.
- **Target size** — `.btn`, `.field`, `.capsplit__tier`, `.tier__cta` at 44px.
- **Overhang clipping, generalised** — a registry of marks that deliberately
  overhang their container, asserting no container clips them, *plus* an
  assertion that they still overhang so the guard cannot become decorative.
  Verified by adding `overflow: hidden` to `.tier` and watching it fail.

Text over the new page texture was checked too: 16.51:1 light / 14.86:1 dark
worst case (directly over a grid line).

627 tests, 32 files. Typecheck clean.

---

### The flag that could not be turned on, and a personality pass (2026-08-25)

**⚠️ THE FLAGS WERE UNREACHABLE BY THE DOCUMENTED METHOD.** `.env.local` was
edited correctly and live scanning stayed off, silently, with no error. Two
independent causes:

1. `.claude/settings.json` injected `COLLECTION_ENABLED` into every spawned
   process, and Next never lets `.env.local` override a variable already in
   `process.env`. (Resolved by the operator removing the override.)
2. **The route read `process.env` only** — but Next loads env files from the
   directory it runs in, `apps/public`, never from the repo root where
   `.env.local` actually lives. Meanwhile `loadApiKey` reads the root file
   explicitly. So the KEY resolved from root and the FLAGS GOVERNING IT did not.
   CLAUDE.md §7 documents the flags as living in `.env.local`; `load-key.ts`
   documented its refusal to read them from there. Both were in the repo at once.

`readFlag` closes it: environment first, then the repo-root `.env.local`, then
`.env` — the same precedence and root as the key. It keeps the "deliberate act"
property by other means: an **allow-list** of exactly two names (a cap or a plan
read from a stale file is still refused), and it reports which source set each
value, so the disabled message now says *why* rather than just *that*. Verified:
both flags resolve `true` from `.env.local` even with a completely clean
environment. **Live scanning is ON.**

**Design — a personality pass.** Three moves, no gradients, nothing competing
with a number:

- **Type.** Fira Sans/Code, loaded through a render-blocking `@import`, replaced
  by self-hosted `next/font`: **Instrument Serif** on headings (editorial
  register — the words, never the data), **IBM Plex Sans** for interface, **IBM
  Plex Mono** for every figure and provenance line. No third-party request at
  runtime and no flash of fallback text.
- **The signature motion.** The interval band now grows **outward from the point
  estimate** to its true bounds, rather than sweeping in from the left. That is
  the product's argument played once: a measurement starts as a point and the
  honest version is the range that opens around it. Competitors animate a bar
  filling up, which says *bigger is better*. Implemented as `scaleX` about a
  computed origin, never `width`/`left`, so it never runs layout.
- **The ruler.** Hairline ticks every 5% with longer quarter marks — the texture
  of something calibrated. Decorative and drawn under the band, so it cannot
  lower any mark's contrast.

⚠️ **A regression was introduced and caught by arithmetic, not by looking.** The
tick texture arrived with `overflow: hidden` on `.rail__track`, which is 12px
tall — and the needle is 18px and deliberately overhangs it. That silently
cropped a third off the one mark required to be readable in under a second.
**There is no browser in this toolchain**, so nothing else here could have seen
it. Removed, and pinned by a test that rejects any clipping `overflow` on that
selector in either app. The first tick colour had the same shape of fault:
`--color-border` computes 1.13:1 against the track, which is not subtle but
absent; it is mixed down from the text token instead.

616 tests, 32 files. Contrast suite green in both themes after every change.

**`.agents/skills/design-taste-frontend/` — already resolved, no action needed.**
Deleted in `261f558` and recorded below. Not restored to `.claude/skills/`
deliberately: its own scope line reads *"Landing pages, portfolios, and
redesigns. Not dashboards, not data tables, not multi-step product UI"*, which
excludes nearly all of this repo, and `ui-ux-pro-max` already covers the
dashboard and chart cases properly.

---

⚠️ **BLOCKED, NOT DONE — the env flags could not be set from this session.**
`.claude/settings.json` denies `Read(./.env*)`, so `.env.local` cannot be read or
written here. Worse, that same file injects `COLLECTION_ENABLED: "false"` into
every spawned process, and Next.js does not let `.env.local` override a variable
already present in `process.env` — so setting it in `.env.local` alone will NOT
enable live scanning for a dev server started from this session. Both changes are
needed. See the handover note in the session report.

---

## 3. Tools and services, and why

From `docs/ARCHITECTURE.md` §5–§7 and `docs/COST-MODEL.md`. Three different
problems, three different homes (ADR-0002).

| Piece | Choice | Reason |
|---|---|---|
| `apps/web` — dashboard, reconciliation, agency workspaces | **Vercel** | Low volume, latency-sensitive, cacheable. ~$70/mo Y1 → ~$320/mo Y3 including seats: a rounding error against total tech spend. Self-hosting Next.js on the collector boxes was considered and rejected — it trades preview deploys and instant rollbacks for ops work, the wrong economy for a three-person team at that price. |
| `apps/public` — free Grader | **Cloudflare Pages** | Static asset requests are free and unlimited. Vercel meters bandwidth ($0.15/GB past 1TB) and edge requests ($2/M past 10M) — on *acquisition* traffic, which is exactly the traffic you cannot forecast. It also isolates a tool that may get hammered from the paid product. |
| `services/collector` | **Vercel Fluid Compute + QStash → Hetzner CAX (ARM) at ~M18–M20** | Fluid Compute bills active CPU, not wall-clock — I/O wait is free — and optimized concurrency shares one instance across many in-flight invocations. That is precisely the shape of waiting 8s on an API, and at M12 the requirement is 1.3 req/s sustained. **The migration trigger is the rate budget, not cost.** One token bucket must span all collection under the provider's 15 req/s ceiling; on auto-scaling ephemeral instances that state cannot live locally, so every call takes a Redis round-trip. A fixed fleet gives each worker a static slice and the problem disappears. Because collection sits behind `EngineAdapter`, only the runner changes. |
| Postgres | **Supabase** | Score rows, aggregates, prompt banks, workspaces, accounts. Row-Level Security in the database is what makes R7 mechanically testable — tenancy enforced where the data is, not in application code an agency feature can route around. Moves to dedicated Postgres at ~150M score rows. |
| Raw payloads | **Cloudflare R2** | Zero egress is the whole point: the reconciliation and CBI work reads the corpus back repeatedly. $0.015/GB-mo, and batching writes one-object-per-cell costs ~4.1M Class A ops/month ($18) against 20.4M ($92) per-answer. R4 keeps these out of Postgres entirely. |
| Cache / queue / rate state | **Upstash Redis** | Cache index, rate budget, job state; usage-based pricing with no idle cost. Self-host at ~5M jobs/month. |
| Data source | **OpenWeb Ninja AI Answers** | All five surfaces on one key at $0.002/call at Mega marginal — roughly a 90% saving over direct integrations, and what makes statistically honest measurement viable at a $49 price point. The provider describes its **ChatGPT, Gemini and Copilot endpoints as unofficial**, powered by its own scraping infrastructure (ADR-0001), so `docs/METHODOLOGY.md` discloses all five surfaces as `third-party-grounded`. Contained behind `EngineAdapter` with a second provider stubbed, because provider risk here is concentrated. |
| Analytics corpus | **ClickHouse, deferred to ~M22** | Introduced when CBI index generation exceeds 60s (`ARCHITECTURE` §7). ~$480/mo — worth paying when the query pattern demands it, not before. Postgres carries it until then. |

---

## 4. Claude Code plugin and tooling decisions

Recorded because `docs/PLUGINS.md` makes the point that every installed plugin
costs context on every turn, and because an auditor will eventually ask what had
write access to this repository.

| Tool | State | Reason |
|---|---|---|
| **claude-mem** | Enabled, user scope | Cross-session memory over a 16-week build. Configured to hold decisions and rationale, not code — the eight rules are already permanent context; what memory is for is why an ADR went the way it did and what the pilot data showed. If memory and `CLAUDE.md` ever disagree, `CLAUDE.md` wins. |
| **ponytail** 4.8.4 | Enabled, user scope | Working-style harness. Affects how code is written, not what the project decides. |
| **taste-skill / design-taste-frontend** | **Removed** | Installed as a ~13-skill bundle when only `design-taste-frontend` was wanted. Deleted with explicit approval during the 2026-08-18 cleanup; no `skills-lock.json` and no skill files remain. There is currently **no frontend design plugin active on this project** — the official `frontend-design` plugin is installed at project scope for a different repository. **>>> CORRECTED 2026-08-24:** the sentence above was wrong in both halves and that is why this sat unused. `frontend-design@claude-plugins-official` was enabled at **user** scope, not project scope, and user scope covers this repo — so it was active here the whole time and simply never invoked. Enabled is not the same as used: it is a skill that has to be read. Both design plugins are now declared in the project's own `.claude/settings.json`, so the repo owns its tooling instead of inheriting it from one laptop. `.agents/skills/design-taste-frontend/` was deleted: Claude Code loads skills from `.claude/skills/`, so that path was never loadable and the skill had never run. |
| **Ruflo** | Plugin path only — **ADR-0004** | See below. |

**The Ruflo situation.** An earlier `npx ruflo init` — the CLI path — wrote
`.claude-flow/`, `.swarm/`, `.claude/helpers/`, roughly 60 agent/command/skill
folders under `.claude/`, settings entries, and a block in the global
`~/.claude/CLAUDE.md`. That is the specific failure mode `docs/PLUGINS.md`
warns about: **the CLI path writes its own `CLAUDE.md` over ours**, and this
project's `CLAUDE.md` is the single source of truth for eight rules that
protect real money and the product's core claim. The residue was removed on
2026-08-18; nothing tracked by git had changed.

The decision recorded in **ADR-0004**:

- **Plugin path only.** Ruflo is consumed through the plugin system
  (marketplace clone `fa13ee4`, 2026-08-15). `npx ruflo init` is never run
  against this repository.
- **Four plugins enabled** at project scope in `.claude/settings.json`:
  `ruflo-testgen`, `ruflo-browser`, `ruflo-adr`, `ruflo-metaharness`.
- **`ruflo-cost-tracker` is installed and permanently disabled** — not pending,
  not "later". It is the only one of the five that ships a hook, and that hook
  runs on `Stop` (every turn), reads the session transcripts under
  `~/.claude/projects/<cwd>/*.jsonl`, and writes a digest of them into a local
  memory store by spawning `npx -y @claude-flow/cli@latest memory store` — an
  unpinned package executed automatically, with no way to scope or review what
  is written. Cost visibility is already `cost-sentinel`'s job and
  `/cost-audit`'s, against actual provider invoices. Re-enabling it requires a
  new ADR that supersedes 0004.
- **`ruflo-swarm` is deferred to P4** (Week 8, the parallel parser build).
- **`ruflo-metaharness` informs, it does not gate.** Its 2026-08-18 run scored
  harnessFit 67 / toolSafety 100 / threat-model clean, but it does not read
  `.mcp.json` and reports `shellAccess: false` for a settings file that allows
  `Bash(pnpm *)`. Treated as a smoke test.

Zero Ruflo files exist in the repo beyond the versioned, reviewable
`enabledPlugins` and `extraKnownMarketplaces` entries in
`.claude/settings.json`. Baseline context after the cleanup, measured in a
fresh session: 38.2k tokens, of which the four enabled plugins cost ≈ 3k.

---

## 5. What's next, in order

Two tracks now, deliberately. The gate chain is unchanged and still governs what
counts as validated; alongside it a parallel fixture-and-free-tier track has run
ahead, on the explicit understanding that **none of it is gate-validated
progress**.

### The gate chain

**(a) Restore OpenWeb Ninja API access.** Atharva, on the provider dashboard.
Nothing downstream can start until the five surfaces stop returning 403. Two
preconditions at the same time: `.env.example` still needs its key rotated (it
was never committed — the only committed version has zero non-empty values — but
it sat in a non-ignored file), and `OPENWEBNINJA_PLAN` must be set explicitly,
since the pay-as-you-go default is the wrong rate at scale. Note the runner now
refuses to start without an explicit `--plan`.

**(b) Run the G0 pilot for real.** 100 prompts × 5 engines × 10 runs × 3 known
brands, **Day 1 and Day 2** — the second day is not optional, because without it
the design-effect and precision rows cannot be estimated and stay `NOT RUN`.
Hard cap $75 (the cap is per pilot; the runner subtracts what earlier days
spent). Then the analysis for $/answer at Mega marginal, p95 latency, ρ̂_u, DEFF
and n_eff per engine, and a pass/fail per engine. Runbook:
`services/collector/pilot/README.md`.

**(c) After G0 returns a verdict:** G1's pipeline criteria, which require 10,000
durably stored answers and a ≥ 90% cache hit rate on a repeat cycle and so
cannot be evaluated on fixtures at all. The code G1 tests already exists (1.1,
1.4, 1.5) — what is missing is real data flowing through it.

> **G1 also carries a hard tenancy prerequisite.** The deploy-time gate
> (`check-deploy.sql`) is partial and must be closed *before* G1, per ADR-0007 —
> not "before launch". PHASES.md's standing suite item 3 runs the RLS suite at
> every gate, and G1 is the first gate at which real collected rows exist to be
> isolated. The redesign is scoped in ADR-0007 §4 and its evidence is on
> `fix/tenancy-deploy-gate`; it is not an eighth patch round.

**(d) G2 — scoring correctness.** Needs the golden set populated to 300–500
hand-labelled answers, which needs real collected answers, which needs G0.

**(e) G3 — the public Grader**, including the category classifier, competitor
head-to-head and email gate that the current scaffold does not have.

### The parallel track, and what it is waiting on

**Free-tier credentials (Atharva).** R2 and Upstash accounts, so one signed
PUT/GET and one real QStash delivery can close the verification gap. Both
transports are currently pinned only by self-consistency: the three AWS SigV4
vectors are all bodyless GETs, so nothing independently verifies the actual
write path, and every "valid" QStash token in the tests is minted by our own
signer. Both fail *closed*, so the risk is silent inaction rather than
corruption — which is what the collection heartbeat now watches for.

**`p1/db-schema` → the tenancy mechanism, merged 2026-08-24 (ADR-0007).** The
`tenancy-auditor` pass on the JWT verifier returned a BLOCKER: the verifier was
an optional path around a GUC any role could set. Fixed in
`0002_tenancy_context.sql`, then re-audited six more times, every attempted
bypass blind. On `master`.

**The deploy-time tenancy gate — OPEN, deadline G1.** Not merged, not a
checklist, not deferred to "before launch". The redesign is decided: derive every
RLS-relevant object from Postgres's own catalog (`pg_class` across all relkinds,
`pg_inherits` for partitioning and legacy inheritance, views and their
`security_invoker` setting, real ownership via `relowner`) and require every
object *found* to prove coverage — no hand-written exemption or inclusion lists,
which are what missed the unanticipated arrangement seven times. Existing work
and all seven audit reports are preserved on `fix/tenancy-deploy-gate`
(`0003_tenancy_exposure_manifest.sql`, `deploy-check.test.ts`, 78 tests). Until
it lands, `master` has no complete deploy-time gate: a misconfiguration
introduced by a deploy-time `GRANT` will not be caught. See §2 and ADR-0007.

**Three provisional numbers, all awaiting G0 data**: the A–D confidence-grade
thresholds (blocked from live builds), `MIN_N_FOR_COMPARISON`, and the choice of
an overlap test for significance. None were replaced with a better guess, because
a second invented number would look more considered while being exactly as
unfounded.

**`COLLECTOR_TOPOLOGY` — decided 2026-08-22, ADR-0006 accepted.** Declaring
topology in deployment config is the mechanism; undeclared is refused rather than
defaulted. Extended at sign-off to `LocalRateBudget`, which had the same risk
shape and none of the guard. One thing stays deliberately open: deleting
`LocalSpendLedger` entirely and always using the shared ledger would remove the
guard, `resolveTopology` and the ADR along with it, and becomes available the
moment the free-tier Upstash credentials land.

**Sign-offs recorded 2026-08-22.** `budget.ts`, `rate-budget.ts` and `retry.ts`
accepted on their review history. `wilson.ts` accepted after a full read,
boundary special case included — 1,023 statsmodels reference vectors at three
alphas plus six property tests, and one documented assumption that outlives
them: it takes an *effective* n, and nothing measures the design effect until
G0. `format.ts` and `spend-ledger.ts` remain under review.

**Nothing past G0 counts as validated progress until G0 has a real pass/fail
result.** Everything above is infrastructure whose correctness is established
against fixtures; that is a different and much weaker claim than "the unit
economics hold". If measured $/answer lands materially above $0.002, or the
design effect makes the Starter unit's effective n useless, the pricing is
reworked before anything else is built. G0 exists to be able to fail.
