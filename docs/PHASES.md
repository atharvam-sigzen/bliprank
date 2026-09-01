# BlipRank — Phase Plan and Exit Gates

Eight phases. Every phase ends at a gate with **executable** checks across four
dimensions: functional, performance, cost, usability. `/gate-check` runs them.

A gate criterion with no executable check is `NOT RUN`, not `PASS`.

---

## P0 — Foundation · Week 0–1

**Goal:** prove the assumptions the whole business model rests on, before writing
the product.

| # | Deliverable |
|---|---|
| 0.1 | Repo, monorepo tooling (pnpm + Turborepo), CI, environments |
| 0.2 | `CLAUDE.md`, `.claude/` (agents, commands, skills, hooks), plugins installed |
| 0.3 | `packages/contracts` — the `EngineAdapter` interface, **hand-written** |
| 0.4 | `packages/stats` — Wilson intervals, verified against reference implementation |
| 0.5 | **OpenWeb Ninja pilot**: 100 prompts × 5 engines × 10 runs, three known brands detected in every answer, every cell re-collected on a second day (≈10k calls; ≈$68 at pay-as-you-go, ≈$18 at Mega marginal). Runner: `services/collector/pilot/README.md` |
| 0.6 | Cost/variance instrumentation: $/answer, latency, ρ̂_u (day×cell), pass-to-pass and day-to-day dispersion, ANOVA upper bound, DEFF, n_eff per engine — `pnpm collector:analyse` |

### GATE G0 — the assumption gate

| Dim | Criterion | Threshold |
|---|---|---|
| Functional | Pilot completes across all 5 surfaces | 5/5 return parseable responses |
| Functional | Wilson implementation agrees with reference | ≤1e-9 across the n×p̂ grid |
| Performance | Response latency observed | p95 ≤ 20s (provider states 2–20s) |
| **Cost** | **Measured $/answer**, re-priced at the Mega marginal rate the model assumes (attempts incl. retries × Mega price ÷ answers); the plan actually charged is reported alongside | **≤ $0.0022 at Mega marginal (model says $0.002)** |
| **Cost** | **Design effect** — day×cell correlation ρ̂_u of the mention indicator, per engine, from the two-day re-collection: D = day-to-day dispersion ratio of per-cell counts (fixed cell effects cancel), ρ̂_u = (D − 1)/[(m − 1)(1 + D/(2m − 1))] (exact inversion of E[D]); the single-day ANOVA ρ̂ is only an upper bound | **DEFF = 1 + 4ρ̂_u ≤ 1.5 at the Starter default of 5 runs/cell, judged on the 95% upper confidence limit of ρ̂_u (bootstrap over cells), on every engine** |
| **Cost** | **Precision at the reported unit** — Starter unit = brand × engine × cycle over 30 prompts × 5 runs, n = 150 nominal | **n_eff = 150 / DEFF ≥ 100, i.e. the Wilson interval at p̂ = 0.25 lies within [0.17, 0.35]** |
| Functional | Day-2 answers are fresh, not replays — D's 95% CI not entirely below 1 and < 50% of day-2 texts byte-identical to a day-1 text of the same cell | required; a cached provider passes every variance row otherwise |
| Cost | Within-day pass-to-pass dispersion (sub-day clustering, a different estimand), the single-day ANOVA ρ̂ (upper bound), ρ̂_u on the first 5 runs (exchangeability check), the engine-level day shift, per engine | reported alongside, not gated; without the second day the design-effect rows are NOT RUN |
| Usability | A second person can reproduce the pilot from the README | unaided |

> **G0 is the most important gate in the project.** If measured cost per answer is
> materially above $0.002, or if the design effect is so large that the Starter
> unit's effective n gives a useless interval, the unit economics in the business
> plan do not hold and the pricing must be reworked **before** anything else is
> built. Do not proceed past G0 on optimism.
>
> Why the variance criterion is shaped this way: the Wilson interval at a fixed
> (n, p̂) is arithmetic, not evidence — a 5-run cell at p̂ = 0.25 is [0.05, 0.66]
> whatever the engine does, so no pilot can pass or fail a half-width threshold.
> What the pilot *can* falsify is the independence assumption behind every
> interval we will ever publish — specifically the day×cell component: runs of a
> cell within one cycle being more alike than runs of that cell across cycles.
> Between-prompt heterogeneity is a fixed effect of the bank; it cancels in
> cycle-to-cycle comparisons and only makes single-cycle Wilson conservative,
> which is why the gate uses the two-day estimator and not the single-day ANOVA
> figure. If DEFF exceeds 1.5 the product is not broken: every published interval
> switches to n_eff = n / DEFF and runs-per-tier are re-derived — but that has to
> be known before pricing is fixed, not after launch.
>
> Two things two days cannot see, stated rather than hidden: a cycle-level shift
> common to all cells (a model deploy or index refresh — σ_g) enters week-on-week
> differences undivided by prompts or runs and needs ≥ 4 cycles to estimate; the
> engine-level day shift is reported as a diagnostic only. And the certified n_eff
> is bank-conditional: it covers "this bank on this engine", not generalisation
> from a 30-prompt bank to a category — the UI/API must label it so, or a
> prompt-clustered DEFF must be added (human decision, P2.6).

---

## P1 — Measurement Core · Week 2–5

**Goal:** collect and store answers reliably, cheaply, reproducibly.

| # | Deliverable |
|---|---|
| 1.1 | `services/collector` on **Vercel Fluid Compute + QStash** — concurrency, backoff, dead-letter (ADR-0002) |
| 1.2 | OpenWeb Ninja adapter implementing the contract + fixture suite — **normalisation preserves full citation metadata (video timestamps, community thread IDs), not just top-level domains** |
| 1.3 | **Second provider stubbed** against the same contract (proves the abstraction) |
| 1.4 | Cache key + Redis index; shared prompt-pool dedupe |
| 1.5 | R2 storage, batched one object per cell (`prompt × engine × locale × geo × day`, ADR-0003) |
| 1.6 | Rate-limit budget manager **behind a pluggable interface**, configurable window, multi-key sharding — the interface is what makes the P5 runner migration a swap, not a rewrite |
| 1.7 | `packages/db` schema: partitioned score tables, RLS from day one |

### GATE G1 — the pipeline gate

| Dim | Criterion | Threshold |
|---|---|---|
| Functional | Collect 10,000 answers for 3 brands across 5 engines | 100% durably stored |
| Functional | Re-run the same cell | cache serves it, 0 new provider calls |
| Functional | Kill a worker mid-run | zero lost jobs, dead-letter empty after retry |
| Functional | Swap to the stubbed second provider | pipeline runs unmodified |
| Performance | Sustained throughput on the Vercel runner | ≥ 3 req/s with headroom to 15 |
| **Cost** | Actual spend for the 10k run | within 10% of predicted |
| **Cost** | Cache hit rate on a repeat cycle | ≥ 90% |
| Usability | `/cost-audit` produces a correct reconciliation | matches the invoice |

---

## P2 — Scoring & Statistics · Week 4–7 *(overlaps P1)*

**Goal:** turn answers into defensible numbers. This is the product.

| # | Deliverable |
|---|---|
| 2.1 | Deterministic scorer: mention, citation, position, competitor set |
| 2.1b | **Citation source classifier** — owned / video / community / review / earned_media / competitor / reference (ADR-0005) |
| 2.2 | Alias table + normalisation; category competitor registry |
| 2.3 | Sampled LLM sentiment — Haiku 4.5, Batch API, 1h prompt cache, 25% sample |
| 2.4 | Versioned algorithm registry; immutable score rows |
| 2.5 | **Golden set**: 300–500 hand-labelled answers + agreement harness |
| 2.6 | Aggregation: Wilson intervals, rollups, sufficient statistics |
| 2.7 | Cross-path agreement monitor (primary vs stub provider) |

### GATE G2 — the correctness gate

| Dim | Criterion | Threshold |
|---|---|---|
| Functional | Golden-set agreement, deterministic signals | ≥ 95% vs human labels |
| Functional | Golden-set agreement, sampled sentiment | ≥ 85% vs human labels |
| Functional | Citation source classification agreement | ≥ 97% vs human labels; **0% silently bucketed as `owned`** |
| Functional | Score a fixture twice | byte-identical output (determinism) |
| Functional | `/score-version` produces a correct diff report | flip list is complete |
| Performance | Scoring throughput | ≥ 50k answers/hour on one worker |
| **Cost** | Measured $/answer scored | ≤ $0.00035 blended |
| **Cost** | Batch + cache actually in use | verified in provider usage response |
| Usability | `stats-reviewer` finds no BLOCKER | clean review |

> **This gate has a hard stop.** If deterministic agreement is below 95%, the
> scoring rules are wrong and no amount of UI work compensates. Fix the rules.

---

## P3 — Grader & Public Surface · Week 6–9

**Goal:** the acquisition engine — and the 90-second activation path.

| # | Deliverable |
|---|---|
| 3.1 | Category classifier (site content + autocomplete + contacts enrichment). **Site content built 2026-09-01 (ADR-0009)** — deterministic keyword scoring over the page's own text, behind an explicit SSRF boundary, with the answer written down once per domain so it can never silently change. Autocomplete and contacts enrichment are still unbuilt and still have no provider. **The thresholds are set from six real homepages, not from a labelled set — measuring them against the 100-domain sample is what closes G3's ≥95%, and it is not done.** |
| 3.2 | 200 pre-computed category prompt banks + leader sets, via `/category-bank`. **14 hand-authored + a fallback**, demo-scoped (ADR-0008), leader sets unverified. **Since 2026-09-01 the set also grows on demand (ADR-0009)**: a domain no category fits gets a bank authored from its homepage, persisted and reused. An authored bank has NO leaders, ever — only real competitors, from collected answers, may enter a chart. |
| 3.3 | `apps/public` — the free AI Visibility Grader. **Scan size must clear `MIN_N_FOR_COMPARISON` in the DEGRADED case, not the nominal one** — see the note below |
| 3.4 | Head-to-head chart with CI bands; Confidence Grade A–D — **done 2026-08-24** (`4d1cb96`), fixture-only |
| 3.5 | Email gate on the gap list; indexable public result pages |
| 3.6 | Turnstile / abuse protection; per-IP budget cap. **Partly done**: a per-visitor rolling-window scan throttle and a separate preview throttle both ship; Turnstile and a per-CUSTOMER request ceiling do not. |

### GATE G3 — the activation gate

| Dim | Criterion | Threshold |
|---|---|---|
| Functional | 100 random real domains graded end-to-end | ≥ 95% classified correctly |
| Functional | Result page is indexable and renders without JS | verified |
| **Performance** | **Domain → first scored benchmark** | **p95 ≤ 90 seconds** |
| **Cost** | Marginal cost per grade (cached category) | ≤ $0.05 |
| **Cost** | Marginal cost per grade (novel domain) | ≤ $0.20 |
| Functional | Free-scan sample after simulated engine loss | ≥ `MIN_N_FOR_COMPARISON`, so the head-to-head is not silently empty |
| Usability | 5 strangers grade their own domain unaided | 5/5 reach the gap list |
| Usability | 5 strangers can say what the interval means | ≥ 3/5 |

> **The free scan has a floor, and it fights the cost criterion above it.**
> Decided 2026-08-24. `compare()` refuses any pair below
> `MIN_N_FOR_COMPARISON`, so a scan under that floor renders a head-to-head in
> which every verdict is "not enough data" — honest, and useless, on the tier
> most visitors will ever see. The size is therefore set by what SURVIVES: the
> G0 pilot got HTTP 403 from all five surfaces at once, so two dark engines is a
> normal bad day, and 20 prompts × 5 engines × 1 run still leaves 48 answers at
> 80% yield on three surviving engines.
>
> Breadth, not depth. `n_eff = n / DEFF` and DEFF grows with runs per cell, not
> with prompt count, so one run over many prompts buys more effective sample
> than many runs over few for the same spend.
>
> **This does not close at pay-as-you-go rates.** 20 prompts × 5 engines costs
> $0.180 at Mega marginal against the ≤ $0.20 novel-domain criterion — a 10%
> margin — and $0.680 at pay-as-you-go, which is 3.4× over. Even the bare
> minimum that clears the floor with no failure margin at all (6 prompts × 5
> engines) is $0.204 at pay-as-you-go, already over the gate. **The free
> Grader's novel-domain unit economics only close on the Mega tier**, and
> `Budget` charges every attempt including retries (`maxAttempts: 3`), so
> realised cost per scan is above nominal. Cached categories are the answer for
> volume — that is what the 200 pre-computed banks in 3.2 are for — but a novel
> domain is the acquisition case.
>
> Both numbers are provisional. `MIN_N_FOR_COMPARISON` is pending G0's measured
> design effect, so the floor and therefore the scan size and therefore the cost
> per grade all move once G0 runs. Nothing hardcodes the floor: the scan asserts
> against the imported constant.

---

## P4 — App & Reconciliation · Week 8–12

**Goal:** the paid product, and the wedge feature.

| # | Deliverable |
|---|---|
| 4.1 | Auth, workspaces, RLS-enforced tenancy |
| 4.2 | Dashboard: trends with CI bands, per-engine, per-prompt drill-down |
| 4.3 | **Cross-Tool Reconciliation v1** — parsers for Peec, Semrush, Ahrefs, Otterly |
| 4.4 | Six-factor variance decomposition + pooled estimate |
| 4.5 | Billing: Stripe + Razorpay behind one abstraction; tier entitlements |
| 4.6 | Scheduled reports (email, Slack, CSV) |

### GATE G4 — the commercial-product gate

| Dim | Criterion | Threshold |
|---|---|---|
| Functional | Reconcile a **real** competitor export end to end | report renders, residual stated |
| Functional | All four parsers handle their edge-case fixtures | 100% pass |
| Functional | Tenancy: cross-workspace read attempt | denied at the database |
| Functional | Signup → paid → entitlement applied | both payment providers |
| Performance | Dashboard p95 | ≤ 800ms |
| **Cost** | Tech cost per paying customer per month | ≤ $30 |
| Usability | 3 external users complete a reconciliation unaided | 3/3 |
| Usability | Ask them "why do the tools disagree?" | ≥ 2/3 answer from the report |

> **G4 is the differentiation gate.** If reconciliation does not land here, BlipRank
> is tool number 73. Do not defer it to a later phase.

---

## P5 — Autopilot & Agency · Week 11–14

| # | Deliverable |
|---|---|
| 5.1 | Owned-surface Autopilot: gap pages, schema, `llms.txt`, internal linking, **FAQ schema generator, semantic gap identifier** |
| 5.2 | AI crawler audit (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) |
| 5.3 | Agency workspaces — 15 clients, white-label reports, unlimited seats |
| 5.4 | Public REST API + **`@bliprank/mcp-server`** — terminal-native access from Claude Code, Cursor and agent workflows: run an audit, pull a reconciliation report, query visibility |
| 5.5 | Entity consistency checks (Wikidata, Crunchbase, G2, Trustpilot, GBP) |
| 5.5b | **Earned-media target list builder** — ranks publishers, communities and video channels actually being cited for the customer's prompts, from the source-class corpus |
| 5.6 | **Collector runner migration** — Vercel → Hetzner CAX (ARM) fleet, if sustained throughput has crossed ~4 req/s (ADR-0002) |

### GATE G5 — the agency gate

| Dim | Criterion | Threshold |
|---|---|---|
| Functional | An agency runs 3 client workspaces with no cross-leak | verified by `tenancy-auditor` |
| Functional | White-label report generates and sends unattended | 0 manual steps |
| Functional | API + MCP return metrics with intervals intact | schema-validated |
| Functional | `@bliprank/mcp-server` full tool suite | all tools pass integration tests |
| Performance | White-label report generation | ≤ 60s for 15 clients |
| **Cost** | Agency-tier COGS | ≤ 23% of $464 effective ARPA |
| Functional | If migrated: same fixture suite passes on the new runner | 100%, zero collection-logic changes |
| Usability | 2 design-partner agencies bill a client off the report | 2/2 |

---

## P6 — Launch Hardening · Week 15–16

| # | Deliverable |
|---|---|
| 6.1 | Load test at 10× current volume; rate-limit failure drills |
| 6.2 | Security review; dependency audit; penetration test of tenancy |
| 6.3 | **Public methodology page** at a stable, citable URL |
| 6.4 | Docs site + Claude-powered support agent (75% deflection target) |
| 6.5 | Status page, on-call runbooks, incident automation |
| 6.6 | Disaster recovery drill — restore from backup, verified |

### GATE G6 — the Week-16 commercial gate

This is the business gate from the strategy plan, not just a technical one.

| Dim | Criterion | Threshold |
|---|---|---|
| Commercial | Paying customers | 40–80 |
| Commercial | Trial → paid conversion | ≥ 20% |
| **Cost** | **COGS as % of revenue** | **≤ 25%, with a documented path to ≤ 18%** |
| Functional | DR restore | ≤ 4 hours, zero data loss |
| Performance | 10× load | no dropped collection cycles |
| Security | Tenancy penetration test | zero findings |
| Usability | Support deflection | ≥ 60% (75% target by M9) |

> The strategy plan's original ≤15% COGS target is **not achievable at launch** —
> modelled Year 1 blended COGS is 21%. The gate is reset to ≤25% with a documented
> path. Holding the original number would fail a product that is working.

---

## P7 — Causal Lift & Corpus · Week 17–28

| # | Deliverable |
|---|---|
| 7.1 | Holdout experiment design; matched control construction |
| 7.2 | Difference-in-differences with CIs; category drift adjustment |
| 7.3 | Category Benchmark Index in-product (percentile vs category) |
| 7.4 | Public CBI programme — 12 verticals, `/cbi-publish` |
| 7.5 | Earned-media module: source-class intelligence across community, video, review and PR surfaces |
| 7.5b | **Sentiment drift monitoring** — multi-brand sentiment matrix over time, with drift flagged only when it exceeds the CI |
| 7.6 | ClickHouse migration for corpus analytics |

### GATE G7 — the retention gate

| Dim | Criterion | Threshold |
|---|---|---|
| Functional | A causal lift report with a real holdout | statistically valid, reviewed |
| Functional | CBI refuses to publish on thin data | blocks at n<30 |
| Performance | Category index generation | ≤ 60s |
| **Cost** | Cache hit rate | ≥ 45% |
| Commercial | Starter monthly churn | ≤ 9% |
| Commercial | Growth monthly churn | ≤ 5.5% |
| Commercial | Starter → Growth upgrade within 6 months | ≥ 15% |

---

## Testing between phases

Every phase carries the same standing suite, run at each gate:

1. **Contract tests** — every adapter satisfies `EngineAdapter`, from fixtures only.
2. **Golden-set regression** — scoring agreement never drops between versions.
3. **RLS suite** — every table, every policy, every workspace-crossing query shape.
4. **Cost regression** — `cost-sentinel` on the diff; `/cost-audit` on the invoice.
5. **Statistical reference** — `packages/stats` vs scipy/statsmodels to 1e-9.
6. **Determinism** — score the same fixture twice, expect identical bytes.
7. **Stranger test** — someone outside the team completes the phase's core task unaided.

The stranger test is the one teams skip and the one that predicts churn.
