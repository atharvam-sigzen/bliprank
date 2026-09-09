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
docs/                 ARCHITECTURE.md, PHASES.md, METHODOLOGY.md, PRODUCT_GOAL.md, MVP_PLAN.md, adr/
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
| `apps/public` — Grader + free tools | **Cloudflare Pages** | Static asset requests free and unlimited. Vercel charges $0.15/GB past 1TB plus $2/M edge requests — on *acquisition* traffic. Also isolates a tool that may get hammered from the paid product. |
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
UPSTASH_REDIS_REST_URL= UPSTASH_REDIS_REST_TOKEN=
STRIPE_SECRET_KEY= RAZORPAY_KEY_ID= RAZORPAY_KEY_SECRET=
COLLECTION_BUDGET_USD_DAILY=      # hard daily ceiling, read by the daily loop (ADR-0017); a live tick refuses without it
COLLECTION_ENABLED=                # see below: ON in agent sessions by decision, OFF everywhere else
TRUSTED_PROXY=                     # cloudflare | vercel. Names the edge whose client-IP header the visitor throttle may read; unset = no header is trusted, every caller is one bucket
```

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
```

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

Update this section at every phase transition. It is the first thing a new session reads.
