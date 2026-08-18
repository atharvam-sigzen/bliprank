---
name: measurement-methodology
description: Use when implementing, reviewing, or explaining any measurement or statistical logic in BlipRank — confidence intervals, sampling design, scoring rules, significance testing, or the public methodology page. Also use when a customer-facing number needs to be defended.
---

# BlipRank Measurement Methodology

This is the reference for how BlipRank turns AI answers into defensible numbers.
It is the substance behind the product claim, so it is written to be published.

## The metric contract

Every metric in the system is this shape. There is no other shape.

```ts
type Metric = {
  value: number          // point estimate, 0..1
  ci_low: number         // Wilson lower bound, 95%
  ci_high: number        // Wilson upper bound, 95%
  n: number              // actual runs behind this estimate
  algo_version: string   // e.g. "2.3.1"
  sampled?: string[]     // fields estimated from a sub-sample, e.g. ["sentiment"]
  collected: {
    engines: string[]
    geo: string[]
    window_start: string
    window_end: string
  }
}
```

A function that returns a bare `number` for a customer-visible metric is a bug.

## Why Wilson, not Wald

The normal-approximation (Wald) interval collapses at small `n` and near p=0 or
p=1 — it produces intervals that extend below 0 or above 1, and its coverage is
badly wrong exactly where AI visibility data lives. Most brands in most categories
have a true visibility rate under 0.2, often 0. Many cells have n between 3 and 15.

The Wilson score interval is well-behaved across that whole range.

```
centre = (p̂ + z²/2n) / (1 + z²/n)
spread = (z / (1 + z²/n)) · √( p̂(1-p̂)/n + z²/4n² )
CI     = centre ± spread          (z = 1.959964 for 95%)
```

Verification requirement: the implementation must agree with
`statsmodels.stats.proportion.proportion_confint(method='wilson')` to 1e-9 across
a grid covering n ∈ {1,2,3,5,10,30,100,1000} × p̂ ∈ {0, 0.01, 0.5, 0.99, 1}.

## Sampling design

| Signal | Method | Sample |
|---|---|---|
| Brand mention | Alias table + normalised fuzzy match | 100% |
| Citation / link | URL extraction, domain match against owned set | 100% |
| Position / prominence | Character offset + structural position | 100% |
| Competitor set | Alias match against category registry | 100% |
| Sentiment / framing | Model call (Haiku, batched, cached rubric) | 25% |

Deterministic signals are computed on every run because they are effectively free
and because determinism is the product. Sentiment is the only genuinely
model-dependent judgement, and at n=5 runs per cell a 25% sample gives a usable
estimate at a quarter of the cost.

**Sampled fields must be labelled in the output and in the UI.** Presenting a
25%-sampled sentiment score as if fully measured is a misrepresentation, and it is
precisely what we criticise competitors for.

## Choosing n

Precision depends on the **effective** sample size behind a number, not the raw
count of runs. Two things set it:

1. **How many runs sit behind the reported unit.** A single cell of 5 runs is an
   input, never a reportable number. The Starter unit is brand × engine × cycle
   over a 30-prompt bank at 5 runs per cell: n = 150 nominal.
2. **How independent those runs are.** Wilson assumes iid Bernoulli trials. Runs
   of one prompt against a caching, non-stationary engine are positively
   correlated, and prompts within a brand are clustered. The design effect
   `DEFF = 1 + (m − 1)·ρ` (m = runs per cell, ρ = intra-cell correlation of the
   mention indicator) is what that costs; `n_eff = n / DEFF` is what every
   interval must be computed on.

Wilson 95% intervals at p̂ = 0.25 by effective n. They are asymmetric about p̂ —
quote `[low, high]`, never `±`:

| n_eff | interval at p̂ = 0.25 | (high − low)/2 | meaning |
|---|---|---|---|
| 5 | [0.053, 0.664] | 0.305 | one cell — an input, never reported |
| 15 | [0.099, 0.503] | 0.202 | directional only, do not report movements |
| 50 | [0.151, 0.385] | 0.117 | |
| 100 | [0.175, 0.343] | 0.084 | the Starter unit if DEFF = 1.5 |
| 150 | [0.188, 0.325] | 0.069 | the Starter unit if runs were independent |
| 200 | [0.195, 0.314] | 0.060 | |
| 500 | [0.214, 0.290] | 0.038 | |

**Estimating ρ** — in the P0 pilot, and every cycle after that as a monitor. The
prompt bank is fixed, so between-prompt heterogeneity is a fixed effect: it
cancels in cycle-to-cycle comparisons and only makes a single-cycle Wilson
interval conservative. What makes Wilson anti-conservative is the **day×cell**
component — runs of one cell within a cycle being more alike than runs of that
cell across cycles (caching, per-day engine state). Estimate it from a
re-collection of the same cells on a second day: with kᵢ₁, kᵢ₂ mentions out of m
runs each, `D = Σ(kᵢ₁ − kᵢ₂)² / Σ 2m·p̂ᵢ(1 − p̂ᵢ)·2m/(2m − 1)` (p̂ᵢ pooled over both
days), `E[D] = 1 + (m − 1)·ρ_u`, so **`ρ̂_u = (D − 1)/(m − 1)`**, floored at 0. This
is heterogeneity-free. The single-day one-way ANOVA estimator
`ρ̂ = (MSB − MSW)/(MSB + (m − 1)·MSW)` (with `MSB = m·Σ(p̂ᵢ − p̄)²/(N − 1)`,
`MSW = Σ m·p̂ᵢ(1 − p̂ᵢ)/(N(m − 1))`) includes the fixed cell effect and is an **upper
bound** on ρ_u — report it, never gate on it (with a diverse bank it sits near
0.25 even when runs are independent). The within-day pass-to-pass ratio (first
half of a cell's runs vs the second half, hours apart) is a lower-bound proxy.

Gate G0 requires DEFF = 1 + 4ρ̂_u ≤ 1.5 (ρ̂_u ≤ 0.125) on every engine, so that the
Starter unit's n_eff ≥ 100. If it is higher, nothing is "wrong" — every published
interval uses n_eff and runs-per-tier are re-derived before pricing is fixed.

Confidence Grade is a function of the design, not of the outcome: **A** = n_eff ≥ 200
· **B** = n_eff ≥ 50 · **C** = n_eff ≥ 15 · **D** below that.

## The significance rule

When comparing two periods, compute the interval on the difference. If zero falls
inside it, the UI says **"no significant change"**.

This is non-negotiable and it is uncomfortable in demos, because competitors draw
a green arrow for noise. Drawing that arrow is the thing we exist not to do.

## Known limitations — publish these

Honesty about limits is the differentiator. The public methodology page states:

1. **Non-determinism at temperature zero.** Inference endpoints return varying
   output across runs even with identical inputs. This is why we sample and report
   intervals rather than single observations.
2. **Geolocation dependence.** The same brand measured from different regions
   returns materially different answers. We disclose the outbound region for every
   measurement.
3. **Definitional variance.** "Appearing" can mean a brand mention, a linked
   citation, or a positive recommendation. We measure all three separately and
   never collapse them into one undefined score.
4. **Collection path.** We disclose, per engine, whether a surface is collected via
   an official API or via third-party web-grounded infrastructure. See
   `docs/METHODOLOGY.md` for the current table.
5. **Category drift.** Whole categories move together as models update. Absolute
   scores across long windows are less meaningful than position within the
   category corpus, which is why the Category Benchmark Index exists.

## Causal lift (difference-in-differences)

For "did the optimisation work?", correlation is not acceptable.

- **Treatment set**: prompts/pages being optimised.
- **Control set**: matched on category, baseline visibility band, and engine mix,
  deliberately left untouched.
- **Estimate**: `(treat_post − treat_pre) − (ctrl_post − ctrl_pre)`, with a CI on
  the difference, and category drift from the corpus reported alongside.
- **Never** report a lift without the control arm and the interval.
