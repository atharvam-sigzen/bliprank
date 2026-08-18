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
| 0.5 | **OpenWeb Ninja pilot**: 100 prompts × 5 engines × 10 runs × 3 known brands |
| 0.6 | Cost/variance instrumentation dashboard |

### GATE G0 — the assumption gate

| Dim | Criterion | Threshold |
|---|---|---|
| Functional | Pilot completes across all 5 surfaces | 5/5 return parseable responses |
| Functional | Wilson implementation agrees with reference | ≤1e-9 across the n×p̂ grid |
| Performance | Response latency observed | p95 ≤ 20s (provider states 2–20s) |
| **Cost** | **Measured $/answer** | **≤ $0.0022 (model says $0.002)** |
| **Cost** | **Run-to-run variance** | **n=5 yields CI half-width ≤ ±0.20 at p̂≈0.25** |
| Usability | A second person can reproduce the pilot from the README | unaided |

> **G0 is the most important gate in the project.** If measured cost per answer is
> materially above $0.002, or if variance is so high that n=5 gives a useless
> interval, the unit economics in the business plan do not hold and the pricing
> must be reworked **before** anything else is built. Do not proceed past G0 on
> optimism.

---

## P1 — Measurement Core · Week 2–5

**Goal:** collect and store answers reliably, cheaply, reproducibly.

| # | Deliverable |
|---|---|
| 1.1 | `services/collector` on **Vercel Fluid Compute + QStash** — concurrency, backoff, dead-letter (ADR-0002) |
| 1.2 | OpenWeb Ninja adapter implementing the contract + fixture suite |
| 1.3 | **Second provider stubbed** against the same contract (proves the abstraction) |
| 1.4 | Cache key + Redis index; shared prompt-pool dedupe |
| 1.5 | R2 storage, batched one object per `prompt × engine × day` |
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
| 3.1 | Category classifier (site content + autocomplete + contacts enrichment) |
| 3.2 | 200 pre-computed category prompt banks + leader sets, via `/category-bank` |
| 3.3 | `apps/public` — the free AI Visibility Grader |
| 3.4 | Head-to-head chart with CI bands; Confidence Grade A–D |
| 3.5 | Email gate on the gap list; indexable public result pages |
| 3.6 | Turnstile / abuse protection; per-IP budget cap |

### GATE G3 — the activation gate

| Dim | Criterion | Threshold |
|---|---|---|
| Functional | 100 random real domains graded end-to-end | ≥ 95% classified correctly |
| Functional | Result page is indexable and renders without JS | verified |
| **Performance** | **Domain → first scored benchmark** | **p95 ≤ 90 seconds** |
| **Cost** | Marginal cost per grade (cached category) | ≤ $0.05 |
| **Cost** | Marginal cost per grade (novel domain) | ≤ $0.20 |
| Usability | 5 strangers grade their own domain unaided | 5/5 reach the gap list |
| Usability | 5 strangers can say what the interval means | ≥ 3/5 |

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
| 5.1 | Owned-surface Autopilot: gap pages, schema, `llms.txt`, internal linking |
| 5.2 | AI crawler audit (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) |
| 5.3 | Agency workspaces — 15 clients, white-label reports, unlimited seats |
| 5.4 | Public REST API + customer-facing MCP server |
| 5.5 | Entity consistency checks (Wikidata, Crunchbase, G2, Trustpilot, GBP) |
| 5.6 | **Collector runner migration** — Vercel → Hetzner CAX (ARM) fleet, if sustained throughput has crossed ~4 req/s (ADR-0002) |

### GATE G5 — the agency gate

| Dim | Criterion | Threshold |
|---|---|---|
| Functional | An agency runs 3 client workspaces with no cross-leak | verified by `tenancy-auditor` |
| Functional | White-label report generates and sends unattended | 0 manual steps |
| Functional | API + MCP return metrics with intervals intact | schema-validated |
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
| 7.5 | Earned-media module: forums/Reddit citation-source intelligence |
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
