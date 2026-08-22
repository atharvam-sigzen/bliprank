# BlipRank — Progress Record

**As of:** 2026-08-22 · **master:** `af9fa1a` · **First commit:** 2026-08-18 · **Tests:** 377 passing, 21 files, all offline

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
| 1.7 | `packages/db` schema + RLS                         | **Done** (`af9fa1a`). Merged 2026-08-22 after the three open decisions were taken. See below.                                                                                                                                                                                                                                                                         |     |

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

**Accepted consequence, recorded rather than discovered later:** the tenant read
path is now a write path. `set_workspace_jwt()` INSERTs, so it fails under
`default_transaction_read_only`, and the context table is `UNLOGGED` and so does
not exist on a physical standby. **Supabase read replicas are unavailable to
`apps/web` while the context lives here.** Every tenant request also consumes an
XID. This is the price of the mechanism being sound and is not negotiable
downward — relaxing the write is what would put the context back somewhere the
tenant can reach. If replicas become necessary that is an ADR, and the only
shape that avoids the write puts an HMAC inside every RLS policy evaluation.

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
| 2.1 | Deterministic scorer | **Done, fixture-only.** No model call on any path (R1). URL masking so a brand appearing only in a link is cited but not *mentioned*; `position` is a rank among detected brands, not a character offset; explicit letter/digit/underscore boundaries rather than ``, which does not fire around `+` or `.`. A test pins that a score row carries **no** interval — one answer is one Bernoulli trial. |
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

**`27652c2` — signed off 2026-08-22.** The R2 object identity change is now
recorded formally as **ADR-0003 Amendment 1**, and CLAUDE.md R4's shorthand was
corrected to match. The flag is closed.

⚠️ **HUMAN REVIEW REQUIRED** stands on the JWT verifier merged with
`p1/db-schema` — see above.

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
| **taste-skill / design-taste-frontend** | **Removed** | Installed as a ~13-skill bundle when only `design-taste-frontend` was wanted. Deleted with explicit approval during the 2026-08-18 cleanup; no `skills-lock.json` and no skill files remain. There is currently **no frontend design plugin active on this project** — the official `frontend-design` plugin is installed at project scope for a different repository. Re-adding one is a P3 decision, when there is UI to design. |
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

**`p1/db-schema` — merged 2026-08-22, then repaired the same day.** The
`tenancy-auditor` pass on the JWT verifier returned a BLOCKER: the verifier was
an optional path around a GUC any role could set. See the incident note in §2.
Fixed in `0002_tenancy_context.sql` and re-audited.

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
