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

1. This ADR, the shared basis definition and its drift test. **Landed 2026-09-03.**
2. Category correction: record fields, `correctCategory`, the request store
   and route, the operator command, the record surface. **Landed 2026-09-03.**
3. Competitor overrides: the file, the reviewed-source rule, the scan-time
   merge, the basis tail, request and apply. **Landed 2026-09-03.**
4. Custom prompts: the store and validation, the request path from the
   existing page, the scan request field, cells, ceiling, the second metric
   block, the record surface. **Landed 2026-09-03.**
5. Full-suite gate and a real-runner test of one synthetic cycle carrying
   custom prompts and an override, with only the network replaced.

Human-owned areas touched, flagged at each step: the competitor set and the
prompt banks (scoring inputs), the ceiling recomputation (spend control), the
basis shape (provenance). No live spend at any step.

---

# Amendment 1 — the person's edited prompt set IS the measurement (owner decision, 2026-09-16)

**Status:** Built by a session on the owner's stated decision of 2026-09-16
(MVP_PLAN row C3). **⚠️ HUMAN REVIEW REQUIRED: METHODOLOGY.** This changes what
the headline number is a measurement OF. `docs/METHODOLOGY.md` is human-owned
and does not describe custom prompts at all today; it needs a section written
by its owner before this is described to a customer as methodology. The sample
definition and the scoring rule set are human-owned (CLAUDE.md §4); the code
is written, the decision on its wording and its floors is not a session's.

## What the owner decided

The entry flow, in the owner's words, recorded by the session: a person enters
a domain; the prompts that would be asked appear (the domain's current set: the
authored or curated bank on first entry, the person's own latest version after
that); the person edits them in the app, adding, removing or rewording, and the
result is saved as version V through the existing versioned custom-prompts
path, with PROPERTY 2 still enforced; the person enters a number of days; the
first cycle runs now and the domain is tracked until that day, asked that set
on every engine daily, and then it stops. **The edited set is the measurement.**
The headline carries its basis and says "your N prompts, version V"; the trend
breaks at a version change; a head-to-head compares equal bases only; and the
bank's set is not collected separately for that domain unless the person kept
its prompts.

## What this supersedes, and why the integrity argument still holds

Decision 4 made the person's prompts a SECOND measurement beside the curated
one, on the owner's reasoning of 2026-09-03: *merging would change the sample
and break every trend the moment a prompt is added.* That reasoning was about
SILENT change. This amendment does not merge and does not change anything
silently:

- The set REPLACES the bank's prompts as the headline's cells; nothing is
  pooled. The headline basis becomes the bank's string with `unprompted=0` and
  the keyed tail `custom=K@V` (`packages/contracts/src/basis.ts`, unchanged:
  the shape already existed for decision 4's block, and the positional seven
  segments are untouched, so every stored basis still parses and formats byte
  for byte).
- A version change IS a change of basis. `compare()` refuses across it, the
  trend chart breaks its line there, the per-day list says so in words on the
  day it happened (`the custom prompt set (3@1 against 4@2)`), and a
  head-to-head between two records is drawn only on equal bases. The break is
  the disclosure: a person who changes their questions is shown, at the point
  of change, that the number before and the number after answer different
  questions.
- PROPERTY 2 (the headline is unprompted) holds on the person's text: the
  writer refuses a prompt that names the subject or any tracked brand, with
  the scorer's own matcher and the reason, before anything is saved
  (`checkCustomPromptsWith`). PROPERTY 3 (one basis across every brand in a
  result) holds: every brand is scored over the same answers.
- R5: no stored cycle is touched, and a re-derivation measures the sample the
  stored cycle measured. The re-score pre-flight reads the ROLE the set played
  off the stored file (`custom=` on the headline basis with `unprompted=0`:
  the headline's own sample; a second block beside a bank headline: decision
  4's block) and pins it on the re-run (`RunnerOptions.promptSetRole`,
  `rescore.ts` `promptSetRole`). The first build of this amendment pinned the
  version and not the role, so the runner read any pinned version as the
  headline's set and a re-score of a decision-4 cycle would have republished
  it, over the same file, as a measurement of a different sample: the silent
  rebasing this product is sold against. Found by the statistics review
  before anything was committed; `correctable-context.gate.test.ts` now
  re-derives an old-shape cycle under both roles and shows the difference.
  Nothing new writes a second block.
- The block's basis and a headline set's basis are the SAME STRING
  (`…|unprompted=0|runs=1|custom=K@V`); what tells them apart is the field
  they live in. No surface reads the two together today: the trend and the
  latest movement read headline metrics only, decision 4's movement reads
  block metrics only, a head-to-head is within one result, and
  `promptSetOf` reads the headline basis alone. A cross-record surface built
  later must keep that separation or the basis needs a marker for the role.
- R6: the cache key is unchanged. A prompt the person kept from the bank
  normalises to the bank's own cell, so it is one cell in the corpus, asked
  once, and a repeated cycle reads it back.
- The scoring algorithm version does NOT move. `algo_version` stamps how an
  answer is scored (mention, citation, position: R1's deterministic rules),
  and none of that changed; what changed is the SAMPLE, and the basis is the
  provenance field that exists to carry exactly that. A reviewer who thinks
  the sample definition belongs under the version stamp instead should say so
  here before a customer sees it.

## What it costs, stated plainly

- **Cross-domain comparability ends at the first edit.** The curated bank is
  what made two domains in one category comparable with each other. A domain
  measured over its own set is comparable with itself at the same version and
  with nothing else. Any category benchmark (`/cbi-publish`) must be built
  from bank-basis measurements only, and the basis makes those selectable.
- **A small set is a small sample.** n is prompts × engines × runs. A set of
  three prompts on five engines is fifteen answers: the Wilson interval is
  correspondingly wide and is shown, and `compare()`'s minimum sample means two
  such cycles are reported as insufficient data rather than compared. No floor
  on the set's size is imposed by this amendment beyond the writer's existing
  bounds; **whether to warn or refuse below some count is the methodology
  owner's decision**, and the honest default until it is made is what the
  build does: show the interval and refuse the comparison.
- The set is bounded at one cycle's prompts (`MAX_CUSTOM_PROMPTS = 17`, was
  15), so a person can keep the whole bank while rewording one question, and a
  measurement never costs more than a bank cycle. The writer's refusal of a
  prompt "the curated bank already asks" is gone, because the set no longer
  sits beside the bank.
- **A person's set can be less independent than the bank's.** The interval
  assumes the n answers are independent draws. The curated bank's prompts were
  written and reviewed to ask different questions; an edited set may contain a
  reworded prompt beside its original, and two near-identical questions produce
  near-identical answers. Deduplication only removes prompts identical after
  cache-key normalisation, so rewordings are collected as separate cells and
  counted as separate trials. The stated interval is therefore an upper bound
  on the precision of a set whose questions overlap, by roughly √DEFF: with a
  six-prompt set that is really two questions written three ways, of the order
  of 1.5×. This is the same design-effect correction G0 was commissioned to
  measure for engines and runs (`packages/stats/src/wilson.ts`), now with a
  second source we do not control. No correction is applied today, by either
  route. Whether the editor should flag near-duplicate prompts, and whether
  the set's own DEFF should be estimated once G0 lands, is the methodology
  owner's decision. (Wording from the statistics review of this amendment.)

## What travels with the number

The label "your N prompts, version V" is said where the sample size is said:
in the lede, and in the basis note beside the rail on both surfaces, so it
survives the case where the lede yields (zero mentions, which at fifteen
answers is not rare). Beside it, on both surfaces, one sentence says what the
number may be compared with: the person's own earlier cycles asked the same
version, and nothing else, not another domain and not a scan asked the
category bank (`lib/prompt-set.ts` `PROMPT_SET_SCOPE`). A head-to-head on a
set is headed "How that compares on your questions" and says that the rivals
are ranked on what the person asked, not on the category's shared bank:
PROPERTY 3 makes the comparison sound, and the heading stops it being read as
a position in the market. The per-day list marks every boundary `compare()`
refuses for (the scoring version, the collection path, the basis), not the
change of questions alone.

Before a small set is bought, the editor and the preview say what it buys:
below `MIN_N_FOR_COMPARISON` answers (questions × engines at one run per
cell; six questions is the first size that clears thirty at five engines) no
two cycles and no competitor row can be compared. A warning, never a refusal,
and computed against the constant, which is PROVISIONAL pending G0. **Whether
to refuse below some size remains the methodology owner's decision.**

The daily re-check's status names the set version in force NOW, which is what
the next cycle will ask, and keeps the version at the moment of switching on
apart as provenance of the instruction. Each run is pinned to the version its
cost was sized on, so a set saved between the day's decision and the run
changes the next cycle and never the one in flight.

## What was built, and what was not

Built (MVP_PLAN C3): the preview shows the domain's current set and lets the
person edit it (`components/prompt-preview.tsx`), saving through
`/api/custom-prompts`, which on a machine's own store applies directly as
version V (the person at the keyboard is its operator; with identity on, an
owner or admin applies and a member files, as before); `runScan` takes
`promptSet` and measures it as the headline; the runner, the due list, the
scan route's sizing and the re-score pre-flight follow; the headline and the
record say "your N prompts, version V"; the record lists the days with the
version each was asked under. Tested end to end offline
(`app/api/entry-flow.test.ts`, `components/entry-flow.render.test.tsx`,
`scan.test.ts`).

Not built, deliberately: a floor on set size; any parallel collection of the
bank's set for a domain with its own; any pooling of answers across versions;
any rewrite of a stored cycle; the METHODOLOGY text.

## Addendum to Amendment 1 — the basis names the sample, not only its label (MVP_PLAN C3r item 1, 2026-09-19)

⚠️ HUMAN REVIEW REQUIRED: METHODOLOGY. What follows changes what two numbers
must share before they are compared.

**The defect.** The custom tail was `custom=K@V`: how many prompts, at which
stored version. A version number is unique per host and per store and nowhere
else. Two different lists saved as "3 prompts, version 1" on two domains, or
in two workspaces, produced byte-identical basis strings, and `compare()`,
which refuses on the string and does not open it, would have put their numbers
side by side (the oversight statistics pass on C3, MAJOR 1).

**The decision.** The tail ends in a fingerprint of the list itself:
`custom=K@V#<12 hex>`. The recipe, whole, so anyone holding the list can
reproduce it with a standard tool: put each prompt through the cache key's own
normaliser (`normalisePrompt`, now in `packages/contracts/src/normalise.ts` so
the basis can share it in a browser bundle; the function, its version and
every stored key are unchanged); sort the results by code unit; take the
SHA-256 of the UTF-8 JSON text of `[NORMALISATION_VERSION, [the sorted
prompts]]`; keep the first twelve hex characters. It is made and read in
`packages/contracts/src/basis.ts` and nowhere else (`customBasisOf`,
`promptSetFingerprint`); the writer in `scan.ts` hands the list over and no
longer states a count of its own.

Order and spelling are left out because they are left out of the measurement:
the cache key normalises a prompt before it keys the cell, and a cycle's
answers are pooled whatever order the cells were asked in. **Repeats are
kept**, because a cycle asks one cell per list ENTRY (`customCellsFor`,
`scan.ts`): a prompt listed twice is a question weighted twice, so [A, A, B]
and [A, B, B] are two samples at one K. The first draft of this addendum
dropped repeats and claimed "one cell per normalised prompt"; the independent
statistics review measured that pair sharing one basis string, which is the
defect this addendum exists to close, and the claim was false about the code.
The saved path never stores a repeat (`checkCustomPromptsWith`), and C3r item
8 makes the reader drop them too; the fingerprint is what holds when a list
arrives some other way. The normaliser's version is inside the hash, so a
change of normaliser, which changes the cells, moves the fingerprint because
its definition says so.

**The fingerprint is the identity; the version is the pointer.** `@V` stays in
the string because it is how a stored cycle is read back under the list it was
asked (`customPromptsAt`). But a person who goes back to a list they asked
before is given a NEW version number (version 1 is list A, version 2 is list
B, version 3 is list A again), so on the string alone a revert would break the
trend for good, over a sample that did not change. `sameBasis` (basis.ts) is
the one rule: two strings are the same basis when they are equal, or when both
are canonical, both carry a fingerprint, the fingerprints and the counts
agree, and no other segment differs. `basisDifference` is null in exactly
those cases, so the record can never print "nothing differs" under a refused
comparison, nor a reason under an accepted one.

`compare()` is untouched (packages/stats is human-owned). The callers that
compare ACROSS cycles ask `sameBasis` first and hand `compare()` the pair
under one string when it says yes (`compareCycles`, `continuousCycles`,
`apps/public/lib/compare-cycles.ts`: the latest movement, the trend chart's
line and its per-point verdict, decision 4's block movement). Every other
guard `compare()` has still speaks on such a pair: the scoring version, the
collection path, the floor on n, the precision check. A caller that does not
ask gets a refusal, which is the safe way to be wrong.

**What is stored already.** A cycle stored before this addendum carries
`custom=K@V` with no fingerprint. It still parses, byte for byte, and it is
the same basis only as a string equal to it: what never recorded its list
cannot have it vouched for afterwards, so such a cycle and a fingerprinted one
are refused, in words that state what the two strings show ("one of them does
not record which questions it held") and claim no history, since nothing in a
basis says which of two cycles is older. A re-score under a NEW scoring
version re-derives such a cycle over the stored list at the stored version and
stamps the fingerprint of that list; the superseded file is kept at its audit
path, as for any re-score, and `compare()` refuses across the version anyway.
A re-score under the SAME version may not restamp a basis (it would break a
trend over an identical sample wherever one cycle of a domain could be
re-derived and its neighbour could not): it is refused for such a cycle, and
said so (C3r item 7, with the statistics review's MINOR 4). No stored cycle
carries a custom tail at the time of writing (`basis.test.ts` lists every
stored string), so the window is the cycles collected between C3 and this
change.

**What it costs.** One more thing a reader of a raw basis string has to be
told: twelve characters after a `#`. Forty-eight bits: the case that matters
is two lists meeting by chance within one domain's history at the same count,
the birthday bound, about 2 in 10^11 at a hundred versions; and nobody gains by
forging one, since the only comparison a forged fingerprint unlocks is between
two of the forger's own numbers. A revert re-joins a trend only between
NEIGHBOURING cycles: if a cycle was collected under the version in between,
both of its boundaries still break, which is correct.
