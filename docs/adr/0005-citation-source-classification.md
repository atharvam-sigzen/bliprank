# ADR-0005 — Citation source classification

**Status:** Accepted · **Date:** 2026-08-20 · **Phase:** P1/P2
**Source:** adopted from the v2 strategy addon (Search Everywhere Optimization synthesis)

## Context

The v1 scorer answers one question about a cited URL: *is this our domain?* That
is the right primitive and it is not enough.

Roughly 82% of AI citations originate from **earned media the customer does not
own** — community threads, video transcripts, review platforms, digital PR
placements, reference sources. A scorer that only distinguishes owned from
not-owned measures the minority of the citation surface, and more importantly it
cannot tell a customer *where to act*. "You appear in 23% of answers" is a
diagnosis. "You appear in 23% of answers, and 61% of the citations in your
category come from four subreddits and two YouTube channels you have never
engaged with" is a plan.

The v2 addon also observes that answer engines parse structured video transcripts
at chapter granularity, which means a citation can be attributed to a *segment*,
not just a video.

## Decision

Every cited URL is classified into a source class during the **deterministic**
scoring pass. URL pattern matching plus a maintained publisher registry — no model
call, no cost, fully reproducible.

| Class | Extracted alongside |
|---|---|
| `owned` | — (domain match against registered customer domains) |
| `video` | platform, video ID, **timestamp / chapter marker where present** |
| `community` | platform, sub-community, thread ID |
| `review` | platform, listing ID |
| `earned_media` | publisher, authority-registry match |
| `competitor` | matched competitor alias |
| `reference` | source type (Wikipedia, Wikidata, standards body, government) |
| `other` | — |

Three constraints:

1. **The class is stored on the score row**, not derived at query time. The corpus
   must answer "which source classes cite this category" as a first-class query,
   and the Category Benchmark Index reports source-mix by vertical.
2. **`other` is never silently reclassified.** An unrecognised URL is `other`. A
   classifier that quietly buckets unknowns as `owned` inflates the customer's
   number, which is the exact failure mode this product exists to criticise.
3. **Cited-source sentiment is sampled separately from answer sentiment.** A
   positive answer citing a hostile community thread is a materially different
   finding from a positive answer citing the customer's own documentation, and
   collapsing them loses the signal that matters most for earned-media strategy.

`EngineAdapter.normalise()` must therefore preserve full citation metadata. An
adapter that flattens citations to top-level domains destroys this at the
boundary and cannot be recovered downstream.

## Consequences

**Positive.** The Autopilot earned-media layer becomes buildable — the target list
in P5.5b is derived from real observed citations rather than guesswork. The
Category Benchmark Index gains a source-mix dimension that no competitor publishes.
Costs nothing: it runs in the deterministic pass.

**Negative.** The publisher authority registry is a maintained asset and will drift
without ownership. Adapter normalisation gets more complex, and every existing
fixture set needs regenerating with full citation payloads. Classification
accuracy needs its own golden-set criterion (G2: ≥97% agreement, 0% silent
`owned`), which is additional labelling work.

**Rejected alternative.** Classifying at query time from the stored URL. Cheaper to
build, but it makes corpus-wide source-mix queries expensive and means historical
rows silently change class whenever the registry updates — a violation of rule R5.
