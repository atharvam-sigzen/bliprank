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
6. **Our "no significant change" is stricter than it sounds — we will miss some
   real changes.** When we compare this cycle against the last, we do not compare
   the two headline percentages. We check whether their confidence intervals
   overlap. If they do, we say *no significant change*, even when the two numbers
   look different.

   That test is deliberately conservative, and it is worth being precise about
   what it costs. Two 95% intervals failing to overlap is a **stronger** result
   than the usual "statistically significant at 95%" — it corresponds to roughly
   a 1-in-160 chance rather than 1-in-20. So when we do report a change, the
   evidence behind it is unusually strong. The flip side is that a change can be
   real and we will still call it *no significant change*, because our test is
   not sensitive enough to resolve it. We would rather tell you nothing happened
   when something did, than tell you something happened when it did not.

   Two consequences you should hold us to. First, "no significant change" means
   *we cannot distinguish these two measurements*, not *your visibility is flat* —
   the honest reading is that the sample was too small to tell, and more runs per
   cycle would resolve it. Second, this is not the sharpest available test: the
   correct one estimates the difference itself and puts an interval around that.
   We are building it as part of the causal-experiment work, and when it ships
   we will report both, note where they disagree, and change this page.

## Changelog

| Version | Date | Change | Effect on historical comparison |
|---|---|---|---|
| 0.1.0 | [DATE] | Initial release | n/a |

Historical scores are never recomputed. When the algorithm changes, new rows are
written and charts show a version boundary.
