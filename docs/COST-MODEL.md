# BlipRank — Cost Model Reference

Used by `/cost-audit` to reconcile projected against actual. Rates verified 17 Aug 2026.

## Per-tier measurement volume

`queries/month = prompts × engines × runs × cycles`

| Tier | Prompts | Engines | Runs | Cycles | Queries/mo | Eff. ARPA |
|---|---|---|---|---|---|---|
| Starter | 50 | 3 | 5 | 4 | 3,000 | $45.57 |
| Growth | 200 | 4 | 3 | 4 | 9,600 | $185.07 |
| Agency | 750 | 4 | 3 | 4 | 36,000 | $464.07 |
| Enterprise | 2,500 | 5 | 3 | 4 | 150,000 | $1,395.00 |

## Unit rates

| Line | Rate |
|---|---|
| OpenWeb Ninja AI Answers (Mega marginal) | $0.002 / call |
| SERP / AI Overviews enrichment | 15% of gross volume × $0.002 |
| LLM scoring, **deterministic-first + 25% sample, batch + cache** | **$0.000291 / gross answer** |
| LLM scoring, naive (for contrast — do not build this) | $0.003050 / answer |
| Content generation (Sonnet 5) | $3.50 Growth · $9.00 Agency · $22.00 Ent per account/mo |
| R2 storage | $0.015 / GB-month, $0 egress |
| R2 Class A (batched writes) | $4.50 / million |
| Payment processing | 2.9% + $0.30 |

## Cache hit rate — the governing assumption

| Period | Modelled |
|---|---|
| Year 1 | 25% |
| Year 2 | 45% |
| Year 3 | 60% |

**This is an assumption, not an observation.** Instrument it from the first
collected answer. Two consecutive weeks below model is a strategic escalation, not
an ops ticket — it drives both gross margin and the benchmark corpus.

## Targets

| Metric | Y1 | Y2 | Y3 |
|---|---|---|---|
| Gross margin | ~78.5% | ~83% | ~86% |
| Tech spend as % of revenue | 17.9% | 13.6% | 11.1% |
| Tech cost / customer / month | $27.29 | $26.84 | $26.35 |

## Fixed platform cost by stage

| Stage | Months | Customers | Collection runner | Fixed/mo |
|---|---|---|---|---|
| 1 Build | 1–4 | 0–35 | Vercel Fluid Compute + QStash | $106 |
| 2 Launch | 5–12 | →444 | Vercel Fluid Compute + QStash | $508 |
| 3 Scale | 13–24 | →1,729 | Migrate to Hetzner ARM at ~M18 | $1,940 |
| 4 Consolidate | 25–36 | →3,389 | Hetzner ARM fleet | $4,250 |

## Hosting cost by tier

| Piece | Host | Y1 | Y3 |
|---|---|---|---|
| `apps/web` | Vercel | ~$70/mo | ~$320/mo |
| `apps/public` (Grader) | Vercel (ADR-0002 Amendment 1) | $0 Hobby / $20 Pro seat | not re-estimated; revisit with measured traffic |
| Collector runner | Vercel → Hetzner CAX | included in app tier | ~$320/mo |

Vercel is not where this project's money goes — at M36 it is ~0.4% of $89K/mo
total tech spend. Do not economise here.

## Throughput ceiling

| | M12 | M24 | M36 |
|---|---|---|---|
| Billable calls/month | 3.49M | 12.27M | 20.37M |
| Sustained req/s (24h window) | 1.3 | 4.7 | 7.9 |
| Sustained req/s (12h window) | 2.6 | 9.4 | **15.8** |
| Provider ceiling (Mega) | 15 | 15 | **15** |

A 12-hour window exceeds the published ceiling by M36 before retry headroom.
Open the custom-rate conversation at ~M14.

**~4 req/s is also the collector runner migration trigger** — see ADR-0002. Past
that point the global rate budget cannot be held sanely on auto-scaling ephemeral
instances.
