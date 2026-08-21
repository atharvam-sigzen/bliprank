# BlipRank — Progress Record

**As of:** 2026-08-21 · **master:** `27652c2` · **First commit:** 2026-08-18 · **Tests:** 156 passing, 11 files, all offline

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

| Engine | Attempts | Charged (payg) |
|---|---|---|
| chatgpt | 130 | $0.910 |
| gemini | 130 | $0.910 |
| copilot | 130 | $0.910 |
| google-ai-mode | 130 | $1.040 |
| google-ai-overviews | 76 | $0.380 |
| **Total** | **596** | **$4.150** |

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

| # | Item | Status |
|---|---|---|
| 1.1 | QStash production runner | **Not started.** The orchestrator it will call now exists. |
| 1.2 | OpenWeb Ninja adapter + fixtures | **Done** — five surfaces, `--doctor` probe, citation metadata preserved (ADR-0005). |
| 1.3 | Second provider stubbed | **Done** (`f111d5e`). `stubsearch` speaks a deliberately different dialect (HTML body, rank-ordered sources, v2 envelope) and passes the same conformance suite as the real adapter. This is the proof ADR-0001 §2 demands: the abstraction is exercised, not asserted. |
| 1.4 | Cache key + Redis index, shared prompt-pool dedupe | **Done** (`52cac9a`, `d6528e4`, `4d3a5a1`, `27652c2`). `AnswerIndex` over an injectable KV (memory + Upstash REST), atomic per-cell claim so 15 agency clients on one category cause one collection. Now wired into a `CollectionOrchestrator` — the cache-check → collect-on-miss → single-blob-write funnel that P1.1 will call. |
| 1.5 | R2 storage, one object per cell | **Interface done, transport not.** `BlobStore` + `MemoryBlobStore` are real; `R2BlobStore` is a single well-marked stub that throws — SigV4 signing is the outstanding work. Kept as an obvious stub rather than a half-signed client that looks finished. |
| 1.6 | Rate-limit budget manager | **Done** (`a392f95`). `RateBudget` interface with `LocalRateBudget` (continuous token buckets, key sharding, UTC window, injectable clock) behind it. The interface is the point: it is what makes the P5 Vercel → Hetzner migration a swap rather than a rewrite. |
| 1.7 | `packages/db` schema + RLS | **Built on branch `p1/db-schema`, not merged.** See below. |

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

**`p1/db-schema` (branch `18cde63`, not merged).** 821 insertions across
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

**Two decisions remain open for a human** and are why this branch is not
merged:

1. `set_workspace()` performs no principal → workspace binding. The web app is
   currently the authorization boundary. Whether to add database-level identity
   (a JWT claim) before launch is a deliberate architectural choice, not a bug.
2. The entitlement business rule — how `svc_onboard` authorizes a brand add,
   and where the billing hook sits.

⚠️ **HUMAN REVIEW REQUIRED** stands on `p1/db-schema` (tenancy model) and on
`27652c2` (ADR-0003 R2 object identity + the `EngineAdapter` contract).

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

This is a dependency chain, not a list of parallel tracks.

**(a) Restore OpenWeb Ninja API access.** Atharva, on the provider dashboard.
Nothing downstream can start until the five surfaces stop returning 403.
Two preconditions to clear at the same time: `.env.example` currently holds a
live-looking API key in the working tree (unstaged, not gitignored) — it needs
rotating and blanking before any broad `git add`; and `OPENWEBNINJA_PLAN` must
be set explicitly, since the pay-as-you-go default is the wrong rate at scale.

**(b) Run the G0 pilot for real.** 100 prompts × 5 engines × 10 runs × 3 known
brands, **Day 1 and Day 2** — the second day is not optional, because without
it the design-effect and precision rows cannot be estimated and stay `NOT RUN`.
Hard cap $75, collection enabled deliberately for the duration of the run and
switched back off afterwards. Then run the analysis for $/answer at Mega
marginal, p95 latency, ρ̂_u, DEFF and n_eff per engine, and a pass/fail per
engine. The runbook is `services/collector/pilot/README.md`.

**(c) Only after G0 returns a real verdict:** resume non-fixture P1 work — the
QStash production runner (1.1) calling the existing orchestrator, and the R2
SigV4 transport (1.5) — then G1's pipeline criteria, which require 10,000
durably stored answers and a ≥ 90% cache hit rate on a repeat cycle and
therefore cannot be evaluated on fixtures at all.

**(d) P2 — scoring**, including the new citation source classifier (2.1b,
ADR-0005) and its G2 criterion of ≥ 97% agreement with human labels and 0%
silently bucketed as `owned`.

**(e) P3 — the public Grader.**

**Nothing past G0 counts as validated progress until G0 has a real pass/fail
result.** Everything built so far is infrastructure whose correctness is
established against fixtures; that is a different and much weaker claim than
"the unit economics hold". If measured $/answer lands materially above $0.002,
or the design effect makes the Starter unit's effective n useless, the pricing
is reworked before anything else is built. G0 exists to be able to fail.
