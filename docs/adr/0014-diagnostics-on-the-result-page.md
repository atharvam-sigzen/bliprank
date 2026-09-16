# ADR-0014 — The diagnostics reach the result page: the gap report, and what the engines cited

**Status:** Accepted · **Date:** 2026-09-02 · **Phase:** P3
**Relates to:** R1 (deterministic scoring) · R3 (nothing spends outside a
budgeted runner) · R5 (rows are immutable and version-stamped) · R8 (no metric
without its interval) · ADR-0005 (citation source classification) · ADR-0011
(the answers are the evidence) · ADR-0013 (cycles) · the scope boundary in
CLAUDE.md §1: measurement, report, comparison, diagnosis — never generation
or publishing

## Context

The positioning assessment of 2026-09-02 found the diagnostic pillar built and
invisible. `aeo-audit.ts` produced a gap report — nine facts about a homepage's
structure and, per prompt the engines were asked, which of its terms the page
never uses — and only `pnpm grader:aeo` could see it. The scorer had
classified every citation since P2.1b (ADR-0005) and the result carried one
number about it: how many answers cited the subject's own domain. Which sites
the engines pointed readers at, and what kind of sites, was summed away.

Both are the "so what do I do" half of the product, and both are the checkable
kind of answer: facts about a document, facts about a list of URLs. Neither
generates anything. The owner approved surfacing exactly these two, using the
data the scorer and the store already produce, and nothing beyond.

## Decision

### Both are evidence, so both follow ADR-0011's arrangement

A separate artefact, fetched when a reader asks, checked against the result it
sits under before a line is shown: a static file for the bundled reference
scan, a route for a scan this machine collected. Neither is written into the
result file. A result is a measurement of the engines on a day; a gap report is
a fact about the customer's page at the moment it was read, and it carries its
own `fetchedAt`. Citations are already in the answer blobs, so they ride the
evidence file the per-question drawer reads, and the two sections share one
download (`loadAnswers` is memoised per evidence URL and basis).

### What the engines cited

`readScanAnswers` now returns, for every stored answer, every URL the engine
cited with the class the scorer assigns it and the registrable domain the
class was decided on. The class is computed at read time by the same
`scoreAnswer` the scan ran, over the same stored URL, with the same subject and
competitor domains, and the evidence file names the rule set (`algoVersion`).
That is a re-derivation of what the scan's own rows carried, not a new
classification; a future `det-3` would change the file's stamp and the record
would say so.

⚠️ **HUMAN REVIEW REQUIRED: scoring / methodology.** Read-time classification
under the current stamp is the same rule set the scan used today. If the
classifier changes without a bump, the evidence and the result's `citations`
count could disagree while both say det-2. ADR-0012's guard covers alias
derivation; it does not yet cover `classify-source.ts`. Extending the pin to
the classifier is the obvious follow-up and is flagged rather than done here.

The surface, `CitedSources`, shows: how many sources across how many answers,
which engines returned none (gemini returned none on any answer in this
corpus — a fact about the engine, stated rather than read as zero), the share
of citations in each class **with a Wilson interval and n = citations** (a
share of citations is a proportion of a sample like any other, R8), and the
sites cited most, the subject's own flagged. The caveat beside the table: a
citation is where an engine sent a reader, not where it got its facts, and
being cited is not a measured cause of being named.

**`other` is most of it, and that is stated.** On the reference scan 250 of 282
citations classify as `other`: not the subject's or a rival's domain, not a
video, community, review or reference platform the tables know, and not in a
publisher registry — because this build passes no publisher registry to the
classifier, so `earned_media` is never assigned. The table prints the class
as "Other sites"; the honest reading is "a site none of our tables name". A
publisher registry is P2.1b's remaining work, not this ADR's.

### What is on your page

`gaps.ts` builds the report for a STORED CYCLE: the bank that cycle recorded
(its own category, the record only for a file too old to name one), at the
prompt count on its basis, so the questions on the report are the questions
behind the number. One GET through `fetch-site.ts`'s boundary. `/api/gaps` is
bounded to domains with a stored cycle before it fetches anything, so it is not
a proxy for arbitrary hosts, and it has its own per-visitor rolling-window
throttle, booked before the fetch, for the same reason `/api/preview` has one.
`pnpm grader:aeo --out` writes the bundled reference scan's report as the
static file the deployment serves.

The surface, `GapReport`, keeps the module's honesty by construction:

- every `why` is printed as written, hedged, and only for a finding that is
  not present;
- a truncated page changes what a gap means, and the words change with it;
- coverage is ordered worst first, as a checklist;
- the last sentence is the module's own: none of this is a measured cause of
  anything, and nothing here writes or publishes anything.

Nothing generates. The `--draft` path was removed the day it was reviewed
(8d9e100) and no surface here offers a draft, a suggestion or a rewrite.

### What is deliberately not done

- No publisher registry, so no `earned_media`. Stated on the surface.
- No per-cycle citation trend. The mix is per cycle, from that cycle's
  evidence; a trend over mixes is a later question.
- No `.detail` split beyond provenance lines. Both sections stay at both
  depths: a finding's `why` explains a mark that stays visible (ADR-0010).
- On the static deployment a session scan's sources and gap report are
  unavailable and the surface says so; the bundled scan's are shipped.

## The hostile review, and what it changed

A reviewer with no stake in the design attacked scope, the reconciliation of
the classes with the result, R8 on the new surface, the route as an amplifier,
the bundled artefacts, the drawer's links, the parsers and the copy. Scope
held: `services/scorer` is untouched, nothing generates, every hedge is
printed. The reconciliation held exactly: answers with an `owned` citation
equal the result's subject `citations` count, and every competitor's count
matches. Three findings stood up as MAJOR and were fixed before commit.

| Finding | What could happen | What changed |
|---|---|---|
| A provider's own redirect link, stored verbatim (`/goto?url=…`, no host), reached the surface | A blank row in "Most cited sites" and an empty anchor in the drawer resolving against this site's own origin | Counted in its class (the scan counted it), named as "an engine redirect link naming no site", never a site row and never a link; an anchor is rendered only for an absolute web URL with a host |
| The route's only throttle keyed on a header the caller writes | On the local demo `cf-connecting-ip` is the caller's to set, so one scanned domain bought unbounded 512 KB / 6 s reads of that homepage | A per-DOMAIN cap shared by every visitor (6 reads an hour, on its own ledger), checked before the visitor throttle, plus an in-flight cap of two; a named day with no cycle is a 404 before any booking. `/api/preview` shares the weaker bound and is noted |
| The evidence's classifier version was never compared with the result's | After a det-3 bump without a rescore, classes labelled det-3 would sit under det-2 numbers with no refusal | `belongsTo` refuses a mismatch by name; a file too old to name a rule set is allowed and the surface prints "unknown" |

Minors, also fixed: the "yours" chip borrowed the amber that means *planned*;
"cited 282 sources" counted citations and now says so, with the distinct-site
count beside it; a dead ternary; a static host answering a route's path with
its own HTML page and a 200 is now read as "not available in this build" on
both loaders; a vacuous assertion in the render test.

**`/api/preview`, fixed the same way on 2026-09-03.** The preview reads any
caller-named homepage once and may author a bank for it, and its only throttle
was the same header-keyed one. A failed read still records a fallback and
records are write-once, so one domain is never read twice; the vector is
breadth — unbounded distinct hosts, one GET and one model call each. The bound
that does not trust the caller is therefore global: sixty previews that would
cost (an unrecorded domain the host alone cannot classify) per hour across
everyone, on one ledger, plus two in flight. A recorded or host-classified
domain is free and passes an exhausted cap untouched. Tested with a fresh
header per request, which is what an attacker sends.

Left as they are, and named: `zoho-crm`'s attribution domain is `crm.zoho.com`
by design (ADR-0005 narrows it), so `www.zoho.com/crm` citations read as
"other" beside a chart that names Zoho CRM, and likewise Dynamics — the bank
is human-owned and the reader can see the site named; the pre-existing alias
resolution that makes `pnpm test` inside `apps/public` fail on `@/` imports;
`data:` URLs pass the parser but are never linked.

## Verification, without spending

- `answers.test.ts`: a stored blob with owned, review, competitor and other
  URLs comes back classified in order, positions kept, a source-less answer as
  an empty list, the rule set named.
- `gaps.test.ts` (server): the report is about the latest cycle's prompts, a
  named day reads that cycle, an earlier-category cycle audits against its
  own bank, no cycle means no fetch, an unreadable page is a named refusal.
- `apps/public/app/api/gaps/route.test.ts`: the stored-cycle bound before any
  request leaves, the throttle on its own ledger after it, a failed read as
  422, host-shape refusals.
- `citations.test.ts`, `gaps.test.ts` (client), `diagnostics.render.test.tsx`:
  the arithmetic by hand, the parser's refusals, and the rendered surface: no
  figure before the reader asks, an interval on every share, the hedges
  printed, the truncation wording, the closing sentence.
- The bundled artefacts were regenerated from the local store and one homepage
  read: 282 citations across 44 of 85 answers; a 17-prompt gap report at 68%
  mean coverage.
- Rendered on both surfaces with both sections opened, and the harnesses
  re-run.
