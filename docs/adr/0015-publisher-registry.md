# ADR-0015 — The publisher registry: proposed, measured, not wired

**Status:** Accepted for the list and the criteria (2026-09-03); the registry is NOT wired, and wiring (det-3) is deferred · **Date:** 2026-09-03 · **Phase:** P3
**Relates to:** R1 (deterministic scoring) · R5 (rows are immutable and
version-stamped) · ADR-0005 (citation source classification) · ADR-0012 (what
det-2 covers, and the pin) · ADR-0014 (the citation breakdown on the result
page) · CLAUDE.md §4: the scoring rule set is human-owned

## Context

ADR-0014 put the citation breakdown on the result page and named its weakest
line: with no publisher registry, `earned_media` is never assigned, and on the
reference scan (pipedrive.com, 2026-08-25) 250 of 282 citations, 88.7%, read as
"other". `classifyCitation` has accepted a `publishers` map since ADR-0005;
every stored scan was classified with it empty.

The owner asked for two things, in this order: the det-2 pin extended to the
classifier so its boundaries cannot drift silently; then a registry proposed
as a methodology decision — what counts as a publisher, where the seed comes
from, how a domain is added later — shown before it is wired, with the
"other" share re-counted honestly against it.

## Decision 1 — the classifier is pinned under the version constant (done)

`services/scorer/src/source-class-pin.test.ts` freezes, keyed by
`SCORING_ALGO_VERSION`, thirty boundary cases and the platform tables
themselves:

- owned subdomain and second owned domain; a competitor's subdomain and a
  competitor whose attribution domain is a subdomain (`crm.zoho.com` is
  competitor, `www.zoho.com/crm` is other, by ADR-0005's narrowing);
- video with the timestamp parsed from `t=510` and from `t=1m30s`; a
  community thread with sub-community and thread id; a review listing with
  its id; a reference by domain and by government suffix, with `ico.org.uk`
  shown NOT to match `gov.uk`;
- a registry hit becoming `earned_media`; a domain outside the registry
  staying other; a provider redirect with no host classed other with an
  empty domain;
- precedence in both directions: an owned domain that is also a platform is
  owned, a competitor domain that is also a review site is competitor;
- every extractor path: the colon timestamp form, `start=`, shorts and
  embed ids, a non-YouTube video id, a Hacker News thread, a Stack Exchange
  site, Capterra and Trustpilot listing ids, `europa.eu` by suffix, a named
  government table entry;
- a provider-supplied publisher name recorded on the row and NOT promoting
  the class;
- the exact contents of the VIDEO, COMMUNITY, REVIEW and REFERENCE tables
  and the government suffixes, through `PLATFORM_TABLES`, an export of frozen
  copies added to `classify-source.ts` (no rule changed, nothing reachable);
- **the wiring guard**, twice: `scoreAnswer` called the way `answers.ts`
  calls it classifies a registry publisher as other under this version, and a
  walk of every production module finds no reader of `PUBLISHER_REGISTRY`
  beyond its own file and the proposer. Checked by mutation: wiring the map
  into `answers.ts` fails the static guard; the `scoreAnswer` guard pins the
  default and would fail if the scorer itself started reading a registry.

Mutation-checked the same way the alias pin was: bumping the constant, adding
a domain to REVIEW, and adding a domain to REFERENCE each fail the pin. Any
of those is a rule change and must arrive with a version bump.

## Decision 2 — the registry is a proposal, and this is the methodology

### What makes a domain a publisher

All four must hold (the file header carries the same text):

1. **An editorial organisation.** A named staff, a masthead, a standards or
   corrections page. One person's blog, a marketing team, a content
   operation without a masthead: no.
2. **Independent of the vendors it covers.** Not owned by, and not a blog of,
   a company selling in a tracked category. Vendor-owned magazines
   (opensource.com under Red Hat) are out for the same reason.
3. **Not primarily an affiliate directory or listicle operation.** Software
   directories, lead-generation comparison sites and statistics farms are not
   editorial coverage even with bylines. A masthead outlet that ALSO runs
   affiliate buying guides is in, with `affiliate: true` recorded on the
   entry rather than hidden.
4. **Relevant to a tracked category and a market we sell into.** Business
   software and gaming peripherals, across UK/EU, India and GCC.

Review aggregators (G2, Capterra, Trustpilot) stay in the `review` class.

### Where the initial list comes from

`packages/taxonomy/src/publishers.ts`: 52 entries, each with `kind`, regions,
an `affiliate` flag where it applies, a checkable one-line `why`, and an
`addedOn` date. The proposal carried 59: seven entries flagged by the hostile
review with an ownership or structural conflict (PCMag, ZDNet and CNET under
Ziff Davis, which owns Moz, a tracked SEO-tools vendor; TechRepublic under
TechnologyAdvice, a directory operator refused under criterion 3;
Startups.co.uk under a lead-generation group; `indiatimes.com`, whose
registrable domain covers non-editorial properties; Sportskeeda, a sports
site). **The owner decided on 2026-09-03 to exclude all seven**, applying the
independence rule that had already removed Search Engine Land and MarTech
(Third Door Media, owned by Semrush since 2024) consistently rather than case
by case: ownership counts at any distance, whatever the title's beat. The
criterion text in the file now says so, and each of the nine is named in the
refusals with the criterion it fails.

The seed comes from the outlets that cover the taxonomy's categories
in its markets, cross-checked against what the three stored scans actually
cited. Twenty-four domains that were considered and refused are listed in
`NOT_PUBLISHERS` with the criterion each fails, so nobody proposes them
twice. `publishers.test.ts` refuses a malformed entry: registrable, lower
case, unique, a reason a reviewer can check, never a tracked vendor's domain
in any demo bank, never a domain a platform table already names. The test
cannot see corporate ownership; that is what the review is for, and why each
refusal names its reason.

### How a domain is added later

One way only: a person edits the file with a reason, in a commit that bumps
the scoring version. `pnpm grader:publishers` supports that decision without
making it: it tallies every `other` citation across every stored cycle by
registrable domain, applies the competitor-promotion bar (cited in ≥ 3
answers, ≥ 2 prompts, ≥ 2 engines), marks what is already in the registry or
already refused, and prints the rest as candidates for a person to judge
against the four criteria. It reads disk only and never writes.

### Why wiring it is a version bump

`classifyCitation` reads the map at classification time. Passing a non-empty
map changes what an already-collected answer scores, and every stored cycle
was classified under det-2 with the map empty. So wiring is a scoring rule
change under R5: `det-3`, a changelog row, every stored cycle re-scored
forward (never overwritten), and a new pin table for det-3 that names the
registry's contents. ADR-0012's guard test makes the omission fail. The
`/score-version` repair noted in CLAUDE.md §9 comes before this.

## The measurement — what an honest registry actually resolves

Run on 2026-09-03 against the three stored cycles, 629 citations, 529 classed
other with a host, 355 distinct hosts, and 20 classed other with no host
(provider redirect forms the classifier does not unwrap). Dry run, as if the registry were wired:

| Subject | Citations | Other before | Other after | Moved to earned media |
|---|---|---|---|---|
| pipedrive.com (reference, 2026-08-25) | 282 | 250 (88.7%) | 246 (87.2%) | 4: smallbusiness.co.uk 2, forbes, techradar |
| sigzen.com (2026-09-01) | 191 | 167 (87.4%) | 167 (87.4%) | 0 |
| thecosmicbyte.com (2026-09-01) | 156 | 132 (84.6%) | 127 (81.4%) | 5: rtings 2, digit.in, news18, nytimes |

Under the 59-entry proposal the reference figure was 244 (86.5%), with PCMag
and Startups.co.uk each matching once; the approved 52 give up those two.

**The approved registry moves the reference scan's "other" share from 88.7% to 87.2%.**
That is the finding. Editorial outlets appear in this corpus as singletons and
pairs; the bulk of "other" is not press at all. The ten hosts that clear the
promotion bar are: amazon.in (33 citations), erpresearch.com, zoho.com,
amazon.com, zite.com, batchmaster.co.in, getcoherence.io, top10erp.org, and
two already refused by name (linkedin.com, softwaresuggest.com). None of the
eight candidates is a publisher under the criteria above: two retailers, a
vendor (Zoho's corporate site, narrowed by ADR-0005), and five vendor blogs or
affiliate listicles. A registry that admitted them would shrink the number
and be wrong.

What "other" actually holds, from the corpus tally: retailers (amazon.in,
flipkart.com), provider redirect URLs (20 with no host, and google.com
`/url?` forms with one, each carrying the real destination in a query
parameter the classifier does not unwrap), vendor sites that are neither subject nor
tracked competitor, SEO and affiliate listicles, social platforms, GitHub.
Resolving those needs NEW classes (retail, vendor, redirect-unwrapped), each
a scoring-rule decision, not a longer publisher list.

## The hostile review, and what it changed

Reviewed read-only on 2026-09-03. Fixed: the pin could not see the registry
being wired (both wiring guards above); the identity-over-platform precedence
and nine extractor paths were unpinned (rows added); `PLATFORM_TABLES` handed
out the live table objects (frozen copies now); two seed entries failed
criterion 2 on ownership (refused); five more carried an ownership or
structural conflict, recorded for the owner and then refused by the owner's
decision above; the proposer re-declared the promotion bar instead of
importing it; its main-guard and data-directory derivation broke on Windows
paths (`fileURLToPath`); hostless redirects vanished from its output (counted
and printed). Left: `medium.com` in the refusals is unreachable because the
registrable-domain rule treats it as a private suffix, which is cosmetic.

## Decided 2026-09-03, and what stays open

- **The list and the criteria are approved** as amended above (52 entries, 24
  refusals). The map is still dead code with tests until wired.
- **Wiring is deferred.** The owner asked first for `/score-version` to work
  as documented; that repair landed the same day (`version-diff`, the
  snapshot-then-diff flip list, and the command rewritten to the files that
  exist). A det-3 bump waits for a separate go-ahead.
- **Redirect unwrapping and retail/vendor classes are deferred**, not this
  round. They remain the change that would actually resolve "other".
- **Attribution of `www.zoho.com/crm` and Dynamics** stays as ADR-0014 left it.

## Verification, without spending

- `source-class-pin.test.ts`: 35 tests; three mutations each fail the pin, and
  wiring the registry into `answers.ts` fails the static guard.
- `pnpm grader:publishers` re-run after the exclusions: the table above.
- `packages/taxonomy/src/publishers.test.ts`: every entry well-formed and
  reasoned, never a vendor or a platform, refusals disjoint and criterion-named.
- `services/grader/src/publishers.test.ts`: the tally by hand, the bar and
  the three statuses, the dry-run arithmetic on seven synthetic citations.
- `pnpm grader:publishers`: disk only, produced the table above.
- Full suite 84 files, all passing; root typecheck clean. No provider call,
  no model call, no write to the store.


---

# Amendment 1 — wired at det-3, and what the full corpus did

**Status:** Accepted · **Date:** 2026-09-07 · **Phase:** P3

The list of 52 was approved on 2026-09-03 and left unwired pending a separate
go-ahead. That go-ahead was given on 2026-09-07. This records what wiring it
actually did, measured before the bump rather than after.

## The diff

A det-2 snapshot taken 2026-09-03, **before** any rule edit, held all 185 rows
across 3 cycles. A control run first — current rules against that snapshot, same
version both sides — returned **0 flips**, which is what proves the tool and the
baseline rather than the change. The registry was then wired and the diff re-run:

| | |
|---|---|
| Rows flipped | **8**, every one the `citations` field |
| Citations reclassified | **9** of 629; the count is identical before and after |
| `other` | 549 → 540 · corpus 87.3% → 85.9% · reference scan 88.7% → 87.2% |
| `earned_media` | 0 → 9 · 0% → 1.4% |
| video / competitor / review / community / owned | unchanged, to the citation |
| Golden set | 100% on every field before and after; 0 silently bucketed as `owned` |
| Mention rate, position, `cited` | **unmoved on every row** |

**The reference-scan figure reproduces this ADR's own prediction exactly**
(88.7% → 87.2%). The corpus figure differs only because it counts all three
domains.

## What the corpus says about the list

Seven of the 52 are cited by the stored corpus, and **all seven** reclassified:
TechRadar, Forbes, NYTimes/Wirecutter, RTINGS (×2), smallbusiness.co.uk (×2),
News18, Digit. None was missed, which is the check that the domain matching and
the subdomain handling actually work on real URLs rather than on invented ones.

Eighteen of the recorded refusals are also cited, and **all eighteen stayed
`other`** — PCMag (criterion 2, common ownership with a tracked vendor),
TechnologyAdvice and SoftwareSuggest and Research.com (criterion 3, directory
operations), opensource.com (criterion 2, Red Hat), LinkedIn and Facebook and
GitHub and Medium (criterion 1, no masthead). The four criteria are a boundary
the data now exercises, not a paragraph.

**sigzen.com moved by nothing at all** (87.4% → 87.4%): the ERP corpus cites
none of the 52. That is criterion 4 working as designed — the list is seeded for
the categories that exist — and it is also the honest limit of the list's
current reach.

## Consequences

- **No customer-visible number moved.** Only the citation source mix changed,
  and only `other` → `earned_media`. The publisher check sits at step 3 of
  `classifyCitation`, after owned, competitor, community, review and reference,
  so it can never override a more specific class.
- **`other` is still 86%.** This ADR already said the remainder is retailers,
  redirects, vendor blogs and listicles needing new classes rather than a longer
  list, and the diff confirms it: `amazon.in`, `worldmetrics.org`, `zipdo.co`
  and a long tail of vendor blogs are the bulk of what is left.
- **Two production call sites, and they must never disagree.** `scan.ts` writes
  the stored numbers and `answers.ts` re-scores them for the evidence view *and
  for `grader:version-diff` itself* — wire one and not the other and every
  future flip list is silently wrong. `publisher-wiring.test.ts` asserts both,
  and was mutation-checked by unwiring one and watching it name the file.
- **The scorer keeps no default.** `scoreAnswer` still returns `other` for a
  registry domain when no caller passes a map. The registry is data the grader
  owns; the scorer stays a pure function of its inputs, and the golden harness
  keeps using each case's own declared map.

## ⚠️ Open, and a human's

**What the golden set checks, corrected after review.** An earlier draft of this
amendment said `g004-source-mix`'s TechCrunch citation was unlabelled and
skipped. It is labelled `earned_media` and counted — agreement is 11 of 11 — and
`validateGoldenCase` refuses an unlabelled citation, so the state described was
unreachable. The claim was wrong and is corrected here rather than quietly
edited out.

The real limit is narrower. That case declares its own two-entry publisher map,
so the set exercises `classifyCitation`'s earned-media lookup and never the
CONTENTS of the 52. It would catch a regression in the code path; it could not
catch a wrong, missing or mistyped outlet. What guards the contents is
`publisher-registry-pin.test.ts`, which freezes the exact domain set under
`SCORING_ALGO_VERSION` — added at the same review, because until then adding a
53rd outlet would have changed what a stored answer scores with both cycles
stamped `det-3` and `compare()` unable to see it.

**Gating on the flip list is defensible for this bump and should not become a
precedent.** The flip list is a census over all 185 stored rows, not a sample —
a stronger instrument than 7 hand-labelled cases for "did anything besides
`citations` move". What it cannot establish is that the 9 reclassifications are
CORRECT; that rests on the four criteria and a person reading the nine named
domains. Acceptable when the blast radius is one non-headline field. Not
acceptable for a bump touching mention detection.
