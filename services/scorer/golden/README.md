# Golden set — how to label

PHASES.md 2.5. Target: **300–500 hand-labelled answers**. Currently **7 seed
cases**, so the G2 thresholds report `NOT_RUN`, not `PASS`.

Gate G2 asks for ≥ 95% deterministic agreement, ≥ 97% citation-class agreement,
and **0% silently bucketed as `owned`**. The harness in `src/golden.ts` computes
all three, but deliberately refuses to return a verdict below the target set
size: agreement over a dozen answers is noise wearing a gate's clothes.

## One file per answer

`answers/<id>.json`, matching the `GoldenCase` type in `src/golden.ts`.

| Field | What goes in it |
|---|---|
| `id` | `gNNN-short-slug`. Stable forever — a disagreement gets discussed by id. |
| `covers` | **Required by the test suite.** The edge this case exists to pin. If you cannot name one, the set does not need the case. |
| `source` | Engine, and where the text came from. A disputed label has to be traceable. |
| `answer` | `{ text, citations[] }` exactly as `EngineAdapter.normalise()` would emit it, including citation `meta` where the provider supplied it. |
| `brand` / `competitors` | Alias tables and owned domains. Aliases are forms a human would actually write, never substring fragments. |
| `label` | What a human says is correct. |

## Labelling rules

These are the ones that decide the awkward cases. Follow them exactly, because
the harness treats a label as ground truth and will report the *scorer* as wrong.

1. **A link is not a mention.** If the brand name appears only inside a URL,
   `mentioned` is `false` and `cited` is `true`. Counting the link as prose
   double-counts against the citation signal and inflates mention rate on
   engines that inline their sources.
2. **`position` is a rank, not an offset.** 1-based among *all* brands detected
   in the answer — subject plus competitors — ordered by first appearance.
   `null` when the subject is absent. Never label a position for an unmentioned
   brand; the validator rejects it.
3. **Whole tokens only.** "HubSpotters" is not a mention of HubSpot.
4. **`competitorsMentioned` is ordered by first appearance**, not alphabetically
   and not in the order you happened to list the competitor set.
5. **Label `other` when it is `other`.** An unrecognised domain is `other`, even
   when you personally know who runs it. If it should be `earned_media`, the fix
   is to add the domain to the publisher registry — not to label around the gap.
   A classifier that quietly promotes unknowns to `owned` inflates the
   customer's own number, which is the exact failure this product criticises
   (ADR-0005 §2).
6. **Only label citations you are sure about.** An unlabelled citation position
   is skipped by the harness rather than counted as a miss.

## Running it

```bash
pnpm vitest run services/scorer/src/golden.test.ts
```

The suite fails if any case is structurally invalid, if any labelled field
disagrees with the scorer, or if anything a human labelled otherwise came back
`owned`. It does **not** fail for being below target size — it reports
`NOT_RUN`.

## What this set still needs

The seed cases cover mention/absence, URL masking, source-mix classification,
unknown-is-`other`, position ranking and token boundaries. Not yet covered, and
worth prioritising when real answers are available:

- non-English answers, and transliterated brand names
- answers where the brand is mentioned only in a list or table
- engines that emit no citations at all
- brand names that are ordinary words in context
- competitor aliases that collide with each other
- citation metadata from each of the five surfaces, in their own dialects

Those need **real collected answers**, which need G0 to pass first. The seed set
is hand-built on purpose so the harness is exercised before any data exists.
