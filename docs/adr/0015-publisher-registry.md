# ADR-0015 — The publisher registry: proposed, measured, not wired

**Status:** Proposed · **Date:** 2026-09-03 · **Phase:** P3
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

`packages/taxonomy/src/publishers.ts`: 59 entries, each with `kind`, regions,
an `affiliate` flag where it applies, a checkable one-line `why`, and an
`addedOn` date. Seven carry a `conflict`: an ownership or business-model fact
the reviewer must weigh (Ziff Davis, owner of PCMag, ZDNet and CNET, also owns
Moz, a tracked SEO-tools vendor; TechRepublic is owned by TechnologyAdvice,
refused under criterion 3; Startups.co.uk sits in a lead-generation group;
Sportskeeda is a sports site with a gaming desk; `indiatimes.com` covers
non-editorial subdomains). Search Engine Land and MarTech were in the first
draft and are now refused under criterion 2: Third Door Media has been owned
by Semrush since 2024, and Semrush is a tracked vendor.

The seed comes from the outlets that cover the taxonomy's categories
in its markets, cross-checked against what the three stored scans actually
cited. Seventeen domains that were considered and refused are listed in
`NOT_PUBLISHERS` with the criterion each fails, so nobody proposes them
twice. `publishers.test.ts` refuses a malformed entry: registrable, lower
case, unique, a reason a reviewer can check, never a tracked vendor's domain
in any demo bank, never a domain a platform table already names. The test
cannot see corporate ownership; that is what `conflict` and the review are for.

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
| pipedrive.com (reference, 2026-08-25) | 282 | 250 (88.7%) | 244 (86.5%) | 6: smallbusiness.co.uk 2, forbes, pcmag, startups.co.uk, techradar |
| sigzen.com (2026-09-01) | 191 | 167 (87.4%) | 167 (87.4%) | 0 |
| thecosmicbyte.com (2026-09-01) | 156 | 132 (84.6%) | 126 (80.8%) | 6: rtings 2, digit.in, news18, nytimes, sportskeeda |

**The registry moves the reference scan's "other" share from 88.7% to 86.5%.**
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
criterion 2 on ownership (refused); five borderline entries carried no record
of why (`conflict`); the proposer re-declared the promotion bar instead of
importing it; its main-guard and data-directory derivation broke on Windows
paths (`fileURLToPath`); hostless redirects vanished from its output (counted
and printed). Left: `medium.com` in the refusals is unreachable because the
registrable-domain rule treats it as a private suffix, which is cosmetic.

## Open — the owner decides

- **Approve, amend or reject the seed list and the four criteria.** Until
  approved the map is dead code with tests.
- **Whether to wire it at all, given 2.2 points on the reference scan.** The
  honest reading is that `earned_media` matters for the category the product
  sells into (press coverage is what a PR team buys) even when it is rare
  today; the cost is a det-3 bump and a re-score.
- **Whether to unwrap provider redirects before classification**, and whether
  to add retail and vendor classes. Both are rule changes and arrive together
  with, or after, det-3.
- **Attribution of `www.zoho.com/crm` and Dynamics** stays as ADR-0014 left it.

## Verification, without spending

- `source-class-pin.test.ts`: 35 tests; three mutations each fail the pin, and
  wiring the registry into `answers.ts` fails the static guard.
- `packages/taxonomy/src/publishers.test.ts`: every entry well-formed and
  reasoned, never a vendor or a platform, refusals disjoint and criterion-named.
- `services/grader/src/publishers.test.ts`: the tally by hand, the bar and
  the three statuses, the dry-run arithmetic on seven synthetic citations.
- `pnpm grader:publishers`: disk only, produced the table above.
- Full suite 84 files, all passing; root typecheck clean. No provider call,
  no model call, no write to the store.
