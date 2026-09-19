# Golden set — how to label

PHASES.md 2.5. Target: **300–500 labelled answers**. Currently **191**: the 7
hand-built seed cases, and 184 real stored answers whose labels an agent
**proposed by reading them** (MVP_PLAN E4). Below the target the G2 thresholds
report `NOT_RUN`, not `PASS`.

Gate G2 asks for ≥ 95% deterministic agreement, ≥ 97% citation-class agreement,
and **0% silently bucketed as `owned`**. The harness in `src/golden.ts` computes
all three, but deliberately refuses to return a verdict below the target set
size: agreement over a dozen answers is noise wearing a gate's clothes.

## The verdict, and why an agent's label cannot pass the gate

A label is ground truth here: wherever the two differ, the harness reports the
*scorer* as wrong. That is only honest when a person stands behind the label.

| Verdict | When |
|---|---|
| `NOT_RUN` | the set is below 300 cases |
| `PROPOSED` | 300 or more, some labels are `agent-proposed` with `verifiedBy: null`, and no usable human spot-check vouches for them. The three figures are reported. **It can never read `PASS`.** |
| `PASS` / `FAIL` | every label is a person's, **or** a signed spot-check of the seeded random 30 agreed with at least 29 of them |

The spot-check is one file the owner edits by hand and runs nothing for:
`docs/runbooks/golden-spot-check.md`. The suite and the report read it as it
stands, and **the harness judges it, nobody else**: `runGoldenSet(cases, sheet)`
takes the sheet as a person left it, draws the seeded sample itself and refuses,
by name, a sheet that is not that sample, was drawn under another seed, was
written for a different set of agent-proposed labels (the sheet records the
population it was drawn from, so deleting awkward cases outside the sample
voids it), holds a label that changed after the person agreed with it (every
entry carries a fingerprint of what was shown), is unsigned, has an unanswered
box, or has two ticks in one entry. Each leaves the verdict at `PROPOSED`.

The threshold is a rate over exactly the sampled 30: at least 29 agree. What
that does and does not prove is argued at `SPOT_CHECK_MIN_AGREE_RATE`
(`src/golden.ts`); it is the builder's proposal and the scoring-rule owner's to
confirm. A label the person disputes **stays in the figures** and is named, and
the report shows the figure both ways; the right response is to correct it by
re-reading and have the person verify it (`verifiedBy` plus
`verifiedFingerprint`), which does not disturb the sample or their check.

⚠️ **Open, and the owner's:** `PASS` compares three point estimates to three
bars, as G2 always has. The pooled deterministic figure is six checks per case
that move together, so it has no honest simple interval; the report prints the
case-level count with its Wilson interval beside it, the figures by engine and
by category, and the citation figure beside the share labelled `other`. Whether
`PASS` should require a lower bound to clear the bar is a methodology decision
(E4 stats review, B3).

## One file per answer

`answers/<id>.json`, matching the `GoldenCase` type in `src/golden.ts`.

| Field | What goes in it |
|---|---|
| `id` | `gNNN-short-slug`. Stable forever — a disagreement gets discussed by id. |
| `covers` | **Required by the test suite.** The edge this case exists to pin. If you cannot name one, the set does not need the case. A stratified sample of real answers is not chosen for an edge, so a worklist case names the structural edges that are true of it (no citations, an empty answer, a surface's metadata dialect, a table) or says in as many words that it pins none, and the labeller appends what they saw on reading. |
| `source` | Engine, and where the text came from. A disputed label has to be traceable. A real answer also carries `domain`, `category`, `day`, the `prompt`, the `comparisonBasis` and the cache `cell` (`key`, `adapter`, `run`). |
| `answer` | `{ text, citations[] }` exactly as `EngineAdapter.normalise()` would emit it, including citation `meta` where the provider supplied it. |
| `brand` / `competitors` / `publishers` | Alias tables, owned domains and the publisher registry. Aliases are forms a human would actually write, never substring fragments. In a real case these are the specs **the scan that produced the cycle scored with**, so the case measures the scorer on the sample it actually scored. |
| `label` | What a reader says is correct. |
| `labelledBy` | `human` or `agent-proposed`. Required on every real answer. Absent on the hand-built seeds. |
| `verifiedBy` / `verifiedFingerprint` | The person who checked an agent's label, or `null` while nobody has, and the fingerprint of the label they checked. A name alone verifies nothing, and a label edited after it was verified is a proposal again. |
| `evidence` | Required with `agent-proposed`: every counted occurrence of the subject and the first appearance of each competitor (`span` + character `offset`), the `order` that produced the position, a reason per citation class, `notes`, and `revisions` when a label changed after it was first proposed. The validator checks every span stands at its offset and that the counts and the order agree with the label. |

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

### Conventions the E4 labelling applied where the rules are silent

⚠️ The scoring-rule owner's to confirm or overrule. Each use is recorded in the
case's `evidence.notes`, so a changed convention can be re-applied by search.

- **A label is what a reader sees, not what the alias table lists.** A casing,
  spacing or possessive variant counts, and so does a short form that plainly
  names that product in that sentence ("Zoho" or "Dynamics" in a list of CRMs,
  "Cosmic Byte" for `thecosmicbyte`). A sister product or a bare company name
  does not ("Bigin by Zoho" is not Zoho CRM; "SAP" is not SAP Business One).
  The literal full name as whole tokens always counts ("Bigin by Zoho CRM").
- **What a URL is:** text starting `http://`, `https://` or `www.`, and the
  target of a Markdown link. A bare domain written into prose ("monday.com") is
  a written form of the name and counts; notes record `bare-domain`.
- **Engine markup is text.** Follow-up suggestions Gemini appends
  (`<Elicitation label="…">`) are in `answer.text` and are counted.
- **`cited` follows rule 1 literally:** a link to the subject's own site inside
  the answer text is `cited: true` even when the citations list is empty.
- **A citation is classed by its URL host.** An opaque Google redirect
  (`/goto?url=…`) shows none, and in these payloads the card beside a link does
  not always describe that link, so rule 6 applies: not sure, therefore `other`.
  19 such citations carry a card naming YouTube, Reddit, Quora or RTINGS.
- **`video`, `community`, `review`, `reference` describe what the cited site
  is**, from the labeller's knowledge of it; not confident means `other`.

## Growing the set from stored answers

```bash
pnpm scorer:golden-worklist -- --data <grader data dir> --out <scratch dir>   # unlabelled cases, stratified by engine x category, seeded
# label each case BY READING IT, independently of the scorer (see below)
pnpm scorer:golden-worklist -- --apply <labels.json> --from <scratch dir>      # validates, then writes answers/<id>.json as agent-proposed
pnpm scorer:golden-report                                                      # the verdict, the three figures, every disagreement with evidence
pnpm scorer:golden-report -- --write-sheet                                     # the owner's spot-check sheet for the current set
pnpm scorer:golden-report -- --write-disagreements                             # the recorded findings the suite holds the live report against
```

**The integrity line.** A label is made by reading the answer. Whoever labels
may not run the scorer on the case first, may not read a stored score row for
it, and may not copy scorer output into a label. The worklist tool never calls
the scorer (a test holds it to that), and the first time a label meets the
scorer is `golden-report`. After that, a label changes only by re-reading the
answer, and the change is recorded in `evidence.revisions` with its reason.
**A disagreement is a finding for the scoring-rule owner**, never a reason to
edit a label, and a rule changes only under `/score-version`.

`publisher-registry.json` is the scan's publisher registry as data, which the
worklist copies into every case. The grader lets only the scan and the evidence
reader read the registry constant (a third reader is a third opinion), so the
worklist reads this copy, and `golden-worklist.test.ts` holds it equal to the
registry entry for entry and to the current scoring version. A registry edit is
a scoring rule change: retake the snapshot in the same bump.

Left out of the worklist, each named in its manifest: an answer a fixture
adapter produced (synthetic text), an answer holding an email address, a phone
number or anything shaped like a credential (the repository is public; a
redacted answer would no longer be the answer the scorer scored), and a cycle's
custom-prompt answers (ADR-0016).

## Running it

```bash
pnpm vitest run services/scorer/src/golden.test.ts
```

The suite fails if any case is structurally invalid, if a hand-built seed
disagrees with the scorer, if anything a person labelled otherwise came back
`owned` in the seeds, or if the live disagreements differ from
`golden/disagreements.json` in either direction (a rule edit that moved
agreement, or a label edited to match, shows up as a diff of that file). It
does **not** fail for being below target size — it reports `NOT_RUN`.

## What this set still needs

- **109 more real answers.** The corpus held 185 answers traceable to a stored
  cycle (one was left out for an email address), so the set cannot reach 300
  until more cycles are collected. That is a collection, and the owner's act.
- **The owner's spot-check**, without which no number of cases reads `PASS`.
- non-English answers, and transliterated brand names
- brand names that are ordinary words in context (Close is the one in the set:
  four real cases name it by its bare name)
- competitor aliases that collide with each other
