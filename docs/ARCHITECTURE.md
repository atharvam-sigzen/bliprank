# BlipRank — Architecture

Companion to `CLAUDE.md` §2. Read before any structural change.

---

## 1. Workload shape

BlipRank is a batch data factory with a thin web app attached. Five subsystems,
five different cost and scaling profiles.

| Subsystem | Character | Consequence |
|---|---|---|
| Collection | Scheduled, bursty, IO-bound. 20.4M outbound calls/month at target, each waiting 2–20s. Near-zero CPU. | High-concurrency runner that does not bill I/O wait. Vercel Fluid Compute early, dedicated ARM workers past ~4 req/s. |
| Scoring | Deferred, parallel, CPU-light | Batch API + prompt caching. Latency does not matter; cost does. |
| Storage | Write-heavy, append-only, read-rarely (~2%) | Cold object storage for payloads; Postgres only for what is queried. |
| Aggregation | Rollups, percentiles, cross-corpus scans | Columnar store past ~200M rows. |
| Application | Low volume, latency-sensitive, cacheable | Standard Next.js on serverless. The cheap part. |

## 2. The three decisions that dominate cost

| # | Decision | Wrong choice | Right choice |
|---|---|---|---|
| 1 | How answers get scored | LLM on every answer: **$155,300/mo** at target | Deterministic-first + 25% sampled sentiment, batched + cached: **$14,830/mo** |
| 2 | Where raw answers live | Postgres: ~$237/mo at 1.9TB plus query degradation | R2: $46/mo, zero egress |
| 3 | What runs collectors | *Classic* wall-clock-billed serverless: 45,300 GB-hours/month of pure waiting | Fluid Compute (active-CPU billing) early → ARM workers at scale: ~$320/mo for the whole fleet |

Decision 1 is a **10.5× multiple** — $1.69M/year. It is also what makes numbers
reproducible. The cheap architecture and the honest architecture coincide.

## 3. Data model — four rules

### 3.1 The cache key is the schema
```
answer_id = hash(normalised_prompt, engine, locale, geo, date_bucket)
```
Primary key of the answer store, lookup key in Redis. It is simultaneously the
margin lever, the Category Benchmark Index corpus, and the moat. Changing its shape
requires an ADR. It cannot be retrofitted.

Normalisation: lowercase, collapse whitespace, strip terminal punctuation, resolve
brand aliases to canonical form. Normalisation is versioned — a change to it is a
change to the cache key.

### 3.2 Score rows are immutable and version-stamped
Every row carries `algo_version`. Never mutate a historical score. Algorithm
changes write new rows; the UI renders a version boundary. Competitors silently
rebase; we publish a changelog.

### 3.3 Partition and roll up
Score rows are monthly-partitioned. Raw score rows expire at 90 days. Daily and
weekly aggregates retain **sufficient statistics** — successes, trials, and the
derived Wilson bounds. Confidence intervals need counts, not rows, so nothing
analytical is lost.

### 3.4 Measurement is separate from tenancy
The answer corpus is shared and category-keyed. Customer visibility is a filtered
join, never a copy. An agency workspace with 15 clients must never trigger 15
duplicate collections of the same category prompt.

## 4. Component detail

### services/collector

**Runner: phased.** See ADR-0002.

| Phase | Runner | Rationale |
|---|---|---|
| P0–P3 (to ~M18) | Vercel Fluid Compute + Upstash QStash | Fluid Compute bills active CPU, not wall-clock — I/O wait is free — and optimized concurrency shares one instance across many in-flight invocations. Pro allows 800s max duration (1800s beta). At M12 you need 1.3 req/s sustained; this is trivially handled with zero ops burden. |
| P4+ (from ~M18–M20) | Hetzner CAX (ARM), 200–400 concurrent sockets per instance | Triggered by the **global rate budget**, not by cost. |

**Why the migration happens.** The provider ceiling is 15 req/s (Mega tier). You
need one token bucket across *all* collection, shardable across API keys. With
auto-scaling ephemeral instances that state cannot live locally, so every one of
20M monthly calls needs a distributed-limiter round-trip and concurrency stops
being something you can reason about. A fixed fleet gives each worker a static
slice of the budget and the problem dissolves.

Secondary reasons: flat monthly cost (a business whose margin thesis depends on
`/cost-audit` reconciliation benefits from a predictable line), and persistent
connection pooling for hundreds of concurrent sockets.

**Migration trigger: sustained throughput crosses ~4 req/s.** Because collection
sits behind `EngineAdapter`, only the runner changes — collection logic, adapters,
normalisation, cache lookup and retry policy are all portable.

**Why ARM when the fleet arrives.** After the June 2026 Hetzner price revision the
CAX (Ampere) line rose ~1.3–1.4x against 2.4–2.75x for shared-AMD CPX and
2.1–2.73x for dedicated CCX. For IO-bound work it is now both cheapest per
concurrent socket and least price-volatile.

**Rate budget.** Configurable collection window and multi-key sharding from day
one, on both runners. At target volume a 12-hour window needs 15.8 req/s — over
the ceiling before retry headroom. Negotiate custom limits at ~500k requests/month.

**Retries.** Exponential backoff, hard attempt cap, dead-letter queue. Every retry
spends money; an unbounded loop is the most expensive bug available.

### services/scorer
Two passes.

**Pass 1 — deterministic (100% of answers, effectively free)**
| Signal | Method |
|---|---|
| Brand mention | Alias table + normalised fuzzy match |
| Citation | URL extraction, domain match against owned set |
| Position | Character offset + structural position |
| Competitor set | Alias match against category registry |
| **Citation source class** | **Taxonomy match on the cited URL — see 4.2** |

**Pass 2 — sampled model (25% of answers)**
Sentiment and framing only. Haiku 4.5 via Batch API (50% off) with a 1-hour prompt
cache on the rubric (cache reads at 0.1× base input). Result: **$0.000291** per
gross answer against $0.003050 naive.

#### 4.2 Citation source classification

~82% of AI citations originate from earned media the customer does not own. A
scorer that only answers "was this our domain?" measures the minority of the
citation surface and cannot tell a customer *where* to act.

Every cited URL is classified into a source class. This is deterministic — URL
pattern plus a maintained publisher registry — so it costs nothing and stays
reproducible.

| Class | Extracted | Why it matters |
|---|---|---|
| `owned` | Domain match against the customer's registered domains | Baseline |
| `video` | Platform, video ID, **timestamp / chapter marker where present** | Video transcripts are among the most-cited multimedia sources; chapter-level citation tells you which segment earned it |
| `community` | Platform, sub-community, thread ID | Reddit / Quora / Stack Overflow — the decentralised-consensus grounding layer |
| `review` | Platform, listing ID | G2, Trustpilot, Capterra — disproportionately trusted by answer engines |
| `earned_media` | Publisher, match against an authority registry | Digital PR placements |
| `competitor` | Alias match against the category registry | A competitor-owned source citing the category |
| `reference` | Wikipedia, Wikidata, standards bodies, gov | Entity-graph anchors |
| `other` | — | Never silently bucketed as `owned` |

The class is stored on the score row, not derived at query time, so the corpus
supports "which source classes cite our category" as a first-class question and
the Category Benchmark Index can report source-mix by vertical.

**Sentiment on community and review sources is sampled separately** from answer
sentiment — a positive answer citing a hostile Reddit thread is a different
finding from a positive answer citing your own docs.

### services/reconcile
Six-factor variance decomposition — see `.claude/skills/reconciliation-formats/`.
Parsers normalise at the boundary; vendor field names never leak inward.

### packages/stats
Pure functions. Wilson intervals, difference-in-differences, sampling design.
Verified against `statsmodels` to 1e-9. **Human-owned.** The most thoroughly tested
code in the repository, because it *is* the product claim.

## 5. Storage layout

| Store | Holds | Rate |
|---|---|---|
| Cloudflare R2 | Raw answer payloads, one object per cell (`prompt × engine × locale × geo × day`, i.e. per cache key) | $0.015/GB-mo, $0 egress, $4.50/M Class A |
| Postgres (Supabase) | Score rows, aggregates, prompt banks, workspaces, accounts | $0.125/GB-mo beyond 8GB + compute |
| Upstash Redis | Cache index, rate budget, job state | usage-based |
| ClickHouse (from ~M22) | CBI corpus, reconciliation variance, percentiles | ~$480/mo |

Batching R2 writes matters: per-answer writes are 20.4M Class A ops/month ($92);
one object per cell is ~4.1M ($18). The batched layout also matches how
reconciliation reads the data back.

## 6. Engine Adapter contract

Every answer surface implements one interface. Application code never calls a
provider directly.

```ts
interface EngineAdapter {
  readonly id: string                 // `${provider}:${engine}`, e.g. 'openwebninja:chatgpt'
  readonly provider: string           // rate-budget bucket, shared across one provider key
  readonly engine: EngineId
  readonly collectionPath: 'official-api' | 'third-party-grounded'  // disclosed publicly
  collect(req: CollectRequest): Promise<RawAnswer>   // one run; never retries internally
  normalise(payload: unknown): AnswerBody            // pure, sync — runs from fixtures
  rateLimit(): { rps: number; burst: number }
}
```

The authoritative definition is `packages/contracts/src/engine-adapter.ts`
(sketch above is illustrative). `normalise` returns only the provider-agnostic
body (`text`, `citations`); `collect` assembles the self-describing `RawAnswer`
(cell, prompt as sent, run, adapter, collection path, timing, `providerCalls`,
verbatim payload).

`collectionPath` is not optional and is not cosmetic. BlipRank publishes, per
engine, whether a surface is collected via an official API or third-party
web-grounded infrastructure. A platform selling methodological transparency cannot
be vague about provenance — and naming it converts a liability into a proof point,
because no competitor does.

**Second provider stubbed before launch.** Single-vendor dependency on scraped
surfaces is the largest technical risk in the plan; a two-week abstraction
investment is cheap insurance.

## 6.5 Hosting map

| Piece | Host | Notes |
|---|---|---|
| `apps/web` | Vercel | ~$70/mo Y1 → ~$320/mo Y3 incl. seats and usage. Rounding error against total tech spend. |
| `apps/public` (Grader, free tools) | Cloudflare Pages | Static asset requests free and unlimited. Vercel would meter bandwidth ($0.15/GB past 1TB) and edge requests ($2/M past 10M) on acquisition traffic. Also isolates a hammerable public tool from the paid product. |
| `services/collector` | Vercel Fluid Compute + QStash → Hetzner CAX | Phased, see 4.1 |
| `services/scorer` | Batch jobs; co-located with the collector runner | Batch API means latency is irrelevant |
| Postgres | Supabase → dedicated Postgres at ~150M score rows | |
| Raw payloads | Cloudflare R2 | Zero egress is the whole point |
| Cache / queue | Upstash | Self-host at ~5M jobs/month |
| Analytics corpus | ClickHouse Cloud from ~M22 | |

**Region.** Choose deliberately — the beachhead is India and GCC, then UK/EU.
Default US-East adds latency to every dashboard load in the primary market. Put a
DPA in place before the first EU customer; it is a five-minute task now and a
procurement blocker later.

**The option not taken.** Self-hosting Next.js on the same Hetzner boxes as the
collectors would consolidate to one vendor with flat cost and no bandwidth
metering. Legitimate, and some teams prefer it. Rejected because it trades preview
deployments, instant rollbacks and zero-config Next.js for ops work — the wrong
economy at ~$320/mo with a three-person team.

## 7. Scaling triggers

| ~When | Trigger | Action |
|---|---|---|
| M8 | Provider spend > $1,500/mo | Move to Mega tier; track effective per-call rate weekly |
| M14 | 500k requests/month | Negotiate custom rate limits — you need headroom by M30 |
| M18–M20 | Sustained collection > ~4 req/s | **Migrate collector runner from Vercel to Hetzner ARM fleet** (ADR-0002) |
| M16 | p95 dashboard query > 800ms | Add read replica |
| M20 | 150M score rows | Move time-series to dedicated Postgres |
| M22 | Index generation > 60s | Introduce ClickHouse |
| M26 | First enterprise security review | Begin SOC 2 Type II |
| Any | Cache hit below model 2 weeks running | **Highest priority.** Strategic, not ops. |

## 8. What must never regress

1. A metric without `{value, ci_low, ci_high, n, algo_version}` reaching a customer.
2. An LLM call replacing a deterministic rule.
3. A code path that can spend outside the scheduler.
4. A query that crosses a workspace boundary.
5. A historical score mutated in place.
6. A cache lookup skipped before a collection call.
