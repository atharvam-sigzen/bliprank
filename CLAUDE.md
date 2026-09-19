> **First, read `docs/PRODUCT_GOAL.md`.** It is the canonical eleven-point product goal every session measures its work against. Do not restate it; cite it by point number.

# BlipRank — CLAUDE.md

> **Read this fully before your first tool call in a new session.**
> This file is loaded into context on every turn. It is deliberately short.
> Detail lives in `docs/` and `.claude/skills/` and is loaded on demand.

---

## 1. What BlipRank is

BlipRank (bliprank.com) is an **AI Search Visibility Assurance** platform.

We measure how brands appear inside AI answers — ChatGPT, Google Gemini, Microsoft
Copilot, Google AI Mode, Google AI Overviews — and we do it to a standard that
survives audit.

**The category has ~72 competing tools. Our entire differentiation is that our
numbers can be reproduced and reconciled. Everything in this codebase serves that.**

Three product pillars:

| Pillar                        | What it means in code                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Measurement integrity**     | Every metric ships with a Wilson 95% CI, a disclosed sample size `n`, and a versioned scoring algorithm ID. Never a bare point estimate.                 |
| **Cross-tool reconciliation** | We ingest competitors' exports (Peec, Profound, Semrush, Ahrefs, Otterly, AthenaHQ) and explain *why* their number differs from ours. This is the wedge. |
| **Causal proof**              | Holdout-based experiments with difference-in-differences, not correlation dressed up as causation.                                                       |

If a change makes a number less reproducible, it is the wrong change — even if it
is faster, cheaper, or prettier.

---

## 2. Architecture in one page

This is **not a normal SaaS**. It is a batch data factory with a thin web app
attached. Getting this mental model right prevents the two expensive mistakes.

```
                        ┌──────────────────────────────┐
   scheduled  ────────► │  services/collector          │  IO-bound, long-running
   (12h window)         │  Engine Adapter → OpenWeb    │  ARM workers, 200–400
                        │  Ninja (5 answer surfaces)   │  concurrent sockets
                        └──────────────┬───────────────┘
                                       │ raw payload
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
        ┌───────────────────────┐              ┌──────────────────────┐
        │  Cloudflare R2        │              │  services/scorer     │
        │  raw answers, batched │              │  1. deterministic    │  ← 90% of work
        │  1 obj / cell (prompt │              │  2. sampled LLM      │  ← 25% sample,
        │  × engine × locale ×  │              │     sentiment        │    NOT BUILT yet
        │  geo × day, ADR-0003) │              │                      │
        └───────────────────────┘              └──────────┬───────────┘
                                                          │ score rows
                                                          ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  Postgres (Supabase)  — partitioned, versioned, RLS-isolated     │
   │  score_rows │ aggregates │ prompt_banks │ workspaces │ accounts  │
   └───────────────────────────┬──────────────────────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              ▼                                 ▼
   ┌────────────────────┐          ┌──────────────────────────┐
   │ apps/web (Next.js) │          │ apps/public (Grader +    │
   │ NOT CREATED YET;P4 │          │ workspace record)        │
   │ dashboards, recon  │          │ free tool, cache-served  │
   └────────────────────┘          └──────────────────────────┘
```

Full detail: `docs/ARCHITECTURE.md`. Read it when touching anything structural.

### Repository map

```
apps/web              (not created yet; P4) Next.js paid product per ADR-0002
apps/public           Grader + workspace record + free tools (separate deploy)
services/collector    Engine Adapters, orchestrator, spend + rate budgets, QStash runner
services/grader       Scan runner, category resolver, cycles, gates, daily loop, CLIs
services/scorer       Deterministic pass, versioned (the sampled sentiment pass is NOT built)
services/reconcile    (not created yet; P4) competitor export parsers, variance decomposition
packages/stats        Wilson, DiD, sampling. Pure functions. HUMAN-OWNED.
packages/taxonomy     Categories, prompt banks, content classifier, publisher registry
packages/db           Drizzle schema, migrations, RLS policies, partitions
packages/contracts    Shared types + the Engine Adapter interface
docs/                 ARCHITECTURE.md, PHASES.md, METHODOLOGY.md, PRODUCT_GOAL.md, MVP_PLAN.md, adr/, runbooks/
```

---

## 3. Non-negotiable rules

These are not style preferences. Breaking any one of them costs real money or
breaks the product promise.

### R1 — Scoring is deterministic first
Brand mention, citation, position and competitor detection use **alias tables and
string/URL matching**, never an LLM. Only sentiment/framing may call a model, and
only on a **25% sample** of runs, flagged as sampled in the output.

*Why:* an LLM call on every answer costs **10.5×** more ($1.69M/year at target
scale) **and** makes the number non-reproducible, which destroys the product claim.
The cheap architecture and the honest architecture are the same architecture.

### R2 — All model calls that can batch, must batch
Scoring is not latency-sensitive. Use the Batch API (50% off) with a 1-hour prompt
cache on the scoring rubric (cache reads are 0.1× base input). Never bypass this
for convenience during development — use fixtures instead.

### R3 — Nothing spends money outside the scheduler
No script, test, or dev session may issue collection calls except through
`services/collector` with an explicit budget. A retry bug at production volume is
a five-figure invoice before anyone notices. The `pre-spend` hook enforces this.

### R4 — Raw payloads never go in Postgres
R2 for raw answers, Postgres for extracted/scored rows, columnar for aggregates.
Batch R2 writes: one object per cell **per collection path** (`prompt × engine ×
locale × geo × day`, i.e. per cache key, qualified by the adapter that fetched it —
see ADR-0003 Amendment 1), not per answer.

### R5 — Score rows are immutable and version-stamped
Never mutate a historical score. When the algorithm changes, bump the version,
write new rows, and add a changelog entry. Competitors silently rebase history;
we do not. `/score-version` handles this — use it.

**The one exception, and its bar (ADR-0012).** A rule change may ship under the
current version only when BOTH hold: (1) a **full-corpus check** — every stored
answer scored under both rule sets, not a sample — shows zero differing rows;
and (2) a **structural argument** shows no existing or future record could ever
reach the differing case under the old rules. Both go in an ADR, and the
changelog names it. Anything less defaults to bumping. There are no other
exceptions, and "the difference is small" is not one.

### R6 — The cache key is sacred
`hash(normalised_prompt, engine, locale, geo, date_bucket)` is the primary key of
the answer store and the Redis lookup key. It is simultaneously the margin lever,
the benchmark corpus and the moat. Do not change its shape without an ADR.

### R7 — Tenancy is verified mechanically
Every change to `packages/db` triggers the RLS policy test suite. An agency leaking
one client's data into another's workspace is an extinction-level event for a
trust-positioned product.

### R8 — No metric without its interval
A number rendered in the UI or returned by the API must carry `{value, ci_low,
ci_high, n, algo_version, collection_path}`. Provenance travels with the number,
not only in a methodology page the customer may never open. If a week-on-week
movement falls inside the CI, the UI says **"no significant change"** — it does
not draw a green arrow.

---

## 4. What you own vs what a human owns

| You may write autonomously | You assist, a human owns |
|---|---|
| CRUD, dashboards, forms, tables, settings | `packages/stats` — every statistical method |
| Engine adapters *against the existing contract* | The scoring algorithm and its rule set |
| Competitor CSV parsers + fixtures | RLS policies and the tenancy model |
| Tests, migrations, docs, seed data | Rate-limit, retry and spend-control logic |
| Content-generation prompts (flag for review) | Anything in `docs/METHODOLOGY.md` |

When a task touches a human-owned area: **write the code, then stop and say so
explicitly.** Do not merge, do not mark the task complete. Say
`⚠️ HUMAN REVIEW REQUIRED: <area> — <what to check>`.

---

## 5. Workflow

1. **Plan before building.** For anything spanning more than two files, enter plan
   mode and get the plan agreed first.
2. **Read the phase.** `docs/PHASES.md` defines what is in scope right now. Work
   outside the current phase needs an explicit instruction.
3. **Test at the gate, not at the end.** Each phase has an exit gate with
   executable checks. `/gate-check` runs them.
4. **One ADR per structural decision.** `docs/adr/`. If you are choosing between
   two approaches that are hard to reverse, write the ADR before the code.
5. **Cost is a review criterion.** Every PR gets checked for per-row API calls,
   missing cache lookups, and absent batch flags. `/cost-audit` weekly.

### Commands

| Command | Use |
|---|---|
| `/new-engine-adapter` | Scaffold a new answer-surface adapter against the contract |
| `/reconcile-parser` | Turn a competitor export sample into a parser + fixtures |
| `/category-bank` | Generate a prompt bank + competitor set for a new category |
| `/score-version` | Bump scoring version, changelog, golden-set diff report |
| `/gate-check` | Run the current phase's exit gate |
| `/cost-audit` | Reconcile projected vs actual spend across all providers |
| `/cbi-publish` | Build a Category Benchmark Index from the corpus |
| `/backfill` | Plan a corpus backfill with cost estimate + approval gate |

### Subagents

`measurement-engineer` · `stats-reviewer` · `cost-sentinel` · `tenancy-auditor` ·
`reconciliation-builder` · `frontend-designer`

Delegate rather than doing everything inline. `stats-reviewer`, `cost-sentinel`
and `tenancy-auditor` must be invoked on any PR touching their domain.

---

## 6. Stack

- **Web**: Next.js 15 (App Router); charts are hand-rolled SVG/CSS in `apps/public/components` (no chart library, no shadcn/Tailwind in `apps/public` today)
- **Data**: Supabase Postgres + Drizzle · Cloudflare R2 · Upstash Redis · ClickHouse (from ~M22)
- **Collection runner**: phased — see §6.1. Vercel Fluid Compute + QStash until ~M18, then Hetzner CAX (ARM) workers.
- **Models**: Haiku 4.5 (scoring, batch+cache) · Sonnet 5 (customer-facing generation)
- **Orchestration**: Upstash QStash → self-hosted; n8n for integrations only, never the core loop
- **Billing**: Stripe (intl) + Razorpay (India, GST) behind one internal abstraction
- **Obs**: Sentry · Better Stack · PostHog

Data provider: **OpenWeb Ninja** AI Answers API — five surfaces, one key,
$0.002/call at Mega tier, 15 req/s ceiling. Always behind `EngineAdapter`; never
call it directly from application code.

---

### 6.1 Hosting topology

Three different problems, three different homes. See `docs/adr/0002-hosting-topology.md`.

| Piece | Host | Why |
|---|---|---|
| `apps/web` — dashboard, reconciliation, agency workspaces | **Vercel** | Low volume, latency-sensitive, cacheable. Cheap: ~$70/mo Y1, ~$320/mo Y3. |
| `apps/public` — Grader + workspace record + free tools | **Vercel** (ADR-0002 Amendment 1, 2026-09-10) | Eight route handlers need a Node function host; Cloudflare Pages runs Next.js only through a workers adapter the grader's Node code does not run on. Bandwidth metering on acquisition traffic is re-assessed when that traffic is measurable. Deploy needs `ENABLE_EXPERIMENTAL_COREPACK=1` (pnpm 11) and `TRUSTED_PROXY=vercel`. |
| `services/collector` | **Vercel Fluid Compute + QStash → Hetzner CAX (ARM)** | Phased. See below. |
| Postgres / R2 / Redis | Supabase / Cloudflare / Upstash | Unchanged. |

**The collection runner is phased, and this is deliberate.**

Fluid Compute bills *active CPU*, not wall-clock — I/O wait is free — and optimized
concurrency lets many invocations share one instance. That is exactly the shape of
waiting 8s on an API. Pro allows 800s max duration (1800s in beta). So Vercel
genuinely works for collection through P3, and standing up a worker fleet in Week 2
is premature optimisation for a three-person team.

**Migrate when sustained throughput crosses ~4 req/s (~M18–M20).** The trigger is
not cost — it is the **global rate budget**. You need one token bucket across all
collection, under the 15 req/s provider ceiling, shardable across API keys. With
auto-scaling ephemeral instances that state cannot live locally, so every one of
20M monthly calls takes a Redis round-trip and concurrency stops being reasonable
about. A fixed worker fleet gives each worker a static slice of the budget and the
problem disappears.

Because collection sits behind `EngineAdapter`, only the **runner** changes on
migration — the logic is portable. That is most of what the abstraction is for.

**Region:** pick deliberately. Selling into India, GCC and UK/EU — default US-East
adds latency to every dashboard load in the beachhead market. Get a DPA in place
before the first EU customer.

---

## 7. Environment

Never commit secrets. Required in `.env.local`:

```
OPENWEBNINJA_API_KEY=
ANTHROPIC_API_KEY=
DATABASE_URL=
R2_ACCOUNT_ID= R2_ACCESS_KEY_ID= R2_SECRET_ACCESS_KEY= R2_BUCKET=
UPSTASH_REDIS_REST_URL= UPSTASH_REDIS_REST_TOKEN=   # all six or none; with all six the ledgers live in Upstash too (ADR-0002 Amendment 2)
GRADER_DATA_DIR=                   # the grader's writable directory; unset = services/grader/data-live. On a function host set it to a writable path (/tmp/grader)
STRIPE_SECRET_KEY= RAZORPAY_KEY_ID= RAZORPAY_KEY_SECRET=
COLLECTION_BUDGET_USD_DAILY=      # hard daily ceiling, read by the daily loop (ADR-0017); a live tick refuses without it
COLLECTION_ENABLED=                # see below: ON in agent sessions by decision, OFF everywhere else
TRUSTED_PROXY=                     # cloudflare | vercel. Names the edge whose client-IP header the visitor throttle may read; unset = no header is trusted, every caller is one bucket
COLLECTOR_TOPOLOGY=                # single-process | fleet (ADR-0006). A machine running the Grader over its own data directory declares single-process, or the file ledgers are refused (B3c item 4); a fleet declares fleet (a Vercel marker implies it) and sets the six answer-store variables so the ledgers live in Upstash. The CLIs declare single-process for themselves when nothing is declared; a route never does
```

**Identity (MVP_PLAN B2, migration 0003).** All seven or none: with any
missing, identity is OFF — the sign-in routes answer 503 with one fixed
sentence naming nothing, the middleware passes every request through, and
the Grader, the record and every test run exactly as before. The web tier
holds ONE database credential, the tenant login role (a member of `app_rw`
and nothing else); onboarding writes go through the three definer functions
of migration 0003, never a second DSN.

```
SUPABASE_URL=                      # the project URL
SUPABASE_PUBLISHABLE_KEY=          # the publishable (anon) key; never the service key
DATABASE_URL=                      # the app_rw login role's DSN, through Supabase's transaction pooler
AUTH_SIGNING_KID=                  # a live row of auth_signing_keys
AUTH_SIGNING_SECRET=               # that row's secret; the server mints workspace tokens with it, the database verifies them
AUTH_ISSUER= AUTH_AUDIENCE=        # must equal that row's issuer and audience (migration 0002 binds them to the key)
SITE_URL=                          # this deployment's own origin; the magic link's return URL and every redirect are built on it, never on a request header
```

Deploy prerequisites on the Supabase side, owner's steps: the magic-link
email template must link to `/auth/confirm?token_hash={{ .TokenHash }}&type=email`
(the default template sends a browser-only fragment a server never sees),
and `<site>/auth/confirm` must be an allowed redirect URL.

**The prompt-bank author** (ADR-0009 Amendment 1). Optional: with no key it is
off, and a domain in no known category falls back to the general bank exactly as
it did before authoring existed. Everything here is an env edit on purpose —
these are free tiers, and swapping a rate-limited one must not be a deploy.

```
OPENROUTER_API_KEY=               # or BANK_AUTHOR_API_KEY. Absent = authoring off.
BANK_AUTHOR_MODEL=                # default nvidia/nemotron-3-super-120b-a12b:free
BANK_AUTHOR_FALLBACK_MODEL=       # default minimax/minimax-m3:free; '' disables
BANK_AUTHOR_PROVIDER=             # openai-compatible (default) | anthropic
BANK_AUTHOR_BASE_URL=             # default https://openrouter.ai/api/v1
BANK_AUTHOR_TIMEOUT_MS=           # default 25000, per attempt
BANK_AUTHOR_CAP_USD=              # default 5. Every model attempt is charged to <data>/bank-author-ledger.json BEFORE it is made (R3)
BANK_AUTHOR_USD_PER_CALL=         # default 0 for :free slugs (the ledger still counts attempts). A model or fallback that is not :free is REFUSED at configuration until this is set (R3).
```

**The daily tick's transport (ADR-0018, MVP_PLAN C2).** QStash calls
`/api/tick` once a day; the route verifies the `Upstash-Signature` before it
reads anything, then runs the loop's two jobs (the fan-out, and one domain job
per due domain). Without the two signing keys and `SITE_URL` the route answers
503 and reads nothing; without `QSTASH_TOKEN` a fan-out is 503. The token is
read from the process environment only, never from a dotenv file: whoever
holds it can make an armed deployment run daily.

```
QSTASH_TOKEN=                      # the fan-out publishes domain jobs with it; pnpm grader:schedule registers with it. Shell only.
QSTASH_CURRENT_SIGNING_KEY=        # the route verifies deliveries with these two; both are accepted during a key roll
QSTASH_NEXT_SIGNING_KEY=
GRADER_TICK_CRON=                  # optional, default "15 6 * * *" (UTC; a CRON_TZ= prefix is refused, the day is UTC)
GRADER_DAILY_LOOP=                 # armed = live; fixture = offline, honoured only with identity off; anything else = every verified job answers "not armed" and does nothing
GRADER_MAX_TRACKED_PER_WORKSPACE=  # optional, default 3: the hosts one workspace may re-check daily through POST /api/tracked, until D2 gates the count by plan (C3). A value that is not a positive integer keeps the default. The machine's track command does not read it.
```

`SITE_URL` is the destination (`${SITE_URL}/api/tick`), so the URL QStash signs
is the one the route verifies against. **Two acts, both the owner's, neither a
session's:** `pnpm grader:schedule -- --register` from a shell holding the
token (the pre-spend hook blocks `--register` and `--resume` in a session), and
`GRADER_DAILY_LOOP=armed` on the deployment. Registering alone spends nothing:
every delivery is answered "not armed" until the variable is set. The
deployment's tracked list is the `tracked.json` ledger document in Upstash; its
write path is `POST /api/tracked` (C3), session-derived and wired to no surface
on a deployment yet, so a fan-out there still finds nobody tracked.

**⚠️ Whichever model answers, the competitor rule holds.** It is not the schema:
`parseCandidate` reads three keys and ignores every other one, `leaders: []` is
constructed in our code, and a stored bank that has acquired leaders is dropped
on read. A model that names rivals is not an error, it is a field nothing reads.

**`COLLECTION_ENABLED` is ON in every agent session, by decision.**
`.claude/settings.json` injects `COLLECTION_ENABLED=true` into every process a
Claude Code session spawns. That is deliberate, not an oversight: set by the
owner in `ca48704` (2026-08-25) so live Grader scans work from a dev session,
and reaffirmed on 2026-09-07 after the closure sweep raised it. Outside an
agent session (a plain shell, CI, a deploy) the variable is unset, which the
code reads as off. The flag alone spends nothing: every live path also needs
`GRADER_LIVE_SCAN=true`, a provider key, an explicit plan, and room in the
runner's ledger, and a live tick of the daily loop needs `GRADER_DAILY_LOOP=armed`
and `COLLECTION_BUDGET_USD_DAILY` on top. The whole test suite is offline by
construction and passes with the flag on. What the injection removes is one
of the two deliberate acts; the second stays.

---

## 8. Style

- TypeScript strict. No `any` without a comment explaining why.
- Pure functions in `packages/*`; side effects at the edges.
- Tests colocated (`*.test.ts`). `packages/stats` needs property tests, not just examples.
- Conventional commits. Reference the phase: `feat(collector): adapter contract [P1]`.
- British-neutral English in user-facing copy. No em-dashes in UI strings.
- Numbers in UI always formatted through `packages/stats/format` so intervals never get dropped.

---

## 9. Current state

**Phase:** _P3 — Grader & public surface_ (P0's G0 pilot is still unrun; see below)
**MVP plan (2026-09-09):** `docs/MVP_PLAN.md` is the staged work list against
`docs/PRODUCT_GOAL.md`; Stage A (the audit's seven confirmed defects) landed on
branch `mvp/stage-a`. The next session takes Stage B (foundation: Vercel for
`apps/public`, Supabase Auth, state into Postgres/R2) from that file.
**Gate:** G3 — activation. **Open on the classifier criterion**: ≥95% of 100
random real domains classified correctly. ADR-0009 built the site-content signal
and made the taxonomy grow on demand, but its thresholds were set from six real
homepages, not from that sample. Building the labelled 100 is what closes it.
**Blocked on:** nothing in code. Two decisions are a human's:
the classifier thresholds (see ADR-0009 "Open, and blocking G3"), and whether the
SSRF blocked-range table in `services/grader/src/fetch-site.ts` matches the
network the collector will actually deploy into.
**Real answers exist** (since 2026-09-01, local `data-live`, gitignored);
`docs/PROGRESS.md` §1 has the figures. G0 is still unrun.
**`apps/web` retired (2026-09-07):** the fixture-only dashboard is gone; the
workspace record in `apps/public/dashboard` is the dashboard. ADR-0002 still
places the paid product on Vercel as `apps/web` when P4 builds it. Tag
`apps-web-fixture-final` is the last commit with it.
**The claim is released (2026-09-07):** the orchestrator's index claim ends
with the collection, not with its lease; an allowance stop is
`allowance-exhausted`, distinct from `budget-exhausted`; completing a partial
cell buys only the missing runs. ⚠️ HUMAN REVIEW: spend-control logic.
**`pnpm typecheck` covers the apps** as well as packages and services.
**Cycles (ADR-0013, 2026-09-02):** a domain can be collected again on a later
UTC day, every cycle is kept (`results/cycles/<domain>/<day>.json`), and the
workspace record draws a real trend once two exist. A person starts each cycle
from the record; **there is no scheduler.** The per-domain ceiling's default is
derived, not fixed: `2 cycles × cells per cycle × 1.2 retry headroom` (204 at
17 prompts), decided 2026-09-02.
**Diagnostics (ADR-0014, 2026-09-02):** the result page shows what the engines
cited (every citation classified by the scan's own rules, shares with
intervals, most-cited sites) and the gap report (the homepage against the
cycle's prompts). Both are evidence fetched on request, never written into a
result; nothing generates or publishes.
**Publisher registry (ADR-0015, list approved 2026-09-03, NOT wired):** the
citation classifier is pinned under det-2 (`source-class-pin.test.ts`). A
registry of 52 editorial outlets under four admission criteria (ownership
counts at any distance) sits in `packages/taxonomy/src/publishers.ts`. Wiring
it is det-3 plus a re-score and is **deferred pending a separate go-ahead**.
Measured dry run: it moves the reference scan's "other" share from 88.7% to
87.2%; the rest of "other" is retailers, redirects, vendors and listicles,
which need new classes (also deferred), not a longer list.
`pnpm grader:publishers` proposes candidates and never writes.
**Correctable context (ADR-0016, 2026-09-03, all five steps landed, closing
gate green):** a category correction is a new record version by a person's
choice from the list, never a re-derivation (`pnpm grader:correct`); a
competitor set is adjusted per domain over the category's set, includes from
reviewed bank leaders only, and moves the basis (`set=N`,
`pnpm grader:competitors`); custom prompts are a versioned per-domain set held
to PROPERTY 2 with the scorer's own matcher, collected as a SECOND measurement
on its own basis (`custom=K@V`), never the headline (`pnpm grader:prompts`).
**Superseded on 2026-09-16 by ADR-0016 Amendment 1 (the person's edited set IS
the measurement; see C3 below).**
Visitors file requests; operators apply. One shared basis definition lives in
`packages/contracts/src/basis.ts`. Every route is local-demo only; there is
still no identity.
**Daily loop (ADR-0017, decisions 1 and 2 built 2026-09-07, NOT ARMED):**
`pnpm grader:tick -- --apply --live` runs every tracked, due domain through
the same runner and gates a click meets, under a daily cap of
`min(Σ tracked expected cost × 1.2, COLLECTION_BUDGET_USD_DAILY)` enforced
before each domain and booked in `daily-spend.json`. A live tick refuses
unless `GRADER_DAILY_LOOP=armed`, both collection flags, a key, a plan and
the hard ceiling are set, the runner's ledger has room, and `--live` is on
the command line. **No task is registered and no live tick has run; the
first needs the owner's separate go-ahead.**
**The ceiling split (decided and built 2026-09-07):** the per-domain monthly
ceiling counts HAND-STARTED cycles (`CYCLES_PER_MONTH = 2`, override
`GRADER_MAX_CYCLES_PER_DOMAIN_PER_MONTH`), never calls, and the loop never
books it; the loop's bounds are one cycle a day, the daily cap, and the
per-run allowance `Budget.runAllowanceCalls = ceil(cells × 1.2)` that the
collector enforces before every attempt, so a loop run's realised spend is
bounded by the day's cap and a hand-started run's by its cells with headroom.
The three failure scenarios are re-run as tests in
`ceiling-worked-examples.test.ts`.
**`/score-version` repaired (2026-09-03):** the command now names the real
constant (`SCORING_ALGO_VERSION` in `services/scorer/src/score.ts`), the two
pin tables, and the changelog table in `docs/METHODOLOGY.md`. Its diff is
`pnpm grader:version-diff`: `--snapshot` before the rule edit, `--against
<old>` after, every stored answer, every row field a rule can move, the
complete flip list (ADR-0012's bar, as a tool; the snapshot is untracked, the
changelog holds the list). The golden set holds 7 of 300 cases, so its
agreement is reported beside the flip list and its G2 gate stays NOT RUN; the
flip list is the gate for a bump.

**Stage B, 2026-09-10 (branch `mvp/stage-a`, continued):** B0 CI gate
(`.github/workflows/ci.yml`, offline, typecheck + test), B1 `apps/public`
on Vercel (ADR-0002 Amendment 1; every route carries its `maxDuration`;
the store is still one machine's disk until B3), B2 identity: Supabase Auth
magic link, migration `0003_accounts_identity.sql` (accounts carry the auth
uid and a kind; a brand account owns one workspace by trigger; three
definer functions `ensure_account`, `create_workspace`, `workspaces_of` are
the only onboarding path and the web tier keeps only `app_rw`),
`packages/db` gains `client` (a `Db` interface, `withWorkspace`), `token`
(the minter) and `testing` (the real migrations on PGlite behind the same
interface), and the app gains `/sign-in`, `/auth/confirm`, `/account`,
`/api/me`, `/api/workspaces`, `/api/auth/sign-in` and the session
middleware; the tenancy audit of that commit (2edceeb) closed a blocker
(`auth_uid` was readable by the tenant role) and six more findings. **B3a:**
migration `0004_workspace_state.sql` (cycles, versioned documents,
requests, scoped by workspace; written only through definer functions that
take the workspace from the verified context), `WorkspaceStore` +
`pgWorkspaceStore` in `services/grader/src/store/`, and `answerStores()`
choosing R2 + Upstash or the file store for raw answers (R4); its tenancy
audit found no leak and eight defence-in-depth findings, all fixed with
tests; the cost review found the orchestrator re-bought a cell when a blob
read failed, fixed in collect-cell.ts. ⚠️ HUMAN REVIEW: migrations 0003 and
0004, `collect-cell.ts` (retry logic), `packages/db/src/client.ts` (tenancy),
`answer-stores.ts` wiring in the runner (spend control). **Numbering clash
resolved by mechanism (B3r, 2026-09-15):** `schema_migrations` is created
in 0003 with a unique index on the four-digit number, every file from 0003
on records itself first, the test helper derives the ordered list from the
directory, and the deploy check asserts the record is gapless; main's
`0003_tenancy_exposure_manifest.sql` became 0008 at C0 (0005 is B3c's role
claim, 0006 and 0007 are B3d's member writes, all 2026-09-15). The oversight review's other three
findings (0003 in
one transaction; `ws_required()` for the writers only; the two standing
gates assert the inverse over everything a tenant session can read, with
`with_check`) are built with failing cases. **B3b (2026-09-15, ADR-0002
Amendment 2):** every route that touches workspace state goes through
`apps/public/lib/workspace-access.ts`: identity on ⇒ the session's ONE
workspace through a minted token (an agency with several is refused until
D1); identity off on a machine ⇒ the file store; a fleet runtime with
identity off ⇒ 503. The file modules' decisions are pure functions with a
file twin (the CLIs) and a store twin (the routes, the runner). The
ledgers live in Upstash when the six answer-store variables are set, in
files on a machine, and are refused on a fleet with neither
(`ledger-stores.ts`); the count ledgers are documents under a lock, the
dollar caps the collector's atomic ledger with the per-run allowance kept.
**On the deployment the Grader now needs a sign-in**, and `GRADER_DATA_DIR`
must be a writable directory there (`/tmp/grader`). ⚠️ HUMAN REVIEW:
`workspace-access.ts`, `ws_put_document(…, p_expect_version)`, the three
role-walking derivations (tenancy); `ledger-doc.ts`, `ledger-stores.ts`,
the spend ledger in `run.ts` and `bank-author.ts` (spend control).
**B4 (2026-09-15):** corrections are operator actions inside the
workspace: a POST on `/api/category`, `/api/competitors` or
`/api/custom-prompts` from an owner or admin applies (version N+1 through
the store, history kept, the matching pending request marked applied);
a member, or the file store, files a request; the CLIs stay.
**B3c (2026-09-15, the oversight reviews of B3b/B4, eight items, four
commits):** the burst-cap refusal names no host; the gap-report cap is
keyed by workspace; the tick lock is a lease in the store's ledger
document and every daily-ledger write folds into the stored value
(admission and booking are one exclusive write; a host in flight is
refused); the file ledgers open ONLY for a declared
`COLLECTOR_TOPOLOGY=single-process` (a fleet by marker or declaration, or
an undeclared runtime, is refused without Upstash; the CLIs declare for
themselves when nothing is declared; a route reads the declaration from
the environment or the repo-root `.env.local` and never supplies it, so
**a machine running the Grader now needs the variable**); the store's cap
file is read on the file backend only; an unreadable quota is a fixed
sentence with the cause logged; the 409 read-again path is tested; and,
human-owned, migration `0005_workspace_role_claim.sql`: the workspace
token carries `role`, the verifier checks it against `workspace_members`
and stamps it, and `ws_put_document` and `ws_resolve_request` refuse
unless the stamped role is owner or admin. ⚠️ HUMAN REVIEW: migration
0005, `token.ts`, `workspace-access.ts` (tenancy); `daily-loop.ts`,
`ledger-stores.ts`, `ledgerCapUsd` (spend control). One consequence for
the reviewer at the time: a member's session could not write a first
category record (reversed by B3d, below). The `cost-sentinel` and
`tenancy-auditor` reviews of B3c are fixed in the follow-up commit: the
file-backed ledger document writes under an exclusive lock file; the
deploy check derives that every definer writer of workspace state uses
`ws_required()` and every writer of a decision reads
`current_workspace_role()`; the migrations test cuts after every GRANT.
**B3d (2026-09-15, the oversight pass on B3c, six items, six commits;
the oversight session took two decisions the owner may overrule):**
(1) admission is per workspace, spend bounds stay deployment-wide: the
per-domain cycle ceiling is keyed `${workspaceId}:${host}` (`local` on a
machine, the bare host), ADR-0017 Amendment 2; the burst cap's repeat
exemption stays keyed by bare host and is recorded as accepted. (2) a
first category record is a measurement's precondition, not a decision:
migration `0006_member_first_record.sql` lets any member write version 1
of a category record and keeps every other write owner/admin; the two
route refusals are gone, a member previews and scans an unrecorded domain
and still cannot apply. (3) the deploy check's derivation runs first and
over every definer that touches workspace state, any owner, every form of
write, schema-qualified or quoted, and refuses dynamic SQL outright, with
a failing database per hole. (4) migration `0007_filing_ownership.sql`:
a request records who filed it and a member replaces only its own pending
filing, an owner or admin any; the three routes answer 409
`pending-elsewhere`. (5) `set_workspace`'s owner→admin→member ordering
is tested. (6) the intermittent `Timeout calling "onTaskUpdate"` on the
full suite was measured to the pre-spend hook test, whose 34 synchronous
bash spawns blocked its worker past vitest's 60 s acknowledgement; it now
runs every case through one asynchronous bash, three clean full runs in
an isolated worktree, and the exit code no longer depends on load. The
`cost-sentinel` and `tenancy-auditor` reviews of B3d are fixed in the
follow-up commit (no blocker): the ADR amendment's bound statement now
names what really bounds a hand-started scan (the burst cap, the provider's
live quota, the per-run allowance, the lifetime ledger; never the loop's
daily cap); the deploy check scans every function that touches workspace
state, counts MERGE, ONLY, TRUNCATE, COPY and a status-landing upsert,
refuses updatable views, requires the search_path pin, and pins
`ws_put_document`'s exemption; `ws_file_request` locks the workspace row.
⚠️ HUMAN REVIEW: migrations 0006 and 0007, `check-deploy.sql`'s derivation
(tenancy); `domain-ceiling.ts` (spend control). **Two questions for the
owner from the reviews:** hand-started spend now has no bound that scales
with the number of workspaces (re-keying removed the per-host monthly one),
and any member may open first cycles on any number of new hosts; both are
the same spend-cap question ADR-0017's open section describes. **Found, not
fixed, for a follow-up row:** `apps/public/app/api/scan/route.test.ts`
reads and writes the machine's own `data-live` and expects a pipedrive.com
cycle only this machine holds, so it fails on a clean checkout and would
fail in CI. Stage B is complete; the next session takes Stage C (the daily
schedule, C1's ADR) or Stage D1 (the agency portfolio, which
`workspaceAccess` refuses until it exists).

**B5 (2026-09-15, `ebbc36d`):** the suite is clean-checkout safe. The scan
and preview route tests run over scratch data directories; the two guarded
tests that read whatever data the machine holds resolve it through the app's
resolver and `services/grader/src/data-dir.ts`; `build-env.test.ts` asserts
no test names the live directory. Verified in a clean worktree (131 files,
1797 tests) and by CI run 34963093487, the branch's first green run. **CI is
the gate from here.**
**C1 (2026-09-15, `57d93c9`, ADR-0018 Proposed):** the daily loop on the
function host is two signed jobs on `/api/tick`: a scheduled fan-out that
decides the day under the tick lease (the tracked list, the due list per
workspace, the cap, the day's entry in the ledger) and publishes one domain
job per due domain; and a domain job that runs the loop's per-domain path
for one host in one workspace, idempotent on retry through the day's ledger
line. One invocation cannot run the day (Vercel Hobby 300 s, Pro 800 s,
streamed responses counted; docs 2026-08-24). Every QStash fact is quoted
with its fetch date. ADR-0017 Amendment 2 carries the B6 spend decision. A
job opens the workspace through a token minted for the account that
switched the domain on, re-verified by the database (⚠️ tenancy).
**C2 (2026-09-15, built, NOT REGISTERED, NOT ARMED, NO CREDENTIAL):**
`QStashClient` gains `publishJson`, schedule ids and list/pause/resume/
delete; `due.ts` is the pure `decideDue` with the file twin `dueToday` and
the store twin `dueTodayIn`, and the tracked list reads as the ledger
document `tracked.json` (`readTrackedIn`); `daily-loop.ts` exports
`liveGates`, `runFanOut` and `runDomainJob` over the same per-domain path
`runTick` uses, with the job-shaped reservation that refuses a line already
booked today and the day's cap and fan-out mark written before a job is
published; `apps/public/app/api/tick/route.ts` with `lib/tick.ts` (verify,
shape, the mode from the environment, the stores, the job; 401/400/503 only
where nothing was spent); `pnpm grader:schedule` (print by default;
`--register`, `--list`, `--pause`, `--resume`, `--remove`); the pre-spend
hook blocks `--register` and `--resume`. Tested offline end to end: fixture
mode through the real route and the real runner over the file store, and
armed over PGlite with the runner and the quota gate mocked, the cycle
landing in the entry's workspace and a non-member entry refused at the
database. **The deployment's tracked list has no write path yet (C3)**, so a
fan-out there publishes nothing. Both reviews ran and are fixed in the same
commit (no blocker; the day's ledger line is keyed per workspace, the mark
records failed publishes, the job token lives 600 s, the publish order
rotates); the owner's items are in ADR-0018 "Reviews of the build": the cap
is one figure admitted first come, the tracked document authorises
cross-workspace collection from outside the database (C3's rule: the
session, never a body), and the burst cap counts every tracked host as new
each day, so arming includes raising `GRADER_MAX_NEW_SCANS_PER_DAY` above the
tracked set or deciding loop jobs bypass it. ⚠️ HUMAN REVIEW REQUIRED: spend control
(`daily-loop.ts`: `reserveJob`, `openDay`/`closeDay`, `liveGates`,
`runAdmitted`; `.claude/hooks/pre-spend.sh`; `schedule.ts`) and tenancy
(`lib/tick.ts` `jobStoreFor`). **C2 is not complete until reviewed.** The
next session takes the review findings, then C3.
**C2r (2026-09-16, the cost review's four items, built):** the KV ledger
write is fenced to its lease (`KV.setIfHeld`, one server-side step on the
double, the file KV and Upstash; a stalled holder's write is refused and
thrown, proven with a deliberately stalled holder and the EVAL shape pinned);
the per-domain allowance is priced at the dearest engine so the daily ceiling
is hard, and the log line names a truncation; a publish QStash refused is
surfaced in the fan-out's log line and the tick CLI's dry listing (today and
yesterday); a settle the ledger refuses after a collect no longer throws (the
run is answered `ran` with `unsettled`, the reservation stands, and a retry
collects nothing for two independently proven reasons). Decided and recorded
in ADR-0018, not built: loop jobs bypass the new-domain burst cap at arming.
The independent cost review moved C2's verdict to **safe to arm once the owner
registers and arms**; still nothing registered, armed or spent. ⚠️ HUMAN
REVIEW REQUIRED: spend control (`ledger-doc.ts`, `cache-index.ts`
`setIfHeld`, `daily-loop.ts` `runAdmitted`/`runFanOut`, `tick.ts`).
**C3 (rescoped by the owner on 2026-09-16, landed 2026-09-19; identity OFF,
the machine's own store):** the entry flow. A person enters a domain; the
preview shows the domain's current prompt set (the bank's on first entry, the
person's own latest version after that); the person edits it in the app
(`components/prompt-preview.tsx`), saved as version V through
`/api/custom-prompts`, which on a machine's file store applies directly and
still refuses a prompt naming the subject or a tracked brand (PROPERTY 2); the
person enters a number of days; the first cycle runs now and
`POST /api/tracked` writes `{ host, since, until, by: local, prompts: V }` into
`tracked.json`; the daily tick asks THAT set on every engine each day until
`until`, and the day after is `expired`. **ADR-0016 Amendment 1 (owner decision
2026-09-16): the edited set IS the measurement.** The headline basis is
`unprompted=0|…|custom=K@V`, the headline and the record say "your N prompts,
version V", the trend breaks at a version change, a head-to-head compares equal
bases only, the bank's set is not collected for that domain unless kept, and
the record lists the days one by one at simple depth with who started each
(`CycleDays`). Decision 4's "second measurement" is superseded; a stored cycle
that carried a second block still reads back and re-derives with it. **The
deployment path stays built and unwired:** the same route derives the
workspace, the account and the role from `workspaceAccess()` and from nothing
in the body, re-reads the role at every write, refuses a member, counts an
interim ceiling of 3 tracked hosts per workspace inside the locked write,
passes other workspaces' entries through verbatim, and is throttled per
visitor and per domain; it is tested over PGlite and the KV double and no
surface offers it with identity on (`TrackedStatus.backend`). **Migration 0009:**
`workspace_cycles.source` (`hand`|`loop`), stamped by the runner from the
caller's declaration and copied into the column by `ws_put_cycle` under its
unchanged signature, so a loop-filed cycle is distinguishable (point 9); the
source is the app tier's word until a loop service identity exists, and the
file store holds the same same-day rule the database does. **Nothing is
registered or armed.** ⚠️ HUMAN REVIEW REQUIRED: METHODOLOGY (ADR-0016
Amendment 1: what the headline measures; `docs/METHODOLOGY.md` has no section
for it yet); tenancy (migration 0009, `api/tracked/route.ts`, `setTrackedIn`);
spend control (a tracked host is a daily spend; the per-workspace ceiling; the
cycle sized on the set in `decideDue` and `/api/scan`). The reviews are in
`docs/MVP_REVIEWS.md` row C3, NOT YET ACCEPTED: the statistics review found
one BLOCKER before the commit (a re-score of a decision-4 cycle would have
republished it as a measurement of a different sample; the re-score now pins
the ROLE the set played, `RunnerOptions.promptSetRole`), and left two
questions for the methodology owner: whether a set below the comparison floor
is refused rather than warned about, and whether the editor flags
near-duplicate prompts. The next session takes Stage P (presentation
readiness: P1, the daily checks run from the app the owner has open), then
Stage D.

**THE GATE IS THREE COMMANDS, EACH READ BY ITS OWN EXIT CODE (2026-09-19):**
`pnpm typecheck`, `pnpm test` AND `pnpm --filter @bliprank/public build`,
locally and on CI. C3 landed with typecheck, the suite and CI green and the
app's production build broken (a client page reached `node:crypto` through
the contracts package root; fixed in `b1ea791`, and CI now builds). tsc and
vitest run on Node and cannot see a browser or edge bundle that pulls a
Node-only module; only the build can. It bit again on 2026-09-19 inside the
session that wrote this line: an `instrumentation.ts` that returned early on
the negated runtime test put `node:crypto` into the edge bundle, with
typecheck and 2067 tests green, and the build leg refused it. Read each leg's
exit code in its own call (`cmd > log 2>&1; echo $?`), never through a pipe to
`tail`. The root suite excludes `.claude/**`: another session's worktree under
`.claude/worktrees/` is another branch's suite, and collected here it turned
143 files into 413 and failed 36 tests that are not this tree's.
**C3r (2026-09-19, the oversight verification's fourteen items, two commits
plus the gate repair; `docs/MVP_PLAN.md` row C3r carries the evidence):** the
custom tail of the basis ends in a fingerprint of the prompt list itself
(`packages/contracts/src/basis.ts`: `promptSetFingerprint`, `customBasisOf`,
`sameBasis`, `headlineSetOf`, `basisChangeWords`, `customBasisMismatch`; the
normaliser moved unchanged to `normalise.ts`), so two different sets at the
same K and V no longer share a basis and a revert to an identical set does;
`compare()` is untouched and the cross-cycle callers ask `sameBasis` first
(`apps/public/lib/compare-cycles.ts`). The record says a zero in words with
its range (`components/zero-mentions.tsx`), the day list is marked by
`compare()`'s own verdict in plain words (`lib/cycles.ts` `dayMarker`), the
head-to-head says which of three facts it is, an edit on a day whose check
already ran is said (`lib/served-set.ts`), a re-score and the evidence reader
refuse a set that is no longer the list the cycle asked, both readers of a
set drop repeats and the scan refuses a repeated question before asking
anything, the file store keeps a superseded day's file (R5), the tracked-host
ceiling is one decision under ONE lock for the route and the operator's
command (`due.ts` `decideTrackedSwitch`, `ledger-doc.ts`
`updateFileLedgerSync`), and the app's `dev` and `start` scripts bind
127.0.0.1, which is what bounds the unauthenticated writes while identity is
off. Three independent passes ran on the uncommitted change sets and each
found a MAJOR in the builder's first draft, all fixed with a failing case
first (`docs/MVP_REVIEWS.md` rows C3r, NOT YET ACCEPTED by the oversight
session). ⚠️ HUMAN REVIEW REQUIRED: METHODOLOGY (ADR-0016 Amendment 1
addendum: what two numbers must share before they are compared; the zero
sentence; the plain words for a changed basis); scoring/R5 (`rescore.ts`,
`store/file-store.ts`); spend control (`due.ts`, `ledger-doc.ts`
`updateFileLedgerSync`, `custom-prompts.ts` `MAX_CUSTOM_PROMPTS`).

**⚠️ `bliprank.rls_bypass_allowed` STAYS UNSET in production.** It is an
allowlist that excuses named roles from the deploy gate's superuser/BYPASSRLS
assertion — the one assertion no policy can substitute for, because a role with
BYPASSRLS reads every tenant's rows and appears in no table ACL. It exists for
the test harness (PGlite's session user is a superuser). The gate prints its
contents on every run; `(none)` is the expected output. Standing operational
item with no completion date: `docs/runbooks/deploying-the-database.md` §1.

**Tenancy deploy gate CLOSED (2026-09-09 on main; in this lineage at C0,
2026-09-15), ADR-0007.** Its hard prerequisite for G1, stalled 16 days on a
branch that was never even pushed. The exposure manifest, `assert_role_powers()`
and `auth_key_health()` all execute now; `check-deploy.sql` no longer ends with
"PARTIAL GATE". **C0 renumbered main's manifest to 0008** (the record's number
index made a second 0003 impossible): it records itself first and runs in one
transaction like every file from 0003 on; the three 0004 state tables and their
service writes are declared; the SECURITY DEFINER owner rule names the trusted
service roles (B2's writers are owned by svc_onboard by design) instead of
auth_verifier alone; the tenant-callable definer list is the twelve
`check-deploy.sql` declares (two copies of one list, either stale fails the
healthy database; consolidating them is a follow-up for the tenancy owner);
`migration_record()` lets main's non-owner deploy principal read the record
(it got permission denied before, so the gate could not run as that principal);
and, from the merge's tenancy audit, a `service` row names its grantee and the
sweep matches on it, so a grant to the wrong service role on the state tables
is refused. Every derivation the branch had is kept, and the merged
gate runs the manifest first; where it now speaks before a branch assertion,
that assertion's test runs its section alone (`only`, `refusedBy`) so each
line is proven on its own. The branch's read inverse refuses any
tenant-readable VIEW, security_invoker or not; the manifest accepts a declared
invoker view; the stricter refusal stands and the rule for invoker views is
the tenancy owner's decision. Suites kept: `check-deploy.test.ts` (38) and
`deploy-check.test.ts` (77, main's, re-run against the merged gate); neither
is a superset of the other. ⚠️ HUMAN REVIEW: migration 0008 and
`check-deploy.sql` (tenancy).

**A deadline pinned to a gate is not a deadline here.** ADR-0007 chose "before
G1" over "before launch" because G1 has a date and launch does not. No gate has
ever been run — G0 unrun, G1 never attempted, G2 NOT RUN, G3 blocked — so it
never came due, and two phases of work landed on top of an open security gate.
Anything given a deadline from now on gets a date, not a milestone.

**main's note that four `scan-result.test.ts` cases fail there** (the
`data-live:sigzen.com*` cases, comparing the bundled record against whatever
sigzen result the machine holds) does not apply to this lineage: B5 made the
suite clean-checkout safe and the file passes here (17 tests, full run at C0,
2026-09-15, 134 files green).

Update this section at every phase transition. It is the first thing a new session reads.
