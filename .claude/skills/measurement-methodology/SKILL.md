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

The interval width you can promise depends on runs per cell:

| n per cell | Approx. 95% CI half-width at p̂≈0.25 |
|---|---|
| 3 | ±0.24 — directional only, do not report movements |
| 5 | ±0.19 — the Starter default |
| 10 | ±0.14 |
| 30 | ±0.09 |
| 150 | ±0.04 — the Confidence Grade A threshold |

Confidence Grade: **A** = n≥200 and half-width <0.04 · **B** = n≥50 ·
**C** = n≥15 · **D** below that.

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
