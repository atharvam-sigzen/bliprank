# ADR-0008 — A demo-scoped category taxonomy, deletable in one move

**Status:** Accepted · **Date:** 2026-08-24 · **Phase:** P3 (demo enablement only)
**Scope:** DEMO-SCOPED / PROVISIONAL. **This is not the production taxonomy decision.**
**Relates to:** PHASES 3.1, 3.2 · R6 (cache key) · `/category-bank`

## Context

The 2026-08-24 scoping report on PHASES 3.1 found that the category classifier
could not be built as specified, for one reason: **its output space did not
exist.** No taxonomy, no vocabulary, no granularity decision, no labelled set,
and two of the three named input signals (autocomplete, contacts enrichment)
with no provider, no key and no cost line anywhere in the repo.

That report asked four questions and they remain open. **This ADR answers none
of them.** It creates a small, hand-authored taxonomy for the sole purpose of
getting the application demo-able end to end on one machine, and it is built so
that adopting the real answer later costs a deletion rather than a migration.

The production taxonomy decision — where the vocabulary comes from, what
granularity 200 banks implies, and what the ≥95% G3 criterion is measured
against — stays open and is unaffected by anything here.

## Decision

### 1. Eight categories, hand-authored, demo-scoped

| Slug | Why it is in a demo set |
|---|---|
| `crm-software` | Already the P0 pilot bank's category. Keeps continuity with the only real collection this project has attempted. |
| `project-management-software` | Dense, well-known leader set; the category most demo audiences can sanity-check from memory. |
| `email-marketing-software` | Marketing buyer — the ICP the Grader is aimed at. |
| `accounting-software` | Strong non-US leader spread (Xero, Zoho Books, Tally), which exercises the geo decision below. |
| `web-hosting` | High-volume AI query surface, and a category where citation sources are dominated by earned media — the ADR-0005 story. |
| `password-managers` | The one consumer-leaning category. Guards against a taxonomy that only works for B2B SaaS. |
| `hr-payroll-software` | India-relevant leaders (Keka, greytHR) for the beachhead market. |
| `ecommerce-platforms` | Shopify/WooCommerce is the most recognisable head-to-head available. |

Eight rather than five because the classifier needs enough categories for an
ambiguous case to be real (Zoho leads three of them), and rather than ten because
every category is a hand-authored bank that has to be maintained until it is
deleted.

### 2. The slug carries no geo. Geo stays in its own column.

The scoping report found the repo contradicting itself: `prompt_banks` is
`UNIQUE(category, locale, geo, version)` — geo is a column — while
`/category-bank`'s own argument hint is `india-d2c-skincare in`, which puts the
country in the slug *and* passes it separately.

**Resolved for these entries: the slug is geo-free.** `accounting-software`, never
`india-accounting-software`.

The deciding argument is R6, not tidiness. The cache key already carries geo as
its own field, so a geo-bearing slug would fragment one vertical into N banks
whose prompts normalise identically — the same prompt text collected once per
slug variant, each into a different cell, with no cache hit between them. That
is the margin lever spending itself on a naming convention. It is also
un-retrofittable: R6 says the key shape does not change without an ADR, and by
the time 200 banks exist the fragmentation is baked into the corpus.

A vertical that genuinely differs by market — Indian payroll compliance is not US
payroll — is a **different prompt set under the same slug at a different geo**,
which is exactly what the `(category, locale, geo, version)` key expresses.

`/category-bank`'s argument hint contradicts this and is left untouched: it is a
production artefact and correcting it belongs with the production taxonomy
decision, not with a demo ADR. Flagged, not fixed.

### 3. The classifier is deterministic, and it refuses rather than guesses

No model call on any path. The reason is not R1's cost argument, which would be
weak here — a Haiku classification is ~$0.0002 against a $0.18 scan. It is that
**the category decides which prompt bank runs, which decides `comparison_basis`.**
A non-deterministic classifier lets the same domain land in different banks on
different days, so the thing a number is a measurement *of* changes underneath
the customer — precisely the change `compare()` exists to refuse. Determinism on
this path is load-bearing for the metric contract, not a style preference.

Two signals, both offline:

1. **Leader-domain match** — the domain is a known leader in a demo bank. Exact
   apex match plus subdomains.
2. **Domain-label token match** — a hyphen or dot delimited token in the label is
   a category keyword (`my-crm.io` → `crm-software`).

Concatenated labels are deliberately **not** segmented. `mycrm.com` returns
unclassified. Substring matching is how `compass.com` becomes a password manager
and `chronos.io` becomes an HR product, and the scorer already learned this
lesson — its aliases are whole-token for the same reason. A conservative miss is
recoverable; a confident wrong category silently mislabels every number
downstream.

**Three outcomes, and the last two are not failures:**

- `classified` — one category, with the signal that fired recorded.
- `ambiguous` — more than one category matched. Zoho leads CRM, accounting and
  HR; Microsoft and Adobe are the same shape. The classifier returns the
  candidates and the caller asks. It does **not** rank them.
- `unclassified` — nothing matched, with a reason.

There is no default category and no fallback. A fallback would be a silent
`comparison_basis` change wearing a helpful face, and it is the same mistake
ADR-0005 refuses when it forbids bucketing an unknown citation as `owned`.

**The three signals PHASES 3.1 actually names — site content, autocomplete,
contacts enrichment — are all unimplemented**, because all three require network
calls and two have no provider anywhere in the repo. Their absence is what makes
`unclassified` common rather than rare, and the Grader says so on the page rather
than papering over it. Site content in particular is a server-side fetch of a
user-supplied domain and carries an SSRF surface that needs its own design.

### 4. Demo artefacts live together so they can be deleted together

The banks live at `packages/taxonomy/banks/*.json`, not at the
`packages/db/seed/banks/` path `/category-bank` specifies for production banks.

That is deliberate. The value of a demo-scoped decision is that adopting the real
one is a deletion, and artefacts scattered into the production seed path are
artefacts nobody will dare delete. One directory, one package, one `rm`.

Leader sets are marked `"verified": false` in every bank. `/category-bank`'s
standing rule is *"Do not invent competitor names. Derive them from actual
collected answers or from a verifiable source, and mark any that are
unverified."* These were hand-authored against general knowledge with no
collected answer behind them, which is exactly the case that rule covers.

## Consequences

- The application becomes demo-able end to end on one machine: a real domain
  classifies to a real category with a real prompt bank behind it.
- **Every number produced under this taxonomy is demo data, not a measurement.**
  Nothing here has been collected, and the leader sets are unverified.
- `crm-software` now exists twice — as the P0 pilot bank
  (`services/collector/pilot/bank.json`, 100 prompts, en-US/US) and as a demo
  bank. They must be reconciled before either is used for a real cycle, or the
  same category will collect two different prompt sets. **Flagged, not resolved.**
- Adopting a production taxonomy invalidates every bank here. That is the
  intended cost and the reason for §4.
- The classifier's accuracy is not measured. G3 wants ≥95% over 100 random real
  domains and no labelled set exists, so that criterion remains `NOT RUN`.

## Rejected alternatives

**Use a standard taxonomy (NAICS, GICS, IAB) now.** The right answer for
production and the wrong one for a demo: those taxonomies are organised around
what a company *is*, and prompt banks are organised around what a buyer *asks*.
"Best CRM for a 10-person team" does not map to a NAICS code. Choosing between
them is the open decision and it should not be pre-empted by a demo.

**Put the demo slugs in the database with a CHECK constraint.** Would need a
migration in `packages/db`, which is HUMAN-OWNED and triggers the R7 RLS suite
on every change — a real cost for a set of strings that exists to be deleted.

**Let the classifier fall back to the largest category.** Rejected above. A
fallback is a silent `comparison_basis` change.

**Build 3.1 before 3.2.** The data dependency runs the other way: the classifier
classifies *into* the set of categories the banks define. Both were authored
together here, and the production ordering should be taxonomy → banks →
classifier.

---

## Amendment 1 — the fallback, and the spend guard it cost (2026-08-25)

**Status:** Accepted · Supersedes §3's "no default category" rule.

### What changed

The original decision was explicit: *"There is no default category and no
fallback: a fallback would be a silent `comparison_basis` change wearing a
helpful face."* That is now overridden on an explicit instruction, so that a
demo visitor typing any real domain gets a measurement rather than a dead end.

1. **Six categories added** — help desk, website builders, analytics, SEO tools,
   video conferencing, e-signature. Fourteen in total, each with a full bank.
2. **A fallback category**, `general-business-software`, with **no leaders and no
   keywords**. It cannot be matched *into*; it can only be fallen *back* to.
3. **The classifier is unchanged.** It still answers `unclassified` or
   `ambiguous` honestly. `services/grader/src/scan.ts` decides to scan anyway.
   Keeping the decision at the caller is what stops a helpful guess from
   overwriting the classifier's real answer.

### Why the fallback is not the thing §3 refused

§3's objection was to a **silent** basis change. This one is loud in three ways,
two of them structural rather than remembered:

- `comparisonBasisFor` stamps `general-business-software@1`, so `compare()`
  refuses to rank a fallback number against a category number. Nobody polices it.
- The bank has **no leaders**, so there is no competitor set and no ranking. We
  do not know the category, so we do not know the rivals, and inventing them is
  what `/category-bank`'s do-not-invent rule forbids.
- The result carries a `fallback` field with the reason, and the page states it.

Ambiguity is carried, not flattened: `zoho.com` leads three categories and the
result says which three, rather than collapsing to "we could not place you".

### ⚠️ What this cost — a real spend guard

`runScan`'s PROPERTY 1 used to be **"a domain that does not classify never
spends"**: no category meant no bank meant no cell meant no provider call. That
was the guard actually protecting spend, and it is now gone. An uncategorised
domain costs a full scan.

Two things were put in its place, because `normaliseHost` accepts `report.pdf`:

- `looksLikeFilename` — a deny-list of file extensions. **Known cost:** `.zip`
  and `.mov` are real gTLDs and are refused. Deliberate: a genuine `x.zip` is
  vanishingly rare, a pasted archive name is not, and a refusal is recoverable
  while a spend is not.
- The host-shape check, keyed off `normaliseHost` rather than off a message
  string, so rewording cannot open the path.

**The remaining exposure is real and accepted:** any well-formed domain now
spends. There is no confirmation step, by instruction. The provider quota and
`live-gate` are the only things between a typo and a scan.
