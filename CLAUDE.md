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

| Pillar | What it means in code |
|---|---|
| **Measurement integrity** | Every metric ships with a Wilson 95% CI, a disclosed sample size `n`, and a versioned scoring algorithm ID. Never a bare point estimate. |
| **Cross-tool reconciliation** | We ingest competitors' exports (Peec, Profound, Semrush, Ahrefs, Otterly, AthenaHQ) and explain *why* their number differs from ours. This is the wedge. |
| **Causal proof** | Holdout-based experiments with difference-in-differences, not correlation dressed up as causation. |

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
        │  × engine × locale ×  │              │     sentiment        │    Batch + cache
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
   │ apps/web (Next.js) │          │ apps/public (Grader)     │
   │ dashboards, recon, │          │ free tool, indexable,     │
   │ agency workspaces  │          │ cache-served, <90s        │
   └────────────────────┘          └──────────────────────────┘
```

Full detail: `docs/ARCHITECTURE.md`. Read it when touching anything structural.

### Repository map

```
apps/web              Next.js 15 App Router — the paid product
apps/public           Grader + satellite free tools (separate deploy)
services/collector    Worker fleet, Engine Adapters, rate-limit budget
services/scorer       Deterministic pass + sampled LLM, versioned registry
services/reconcile    Competitor export parsers, variance decomposition
packages/stats        Wilson, DiD, sampling. Pure functions. HUMAN-OWNED.
packages/db           Drizzle schema, migrations, RLS policies, partitions
packages/contracts    Shared types + the Engine Adapter interface
docs/                 ARCHITECTURE.md, PHASES.md, METHODOLOGY.md, adr/
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

- **Web**: Next.js 15 (App Router), shadcn/ui, Tailwind, Visx (CI-aware charts)
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
COLLECTION_BUDGET_USD_DAILY=      # hard ceiling, enforced by the collector
COLLECTION_ENABLED=false          # default OFF in dev
```

**The prompt-bank author** (ADR-0009 Amendment 1). Optional: with no key it is
off, and a domain in no known category falls back to the general bank exactly as
it did before authoring existed. Everything here is an env edit on purpose —
these are free tiers, and swapping a rate-limited one must not be a deploy.

```
OPENROUTER_API_KEY=               # or BANK_AUTHOR_API_KEY. Absent = authoring off.
BANK_AUTHOR_MODEL=                # default nvidia/nemotron-3-super-120b-a12b:free
BANK_AUTHOR_FALLBACK_MODEL=       # default meta-llama/llama-3.3-70b-instruct:free; '' disables
BANK_AUTHOR_PROVIDER=             # openai-compatible (default) | anthropic
BANK_AUTHOR_BASE_URL=             # default https://openrouter.ai/api/v1
BANK_AUTHOR_TIMEOUT_MS=           # default 25000, per attempt
```

**⚠️ Whichever model answers, the competitor rule holds.** It is not the schema:
`parseCandidate` reads three keys and ignores every other one, `leaders: []` is
constructed in our code, and a stored bank that has acquired leaders is dropped
on read. A model that names rivals is not an error, it is a field nothing reads.

`COLLECTION_ENABLED` defaults to `false`. Turning it on in a dev session is a
deliberate, logged act.

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

Update this section at every phase transition. It is the first thing a new session reads.
