# BlipRank Measurement Methodology

> **This page is public and citable.** It is the differentiator, not documentation.
> An audit of 72 AI-visibility tools in August 2026 found 34 assert precision with
> no evidence and only 6 publish a checkable method. This page is why we are in the
> second group.

*Scoring algorithm version: `det-2` · Last updated: 2026-09-02*

---

## What we measure

For a defined set of prompts, in a defined set of engines, from defined regions,
over a defined window, we measure how often and how prominently a brand appears.

Three distinct signals, never collapsed into one undefined score:

| Signal | Definition |
|---|---|
| **Mention** | Brand name (or a registered alias) appears in the answer text |
| **Citation** | A link to a brand-owned domain appears in the answer's references |
| **Prominence** | Where in the answer the first mention falls, as a rank among the brands that answer named |

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
reproducible: the same input produces the same output, every time. No language
model is called anywhere in scoring.

**We do not measure framing or sentiment.** A sampled, model-scored framing
signal is designed (25% of runs, labelled as sampled wherever it appears) and it
is not built. Until it ships, no number on any BlipRank surface describes tone,
and where a sentiment column might be expected the page says that it is absent
rather than leaving a blank that reads as "neutral".

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
   what it costs — and about when the strength we claim actually holds.

   **When the two cycles are measured to similar precision**, two 95% intervals
   failing to overlap is a *stronger* result than the usual "significant at 95%":
   roughly a 1-in-180 chance of arising from noise, rather than 1-in-20. So when
   we report a change on comparable cycles, the evidence behind it is unusually
   strong.

   **When they are not**, that advantage disappears. If one cycle rests on far
   fewer answers than the other, the test degrades toward an ordinary 1-in-20 —
   at 30 answers against 1,000 it is about 1-in-44. We therefore do not report a
   change at all when the two cycles differ too much in precision; you will see
   *not comparable* instead of a number we cannot stand behind.

   The flip side of the conservatism is that a change can be real and we will
   still call it *no significant change*, because the test is not sensitive
   enough to resolve it. At 150 answers per cycle we would detect a 25%→30% move
   only about 3.5% of the time, and reliably detecting a 5-point move needs
   roughly 2,000 answers per cycle. We would rather tell you nothing happened
   when something did, than tell you something happened when it did not.

   Three consequences you should hold us to. First, "no significant change"
   means *we cannot distinguish these two measurements*, not *your visibility is
   flat* — the honest reading is that the sample was too small to tell, and the
   numbers above say how much larger it would need to be. Second, a comparison
   is only ever between like and like: if the engines measured, the locale, the
   geography, the prompt bank or the window length changed between cycles, we
   report *not comparable* rather than a movement, because a change in what we
   measured is not a change in how you performed. Third, this is not the
   sharpest available test — the correct one estimates the difference itself and
   puts an interval around that. We are building it as part of the
   causal-experiment work, and when it ships we will report both, note where
   they disagree, and change this page.

## Changelog

The version is the identifier stamped on every score row and printed beside
every number as `algo`. Earlier revisions of this page carried a `0.1.0` that
was never stamped on anything; the stamped identifier is the one that counts.

| Version | Date | Change | Effect on historical comparison |
|---|---|---|---|
| det-1 | 2026-08-22 | Deterministic scorer: mention, citation, prominence, competitor detection, citation source class | n/a |
| det-2 | 2026-09-01 | Brand forms are also derived from a domain that runs its words together, with the site title as corroboration; a compound-named brand had scored zero | A brand's rate can differ between versions; `compare()` refuses to compare rows stamped differently, and a result re-derived from stored answers keeps its det-1 row as an audit file |

Historical scores are never recomputed. When the algorithm changes, new rows are
written and charts show a version boundary.
