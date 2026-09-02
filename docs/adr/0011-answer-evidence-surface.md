# ADR-0011 — The answers are the evidence, and the evidence is inspectable

**Status:** Accepted · **Date:** 2026-09-02 · **Phase:** P3
**Relates to:** R1 (deterministic scoring) · R3 (spend control) · R4 (raw payloads
stay out of Postgres) · R8 (provenance travels with the number) · ADR-0002
(hosting topology) · ADR-0003 (cache key / R2 object unit)

## Context

`promptRows` (2026-09-02) made the derivation inspectable: for each of the 85
answers behind pipedrive.com's 44.7%, which question, which engine, mentioned or
not, at what position. That is a real improvement over one aggregate rate, and it
is still **a derived statistic**. A reader is being asked to trust the instrument
that produced it.

The instrument has been wrong. `thecosmicbyte.com` was published as mentioned in
**0 of 50** answers while the engines wrote "Cosmic Byte" 139 times across 31 of
them — a false zero caused by an alias table, invisible on every screen the
product had. Nothing on a sheet of derived numbers could have surfaced it. The
person best placed to notice was the brand owner, and they had nothing to notice
it with.

Meanwhile the raw answer text was on disk the whole time, one object per cell,
exactly where ADR-0003 put it.

## Decision

**Every tested prompt is openable, and opening it shows the answer text verbatim.**

### 1. Verbatim, whole, and including the misses

No excerpt, no summary, no "relevant portion", no highlight of where the matcher
matched.

An excerpt is us choosing which part of the evidence a reader sees, which is the
one thing evidence may not be subjected to. The answers that do **not** name the
brand are exactly as load-bearing as the ones that do — they are the denominator.

**Highlighting is refused for a specific reason.** Marking the match would mean
running a matcher in the browser over the *raw* text, while the real one runs
over a normalised form with URL masking and whole-token boundaries. The two would
disagree eventually, and a highlight contradicting the verdict beside it teaches
a reader that the evidence and the number are two different things. `ctrl-F` is
exactly as good and cannot drift.

Which means this is also **how the instrument gets caught**. A reader who finds
their brand in an answer we scored as a miss has found a false zero. That is the
point: it is the only check on this instrument that does not come from us.

### 2. An absent answer is not a silent one

Measured on the committed corpus: **5 of 360 stored answers hold `status: OK` and
no text at all, every one of them from `google-ai-overviews`** — Google showed no
AI Overview for that query. Two are inside pipedrive.com's published sample,
where the scorer counts them as answers in which the brand was not mentioned:

| | |
|---|---|
| published | 38/85 = **44.71%** |
| if absent overviews were not counted as non-mentions | 38/83 = **45.78%** |

The difference is inside the interval and changes no conclusion. The **semantics**
are wrong regardless: "the AI answered and did not name you" and "there was no AI
answer" are different facts, and only one of them is true.

⚠️ **Whether an absent overview belongs in the denominator is a scoring rule and
therefore human-owned (CLAUDE.md §4). Nothing here changes it.** What this ADR
decides is that it may not hide: an empty answer is carried with `empty: true`
and the surface says "this engine returned no answer at all", next to the count
it is still part of.

### 3. A separate artefact, fetched on request — not part of the result

Measured: one scan's answer text is **200,311 characters — 191 KB raw, 70 KB
gzipped**, against **2.5 KB gzipped** for the entire result file. Three places it
could have gone, and why it went where it did:

- **Inside `ScanResultFile`** — rejected. The result travels through
  `localStorage` via `rememberScan`, which keeps every scan a browser has run and
  swallows a quota failure by design. 191 KB per scan against a ~5 MB quota
  starts silently failing to remember scans that cost real money at around
  twenty-five of them, and the symptom is "your scan is gone".
- **A dynamic `import()` of a committed JSON** — measured to work: webpack emitted
  a 221 KB chunk on no page's critical path. Not shipped, for the reasons below.
- **A static asset under `public/`, fetched at runtime** — shipped.

ADR-0002 puts this app on Cloudflare Pages *specifically because static asset
requests there are free and unlimited*. A JSON file is one of those; a 221 KB JS
chunk is not — it is JavaScript, parsed by the JS engine, to produce an object
the JSON parser would have produced faster. It also collapses two mechanisms into
one (both sources are a fetch), and takes the bundler out of a decision that a
config change or a version bump could quietly alter.

Two sources, one function:

| Scan | Evidence from | Works on |
|---|---|---|
| the committed reference scan | `/scan-answers.json`, a static asset | static export **and** local demo |
| one this browser collected | `/api/answers?domain=…` | local demo only |

A static export has no route handlers, so a session scan's evidence 404s there —
and the client reports that as a fact about the deployment, not about the scan.

### 4. The basis is checked before a single answer is shown

`comparison_basis` identifies the sample: engines, locale, geo, category *and
version*, prompt count, runs. If the evidence file's basis is not the result's
basis, these are the answers to a different measurement — a different prompt
count, or a category whose competitor set has since moved from `@1` to `@2`
(ADR-0009 Amendment 3) — and showing them under this number would be worse than
showing nothing, because a reader checking our arithmetic would be checking it
against the wrong input.

An evidence file recording **no** basis is refused rather than accepted. Absence
is the honest state for a missing cost; it is not the honest state here, where
the entire claim is that these answers produced these numbers.

### 5. The route spends nothing and can collect nothing

`/api/answers` reads the blob store off disk for a domain this machine has
already scanned. No adapter, no key, no budget, no path to OpenWeb Ninja — so R3
does not govern it and no flag gates it. It has no rate limit, and that is
reasoned rather than forgotten: `/api/preview` has one because it makes an
outbound fetch to a caller-named host, which is an amplifier. This makes none.
**If it ever grows a path that leaves the machine, that reasoning expires with
it.**

Nothing from the request reaches a path segment: the caller supplies a domain,
which is normalised and host-shape checked, and every path is then built from the
recorded category's own bank and the cache keys that follow from it.

## Consequences

**Good.**

- Every number on the page is now traceable to the text it was counted from, by
  the customer, without asking us.
- The class of defect that produced the `thecosmicbyte` false zero becomes
  detectable by the person most motivated to detect it.
- R4 is unchanged and reinforced: raw payloads stay in the blob store, and this
  reads them rather than copying them into a row.

**Costs, accepted.**

- **The committed artefact is 223 KB in the repository.** It is one file, it
  compresses to 70 KB on the wire, and it is fetched only on a click.
- **It can go stale.** Re-run `pnpm grader:answers` when a scan's basis changes.
  Staleness is safe rather than silent: `belongsTo` refuses a mismatched file and
  the surface says why.
- **Only the reference scan's evidence works on a static export.** A session
  scan's answers live on the machine that collected them, which is also the only
  machine where a live scan can happen at all.
- **The empty-answer semantics are unresolved**, deliberately, and now visible on
  the sheet rather than buried in a denominator.

## Open, and a human's

⚠️ **HUMAN REVIEW REQUIRED — does an absent AI Overview belong in `n`?** Three
defensible answers: keep counting it as a non-mention (today's behaviour), drop
it from the denominator, or report it as a third outcome beside mentioned and
not-mentioned. Each changes what a published rate means, so each is a scoring
rule change with the version bump that implies. It affects 2 of 85 answers in the
one sample where it occurs, so nothing is urgent — but it should be decided
before the number is defended to a customer rather than after.
