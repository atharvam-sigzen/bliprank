# ADR-0016 — Correctable context: category, competitor set and custom prompts, each as a recorded change of basis

**Status:** Accepted · **Date:** 2026-09-03 · **Phase:** P3
**Relates to:** R1 (deterministic scoring) · R3 (nothing spends outside a
budgeted runner) · R5 (rows are immutable and version-stamped) · R8 (no metric
without its provenance) · ADR-0009 §4 (a category is decided once and kept) ·
ADR-0009 Amendment 3 (promotion moves the bank version) · ADR-0013 (cycles
and the basis-mismatch refusal) · ADR-0006 (one escape hatch, and it leaves a
trail) · CLAUDE.md §4: the competitor set and the prompt banks are scoring
inputs a human owns

## Context

Three things about a domain's measurement are decided by the system and
cannot be changed by the person the number is about. The category is
classified once and `recordCategory` refuses to overwrite it, which is the
stability guarantee ADR-0009 §4 built and every reader relies on. The
competitor set is per category, moves only through the promotion tool, and
cannot be added to by hand. Custom prompts exist in the browser only: the
page that manages them says so in prose, the scan request has no field to
carry them, and no prompt on that list has ever been asked of an engine.

Each of the three is sometimes wrong for a real customer. A domain classified
into the general bank sells ERP. A category's competitor set names an
integration partner as a rival. The prompts a customer actually cares about
are not in the curated bank. The audit of 2026-09-03 found no affordance, no
route, no record field and no ADR for any of the three, and found two
smaller things beside them: the client's list of basis-segment labels was a
hand-maintained mirror of the grader's writer, in a different package, with
no test; and the basis parser recovered two of seven segments.

The audit also found the fact that shapes every design below: **nothing in
the product has an identity.** No accounts, no email gate (PHASES 3.5 is
unbuilt), no domain-ownership check. Every correction here is a write to a
shared store that changes what a number means or what the next cycle costs.
A public endpoint that applied them would let a rival relabel a domain, or
attach fifteen prompts to it that the domain's owner pays for.

## Decision 1 — one basis definition, shared, with a keyed tail

`packages/contracts/src/basis.ts` now holds the shape, the writer
(`formatBasis`), the reader (`parseBasis`), the words (`BASIS_LABELS`) and
the difference line (`basisDifference`). The grader's `comparisonBasisFor`
calls the writer; the public app's `whyNotComparable` calls the difference
function. The positional copy of the labels in the public app is deleted.

The rules the file enforces, and the tests pin:

- **The first seven segments are positional and never reordered.** The four
  basis strings the stored scans and the bundled reference carry are pinned
  byte for byte; `formatBasis(parseBasis(s)) === s` for each.
- **Anything new is a keyed tail segment, appended only when it applies.** A
  measurement with no override and no custom prompts formats exactly as it
  did before. Nothing already stored becomes "not comparable" with its own
  successor by an accident of shape.
- Two tail keys exist: `set=N`, the per-domain competitor override version,
  and `custom=K@V`, a measurement over K custom prompts at stored version V.
- **Canonical or nothing.** `compare()` refuses on the raw string, so two
  strings that differ at all are two bases. The parser accepts a string only
  if writing the result back reproduces it byte for byte; a repeated tail
  key, a tail out of order, a leading zero or an unsorted engine list is
  null. For a string it cannot read (the older four-segment form the store
  once wrote, a hand-edited file) the difference line names both strings
  whole, because labelling segments by position would put the wrong word on
  every one. The grader's `basisOf` keeps its keyed leniency for partial
  strings, as its own tests always required.
- The writer throws on a field containing the separator, the one place the
  string is made.
- A drift test asserts that every key the shape has is written, compared and
  labelled. `BASIS_LABELS` is typed over the shape's keys, so a segment cannot
  be added without its words.

Checked against the store: the four basis strings the stored scans and the
bundled reference carry are pinned byte for byte in `basis.test.ts` and
round-trip through the new writer. (The det-2 row snapshot does not carry the
basis string, so `version-diff` is not evidence for this change; it was run
and flips nothing, which says only that scoring did not move.)

## Decision 2 — a category correction is a new record, never an overwrite, never a re-derivation

- `CategoryRecord` gains `version` (existing records read as 1),
  `superseded` (every previous record, complete, in order) and `correction`
  (who, why, when, and the slug it replaced). One file, one current record per
  host, the history inside it.
- One new writer, `correctCategory`, beside `recordCategory`. It refuses an
  unknown slug, a slug equal to the current one, and a bank absent from this
  build. It never calls the classifier. It keeps `brandName`.
  `recordCategory` is untouched and still refuses to overwrite.
- Downstream, nothing new is needed, because cycle files already name their
  own category and every reader (evidence, gap report, re-score) reads the
  cycle's own: earlier cycles stay readable, the trend drops them, and the
  record says how many sit under the old category and why they do not compare.
  The result cache keys on the recorded slug, so the next scan buys a new
  cycle; the correction surface states that cost, in cells and money, before
  the person confirms, and spends nothing itself.

## Decision 3 — a competitor correction is a per-domain override over the category's set

- Promotion is unchanged: per category, evidence-gated, CLI-only, bumping the
  bank version.
- A per-domain override file carries `exclude`, `include` and its own
  `version`, and is layered on the category's set at scan time.
- **Exclude is always allowed.** It is promotion's exclusion mechanism, per
  domain: "our integration partner, not a rival" without changing what every
  other domain in the category measures.
- **Include is allowed only from reviewed sources**: a leader of any bank
  this build holds, hand-authored or promoted, each with a reviewed alias
  set. Free-text names are refused: a hand-typed name with no alias set
  produces false mentions, and the competitor set decides position, which
  decides the score. Decided by the owner on 2026-09-03. *Amended after the
  step-3 review:* the first wording also admitted "any candidate the
  promotion tally has already produced". It does not. A tally candidate has
  no reviewed alias set and the tally is not a store an override could
  version against; it is included by promoting it first (`grader:promote`),
  so it passes the same bar and the same bump every other rival passed.
- The subject is never in its own override: not by id, and not by a sibling
  bank's leader whose domain is the subject's host or whose name is the
  subject's name.
- Clearing an override is a new version too: the set moved back, and the
  cycles under the old set are not comparable with the ones after.
- A category correction is refused while an override is in force; the
  override was checked against the old category's set and is cleared first.
- The basis gains `set=<override version>` from the first override on. The
  next cycle is not comparable with the last, and the record says "the
  competitor set" changed, which is true.

## Decision 4 — custom prompts are a second measurement, never a change to the first

- A server-side store per domain, versioned, capped to the shared pool the
  pricing page already describes. Validation on write reuses the checks that
  refuse a model-authored prompt: no prompt may name the subject or any
  tracked brand; length-capped; deduplicated; a refusal carries its reason.
- The scan request gains an optional custom prompt list; the cell builder
  takes the bank's prompts and the custom ones as two lists; a custom cell is
  a cell like any other: same cache key, same budget, same ceiling. The
  per-domain ceiling is recomputed from the actual cell count at cycle time.
- Custom prompts score into their own rows and their own metric, with its
  interval and n, on its own basis: the curated string with `unprompted=0`
  and `custom=K@V`. The headline is still computed over the curated prompts
  on the unchanged basis, so the trend survives adding a prompt. Decided by
  the owner on 2026-09-03: merging would change the sample and break every
  trend the moment a prompt is added.

## Decision 5 — request, then apply, until identity exists

Every correction above is filed by the visitor as a request and applied by a
person. The request is stored, throttled like any other visitor write, shown
on the record as "requested on <date>, not yet applied", and never touches the
measurement. An operator command applies it, through the writers above, and
prints the consequences. The request store is the queue the email gate will
feed when it exists (PHASES 3.5). Decided by the owner on 2026-09-03 over the
alternative of blocking P3 on that gate. This is ADR-0006's shape: one escape
hatch, and it leaves a trail.

## What is deliberately not done

- No re-classification on correction, ever. The person chooses from the list.
- No free-text competitor names, and no include from an un-promoted tally
  candidate. No per-domain prompt bank edits beyond the custom list. No
  scheduler. No identity.
- No write to a stored cycle. A correction changes what the next cycle
  measures; it never rewrites what a past one measured (R5).

## Build order, each step reviewed before the next

1. This ADR, the shared basis definition and its drift test.
2. Category correction: record fields, `correctCategory`, the request store
   and route, the operator command, the record surface.
3. Competitor overrides: the file, the reviewed-source rule, the scan-time
   merge, the basis tail, request and apply.
4. Custom prompts: the store and validation, the request path from the
   existing page, the scan request field, cells, ceiling, the second metric
   block, the record surface.
5. Full-suite gate and a real-runner test of one synthetic cycle carrying
   custom prompts and an override, with only the network replaced.

Human-owned areas touched, flagged at each step: the competitor set and the
prompt banks (scoring inputs), the ceiling recomputation (spend control), the
basis shape (provenance). No live spend at any step.
