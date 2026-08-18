# BlipRank Measurement Methodology

> **This page is public and citable.** It is the differentiator, not documentation.
> An audit of 72 AI-visibility tools in August 2026 found 34 assert precision with
> no evidence and only 6 publish a checkable method. This page is why we are in the
> second group.

*Scoring algorithm version: `0.1.0` · Last updated: [DATE]*

---

## What we measure

For a defined set of prompts, in a defined set of engines, from defined regions,
over a defined window, we measure how often and how prominently a brand appears.

Four distinct signals, never collapsed into one undefined score:

| Signal | Definition |
|---|---|
| **Mention** | Brand name (or a registered alias) appears in the answer text |
| **Citation** | A link to a brand-owned domain appears in the answer's references |
| **Prominence** | Where in the answer the first mention falls |
| **Framing** | Whether the mention is positive, neutral or negative |

## How we report

Every number carries: the point estimate, a **Wilson 95% confidence interval**, the
**sample size `n`**, the **scoring algorithm version**, and the collection context
(engines, regions, window).

We use Wilson rather than the normal-approximation interval because the latter
fails at small `n` and near 0 or 1 — which is where most brands in most categories
actually sit.

**If a change between periods falls inside the interval, we report "no significant
change".** We do not draw an arrow for noise.

## Sampling

Mention, citation, prominence and competitor detection are computed on **100%** of
runs using deterministic rules — alias matching and URL extraction. They are
reproducible: the same input produces the same output, every time.

Framing is estimated on a **25% sample** using a language model, because no rule
expresses it well. Sampled fields are labelled as sampled everywhere they appear.

## Collection paths — disclosed

| Engine | Collection path |
|---|---|
| Google AI Overviews | `third-party-grounded` — OpenWeb Ninja AI Answers API (third-party web-grounded infrastructure) |
| Google AI Mode | `third-party-grounded` — OpenWeb Ninja AI Answers API (third-party web-grounded infrastructure) |
| ChatGPT | `third-party-grounded` — OpenWeb Ninja AI Answers API (third-party web-grounded infrastructure) |
| Google Gemini | `third-party-grounded` — OpenWeb Ninja AI Answers API (third-party web-grounded infrastructure) |
| Microsoft Copilot | `third-party-grounded` — OpenWeb Ninja AI Answers API (third-party web-grounded infrastructure) |

We state, per engine, whether a surface is collected via an official API or via
third-party web-grounded infrastructure. Most of this category does not disclose
this. We think that is the wrong choice, and we would rather be asked hard
questions than avoid them.

## Known limitations

1. **Non-determinism.** Inference endpoints return varying output across runs even
   at temperature zero. This is why we sample and publish intervals.
2. **Geolocation.** The same brand measured from different regions genuinely
   differs. We disclose outbound region per measurement.
3. **Definitional variance.** "Appearing" is ambiguous across the industry. We
   measure the components separately.
4. **Category drift.** Whole categories move as models update. Position within the
   category corpus is more meaningful over long windows than an absolute score.
5. **Coverage.** Our prompt banks are constructed, not exhaustive. A brand can be
   visible on queries we do not measure.

## Changelog

| Version | Date | Change | Effect on historical comparison |
|---|---|---|---|
| 0.1.0 | [DATE] | Initial release | n/a |

Historical scores are never recomputed. When the algorithm changes, new rows are
written and charts show a version boundary.
