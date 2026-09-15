# ADR-0002 — Hosting topology and a phased collection runner

**Status:** Accepted · **Date:** 2026-08-18 · **Phase:** P0
**Supersedes:** the "ARM workers from day one" position in the Technology Stack &
Cost Roadmap document (v1.0, §3.3)

## Context

BlipRank has three workloads with three different profiles, and an earlier draft
collapsed them into one hosting answer.

1. **App tier** (`apps/web`) — low volume, latency-sensitive, cacheable.
2. **Public tier** (`apps/public`) — the Grader and satellite free tools. This is
   the acquisition engine: indexable, potentially spiky, and served largely from
   cache.
3. **Collection** — scheduled, bursty, IO-bound. 20.4M outbound calls/month at
   target, each waiting 2–20s, with near-zero CPU per call.

The original technology plan asserted that serverless was disqualified for
collection because wall-clock billing would charge for 45,300 GB-hours/month of
pure waiting. **That assertion under-weighted Vercel Fluid Compute**, which:

- bills **active CPU**, pausing while a function waits on I/O;
- uses **optimized concurrency**, running many invocations on one instance —
  precisely the right shape for network-bound work;
- allows **800s max duration** on Pro (1800s in beta for supported runtimes).

On the corrected reading, Vercel is a viable collection runner for a meaningful
part of the roadmap. At M12 the requirement is 1.3 req/s sustained.

## Decision

### Hosting split

| Piece | Host |
|---|---|
| `apps/web` | Vercel |
| `apps/public` (Grader, free tools) | Cloudflare Pages |
| `services/collector` | Vercel Fluid Compute + Upstash QStash → Hetzner CAX (ARM) |
| Postgres / raw payloads / cache | Supabase / Cloudflare R2 / Upstash |

The Grader goes to Cloudflare rather than Vercel because static asset requests are
free and unlimited there, whereas Vercel meters bandwidth ($0.15/GB past 1TB) and
edge requests ($2/M past 10M) — charges that would land on acquisition traffic. It
also isolates a publicly hammerable tool from the product paying customers use.

### The collection runner is phased

**P0–P3 (to ~M18): Vercel Fluid Compute + QStash.** Zero ops burden, adequate
throughput, and it lets a three-person team spend Weeks 2–5 on the measurement
core rather than on infrastructure.

**P4+ (~M18–M20): Hetzner CAX (ARM) worker fleet.**

**Migration trigger: sustained throughput crosses ~4 req/s.**

### Why the migration is necessary — and why it is not about cost

The binding constraint is the **global rate budget**. The provider ceiling is
15 req/s on the Mega tier, and a 12-hour collection window at target volume needs
15.8 req/s before any retry headroom. Staying under that requires one token bucket
across all collection, shardable across API keys.

With auto-scaling ephemeral instances that state cannot live locally. Every one of
20M monthly calls would need a distributed-limiter round-trip, and concurrency
stops being something you can reason about statically. A fixed worker fleet gives
each worker a deterministic slice of the budget and the problem dissolves.

Secondary reasons: a flat monthly line item suits a business whose margin thesis
depends on `/cost-audit` reconciliation, and persistent connection pooling across
hundreds of concurrent sockets is simpler on long-lived processes.

ARM specifically: after the June 2026 Hetzner revision the CAX line rose ~1.3–1.4x
against 2.4–2.75x for CPX and 2.1–2.73x for CCX. For IO-bound work it is now both
cheapest per concurrent socket and least price-volatile.

## Consequences

**Positive.** Weeks 2–5 go to the measurement core instead of infrastructure. The
`EngineAdapter` boundary (ADR-0001) means only the **runner** changes at migration
— adapters, normalisation, cache lookup, retry policy and rate-budget logic are all
portable. Hosting cost stays trivial (~$70/mo Y1) while the product is unproven.

**Negative.** A migration is scheduled work in P4/P5 rather than avoided. The rate
budget must be implemented as a pluggable interface on both runners from day one,
or the migration becomes a rewrite. Two runners means the collector must be
tested under both execution models.

**Rejected alternative.** Self-hosting Next.js on the same Hetzner boxes as the
collectors — one vendor, flat cost, no bandwidth metering. Rejected because it
trades preview deployments, instant rollbacks and zero-config Next.js for ops work,
which is the wrong economy at ~$320/mo with a three-person team.

## Follow-ups

- Region selection is deliberate, not default. Beachhead is India and GCC, then
  UK/EU; US-East by default penalises the primary market on every dashboard load.
- DPA in place before the first EU customer.
- The rate-budget module ships behind an interface in P1, exercised on the Vercel
  runner, so the P4 migration is a swap and not a rebuild.

---

## Amendment 1 — `apps/public` deploys to Vercel for the MVP

**Status:** Accepted (owner decision D1, `docs/MVP_PLAN.md` B1) · **Date:** 2026-09-10 · **Phase:** P3

### What changed since the decision

When this ADR placed `apps/public` on Cloudflare Pages it was a static Grader
with no server. Since then it grew eight route handlers — `/api/scan` (SSE,
ADR-0013), `/api/preview`, `/api/answers` (ADR-0011), `/api/cycles`,
`/api/gaps` (ADR-0014), `/api/category`, `/api/competitors`,
`/api/custom-prompts` (ADR-0016) — each marked "LOCAL DEMO ONLY" because the
static deployment had none of them. PRODUCT_GOAL points 1 and 6 need those
routes on a real host, and ADR-0017/0018's daily loop needs a function host
the scheduler can call. The routes are Node code: `node:fs`, `node:dns` address
pinning and undici agents in `fetch-site.ts`, PGlite in tests. Cloudflare Pages
runs Next.js only through a workers adapter, and that runtime does not run this
code.

### Decision

`apps/public` deploys to **Vercel** as one project with root directory
`apps/public`. This was already done once as an interim step: project
`bliprank-public`, 2026-08-26 (`docs/PROGRESS.md`, "First Vercel
deployment"), recorded then as "a conscious interim deviation" from this
ADR. Owner decision D1 makes it the decision. Cloudflare keeps R2 (raw
answers, R4) and nothing else in this
app's path. The original reasoning — free static requests, isolation of a
hammerable tool from the paid product — is not wrong; it is deferred until the
Grader's acquisition traffic is measurable, at which point the bandwidth line
on the Vercel invoice decides whether a CDN goes back in front.

### Provider facts this rests on (Vercel docs, fetched 2026-09-10)

| Fact | Source, last updated |
|---|---|
| Fluid compute is on by default; duration limits are **Hobby 300s default and maximum; Pro/Enterprise 300s default, 800s maximum** (1800s beta, per-function only). "For request handlers, this includes time spent processing the request and sending the response, including streamed responses." | `/docs/functions/limitations`, 2026-08-24 |
| For Next.js ≥ 13.5 App Router the duration is set **in the route file**: `export const maxDuration = N`. `vercel.json`'s `functions` block is the form for other runtimes and project-wide defaults. | `/docs/functions/configuring-functions/duration`, 2026-08-24 |
| Supported pnpm versions are **6–10**. With Corepack, Vercel uses the `packageManager` field instead; Corepack is enabled by the project environment variable `ENABLE_EXPERIMENTAL_COREPACK=1`. | `/docs/package-managers`, 2026-08-11; `/docs/builds/configure-a-build`, 2026-08-28 |
| A project root directory cannot reach files above it with `..`. Monorepo builds detect the workspace from the lockfile at the repository root. | `/docs/builds/configure-a-build`, 2026-08-28; `/docs/monorepos`, 2026-08-11 |

Consequences of those facts, as built:

- **Every route file carries its own `maxDuration`.** `/api/scan` keeps 300s
  (the whole SSE stream; Hobby maximum and Pro default, so no dashboard change
  on either plan; G3's p95 ≤ 90s sits inside it). `/api/preview` keeps 60s.
  The five reading routes are pinned at 30s and `/api/gaps` at 60s: ceilings
  on runaway cost, not needs. `apps/public/vercel.json` pins `framework` and
  the schema and sets no duration, so nothing in it can shadow a route's own
  value.
- **Deploy prerequisites, set on the Vercel project by the owner:**
  `ENABLE_EXPERIMENTAL_COREPACK=1` (this repo pins pnpm 11.5.2, above the
  supported range, through `packageManager`), and `TRUSTED_PROXY=vercel` so
  the visitor throttle reads `x-vercel-forwarded-for` (MVP_PLAN A1). Nothing
  else: no provider key, no `COLLECTION_ENABLED`, no `GRADER_LIVE_SCAN`.
- **The relative imports build.** The routes import `services/grader/src` by
  relative path, above the root directory, and `apps/public/package.json` does
  not declare it. The 2026-08-26 deployment built and served those routes
  (they refused honestly, as designed), so Vercel's workspace install plus
  Next's file tracing do carry the files. Since B2 the app also imports
  `@bliprank/db`, declared like the other workspace packages.
- **⚠️ One unverified fact.** That deployment ran under the pnpm the lockfile
  then implied; the repo has since pinned pnpm 11.5.2, above Vercel's
  supported 6–10, so the next deploy is the first with Corepack. If the
  install fails, the fallback is an `installCommand` in `vercel.json` that
  enables Corepack explicitly, not a downgrade of the pin.

### What this amendment does not do

It makes the routes **deployable, not useful**. Their store is still
`services/grader/data-live` on one machine's disk (ADR-0017 "A local file
store"). On the deployment that directory does not exist and the function's
filesystem is not writable, so every reading route answers 404 ("not on this
deployment", which the client already renders as a fact about the deployment,
not the scan), and `/api/scan` refuses before it could write because
`GRADER_LIVE_SCAN` is unset there. MVP_PLAN B3 moves the store to Postgres
and R2; B2 puts an identity in front of it. Until B3 lands, the deployment is
the reference scan plus the free preview.

### Superseded text

The hosting table's `apps/public → Cloudflare Pages` row and the paragraph
"The Grader goes to Cloudflare rather than Vercel because…" describe the
2026-08-18 decision and stay as its record. `CLAUDE.md` §6.1,
`docs/ARCHITECTURE.md` §6.5, `docs/COST-MODEL.md` and `README.md` carry the
current row.

## Amendment 2 — one store per deployment: the session's workspace, and the ledgers beside it

**Status:** Accepted (`docs/MVP_PLAN.md` B3b) · **Date:** 2026-09-15 · **Phase:** P3

### The decision

A deployment of `apps/public` has exactly one workspace store and one place
its ledgers live, and both are decided by configuration, never by fallback:

| Configuration | Workspace state | Ledgers | Who |
|---|---|---|---|
| Identity configured (the eight variables of CLAUDE.md §7) | Postgres, through a workspace token the server mints for the signed-in account's one workspace (`sessionWorkspaceStore`: one `withWorkspace` transaction per call) | Upstash, when the six answer-store variables are set (`ledgerStores`) | the verified session |
| Identity off, one machine | this machine's `services/grader/data-live` files (`fileWorkspaceStore`) | this machine's files | the machine |
| Identity off, a fleet runtime (`VERCEL` and the other markers `detectMultiInstanceRuntime` reads) | **refused** (503) | **refused** | nobody |
| Ledgers on a fleet with no Upstash | — | **refused** at `ledgerStores` | — |

Every route that reads or writes a cycle, a record, an override, a prompt set
or a request (`/api/cycles`, `/api/answers`, `/api/gaps`, `/api/category`,
`/api/competitors`, `/api/custom-prompts`, `/api/scan`, `/api/preview`)
opens `workspaceAccess()` first and uses only what it returns. The workspace
is derived from the session and from nothing else: a body or query field that
names a workspace or an account is a field nothing reads. An account with no
workspace is told to create one; an account with several (an agency) is
refused until Stage D1 builds the portfolio, rather than silently given one.

### Consequences

* **On the deployment the Grader needs a sign-in.** The free preview and
  scan of the reference deployment wrote and read one machine's disk; with
  identity on they write and read the session's workspace, and without a
  session they answer 401. A public, anonymous preview is a product decision
  for Stage D, not something this amendment quietly keeps.
* **`GRADER_DATA_DIR` must be writable on the function host** (`/tmp/grader`
  on Vercel): the runner still writes `latest.json`, `run.lock` and its
  dead-letter file there, and the bank author writes generated banks there.
  Generated banks on a deployment are therefore per instance until they move
  to the database (not in scope here; `prompt_banks` exists for it).
* **The count ledgers are documents under a lock** (`ledger-doc.ts`: a
  `setnx` key with a short TTL on KV, the process on a file); the dollar caps
  are the collector's atomic `KvSpendLedger` on KV and `Budget` on a file,
  with the per-run allowance of ADR-0017 kept on both (`withRunAllowance`).
* **The file store and the Postgres store are never authoritative at once.**
  Their version sequences are independent, so a correction applied through
  one is invisible to the other's write-once check (the 0004 audit, Q6). The
  CLIs stay on the file store for the machine they run on.
* The document writer takes an expected version (`ws_put_document(…,
  p_expect_version)`), so a first decision is written once under the
  workspace lock and a correction never lands on a version it did not read:
  the upgrade path the resolver's own file-lock note named.
