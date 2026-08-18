---
name: reconciliation-formats
description: Use when building or debugging the Cross-Tool Reconciliation engine — competitor export parsers, variance decomposition, pooled estimates, or the reconciliation report itself. Contains the six-factor framework and what each vendor does and does not disclose.
---

# Cross-Tool Reconciliation

The wedge feature. A customer keeps the tool they already pay for and adds
BlipRank as the audit layer above it. This collapses the hardest objection in a
category with 72 vendors: they do not have to switch to become a customer.

## The framing rule

The report **never** says a competitor is wrong. It decomposes the disagreement.
Two tools measuring different prompt sets from different regions with different
run counts and different definitions of "appearing" *should* disagree — the value
we add is quantifying how much of the gap each factor explains.

## The six factors

| # | Factor | What we compute | Typical share of gap |
|---|---|---|---|
| 1 | Prompt-set divergence | Jaccard overlap of normalised prompt hashes; visibility delta on the non-overlapping subset alone | Usually the largest |
| 2 | Engine mix | Per-engine visibility, so a ChatGPT-only tool's lower number is explained | Large when one tool is single-engine |
| 3 | Geolocation | Outbound region per measurement; re-run our set from their region where known | Large for non-US brands |
| 4 | Run count / sampling | Their disclosed `n`; implied CI width; whether the gap is significant at all | Often makes the gap vanish |
| 5 | Appearance definition | Mention vs linked citation vs positive recommendation, normalised to a common scale | Moderate |
| 6 | Residual | What none of the above explains | **Always state this honestly** |

If factors 1–5 explain less than half the gap, say so. A large unexplained residual
is a real finding, not a failure of the report.

## The pooled estimate

After decomposition, produce a single reconciled figure with a CI, computed on the
union of prompt sets weighted by category relevance, measured across the union of
engines, with `n` pooled. State explicitly what it assumes.

## Vendor disclosure matrix

What each format tells us. Anything not disclosed becomes `undisclosed` — never `0`,
never an inferred default.

| Vendor | Prompt list | Engine mix | Geo | `n` per prompt | Definition |
|---|---|---|---|---|---|
| Peec AI | Usually (CSV export) | Partial — tier-capped to 3 engines | Rarely | No | Mention-based |
| Profound | Partial | Yes | Sometimes | No | Mention + citation |
| Semrush AI Toolkit | No | Partial | No | No | Score 0–100, undocumented |
| Ahrefs Brand Radar | Partial | Per-index | No | No | Mention-based |
| Otterly.ai | Yes | Yes | No | No | Mention + link |
| AthenaHQ | Partial | Yes | No | No | Credit-metered, unclear |

Keep this table current as export formats change. It is also excellent marketing
content — the disclosure gaps are the story.

## Parser rules

1. Work from a real sample export. Never infer a schema from marketing docs.
2. Parser and fixtures land in the same change. No exceptions.
3. Normalise to `ReconcileRecord` at the parser boundary. Vendor field names must
   not leak further into the system.
4. Handle explicitly: missing `n`, percentage vs count, locale number formats
   (`1.234,5` vs `1,234.5`), truncated files, and BOM-prefixed CSVs.
5. Redact customer identifiers before a sample enters `__fixtures__`.

## Legal guardrail

Report only what the customer's own export contains. Frame variance as
methodological difference. Never publish another vendor's data outside the
customer's workspace. Comparative claims in marketing get a legal review before
they ship.
