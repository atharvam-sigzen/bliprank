# ADR-0009 — Classify from site content; grow the taxonomy from real usage

**Status:** Accepted · **Date:** 2026-09-01 · **Phase:** P3
**Relates to:** PHASES 3.1, 3.2 · ADR-0008 (demo taxonomy) · R1 (deterministic
scoring) · R3 (spend control) · R5 (immutable, version-stamped) · R8 (provenance
travels with the number) · `/category-bank`

## Context

ADR-0008 created fourteen hand-authored categories plus a keyword-free fallback,
classified by whole-token matching against the **hostname**. PHASES 3.1 named
three input signals — site content, autocomplete, contacts enrichment — and
recorded that none of them was built.

The consequence was measurable rather than theoretical. Running the classifier
over real domains:

| Domain | Host-only answer |
|---|---|
| `pipedrive.com` | `crm-software` — it is a listed leader |
| `my-crm.io` | `crm-software` — the token is in the host |
| `nike.com` | unclassified |
| `stripe.com` | unclassified |
| `sigzen.com` | unclassified |
| `bliprank.com` | unclassified |

Everything whose name is not its category came back unclassified and was scanned
against the general bank: a real mention rate, against prompts nobody in that
market would type, with no competitor set. G3 asks for **≥95% of 100 random real
domains classified correctly**, and five hostname tokens cannot approach it.

Two problems, and fixing either alone leaves the product broken:

1. **No content signal.** The classifier could not see the page.
2. **A fourteen-category output space.** Even a perfect content classifier has
   nowhere to put a gaming-peripherals company or an ERP consultancy. PHASES 3.2
   plans 200 pre-computed banks; a plan that turns away the 201st visitor is not
   a plan, and 200 is not a ceiling anyone chose, it is a number in a document.

## Decision

### 1. A deterministic site-content signal — no model call

`packages/taxonomy/classify-content.ts` scores the page's own text against a
per-category `contentKeywords` vocabulary, weighted by zone (title 6,
description 4, headings 3, body 1).

**No model, and the reason is not R1's cost argument.** A Haiku classification is
~$0.0002 against a $0.18 scan; cost would not decide this. The reason is the one
`classify-domain.ts` already gives: the category picks the prompt bank, which
picks `comparison_basis`. A classifier that can answer differently on two runs
makes the thing a number is a measurement OF move underneath the customer, which
is the change `compare()` exists to refuse.

Three rules, each from a specific way the naive version is wrong:

- **Distinct phrases, not total hits**, each phrase capped. A page saying
  "support" forty times is not a help desk.
- **A margin over the runner-up**, or the answer is `ambiguous`. Every SaaS
  homepage names its integrations; winning by a nose is noise.
- **The evidence must appear in the page's self-description** — its `<title>` or
  a meta description. Body text can strengthen a category and can never select
  one.

The third rule was added because of a real wrong answer, and it is worth
recording in full. `sigzen.com` is an ERPNext implementation consultancy. Its
title and meta description say exactly that. Its body, being a list of the ERP
modules it implements, says `crm` twenty-one times, `lead management` three
times and `sales pipeline` once — scoring 18 against a floor of 8, with five
distinct phrases and a clear margin. A confident, well-evidenced, completely
wrong answer, which would then have silently decided what every number for that
customer was a measurement of. Title and description are where a business
describes *itself*; everything else is evidence about what it *touches*.

### 2. One outbound fetch, behind an explicit SSRF boundary

`services/grader/fetch-site.ts`. `classify-domain.ts` named this as the reason
the signal was never built — "a server-side fetch of a user-supplied domain and
carries an SSRF surface that needs its own design before it is built" — and this
module is that design. Five refusals, none redundant with the others:

1. Scheme, port and credential shape.
2. Every resolved address checked against the private, loopback, link-local,
   CGNAT, multicast and reserved ranges, in v4, v6 and v4-mapped-v6. A name-based
   deny-list is not a substitute; `localtest.me` resolves to 127.0.0.1.
3. The connection is pinned to the **validated address**, with the hostname kept
   for `Host` and SNI, so there is no second resolution to rebind.
4. Every redirect hop re-checked, hop-capped, no cookies, no referrer.
5. Body size and total time bounded.

If *any* address a name resolves to is internal, the name is refused outright —
picking the public one leaves the internal one for a later resolution to choose.

### 3. When nothing fits, author a category — and never its competitors

`services/grader/resolve-category.ts`, rung 4. A domain no category fits gets one
written for it from its homepage's own words, persisted, and reused by every
later domain in that market.

**⚠️ A generated category has `leaders: []`, always.** This is the hard
constraint, and it is enforced three times over rather than trusted:

- the tool schema the model answers **has no field for a competitor**;
- `leaders: []` is constructed in our code, not taken from the response;
- `readGeneratedBanks` **drops** a bank file that has acquired any, so a
  hand-edited file cannot put invented rivals on a chart either.

> **Amendment 1 weakens the first of those three and nothing else.** A provider
> answering with open JSON has no schema to constrain it and can volunteer a
> `competitors` array. The parser reads three keys and ignores every other one,
> so the field reaches nothing; the second and third refusals are untouched. See
> Amendment 1 → "The competitor rule survives a looser provider".
>
> **Amendment 2 adds a fourth, guarding a different door.** All three above watch
> the `leaders` field. A rival can also arrive through the prompt **text** — "how
> does this compare to Salesforce" — which none of them looks at. A generated bank
> naming any brand already tracked anywhere in the taxonomy is now discarded
> whole. See Amendment 2.

This is the rule the fallback bank already follows and the rule `/category-bank`
states: do not invent competitor names; derive them from collected answers or a
verifiable source. A model asked to name the leaders in a category will always
produce five plausible ones, and a rival on a chart that nobody measured against
anything is precisely the failure this product is positioned against. Real
competitors may only ever arrive later, from brands the engines actually named in
answers we actually collected.

What *is* generated is the prompt set. Every generated prompt is `discovery` or
`problem-led` — the intents that name no brand — the bank is stamped
`verified: false`, and a bank whose prompts name the subject's own domain label
is refused whole rather than filtered, because a bank that lost three prompts to
filtering is a different sample size from every other bank.

The model is `claude-sonnet-5`, per CLAUDE.md §6's "customer-facing generation".
**Superseded by Amendment 1:** the model is now chosen by `BANK_AUTHOR_MODEL`,
defaulting to `nvidia/nemotron-3-super-120b-a12b:free` on OpenRouter with
`minimax/minimax-m3:free` behind it. Anthropic remains a selectable provider.
The reasoning below is unaffected.

This does not violate R2 (batch what can batch): R2 governs **scoring**, which is
high-volume and latency-insensitive. This is a one-off authoring step on an
interactive path, with nothing to batch it against, and it runs **at most once per
category for the lifetime of the taxonomy**.

### 4. A domain's category is decided once and kept

`recordCategory` **refuses to overwrite** an existing record. The refusal is the
guarantee — not a convention someone has to remember.

`classify-domain.ts` gets determinism from being pure. This layer cannot: it
reads a live homepage, and a homepage is rewritten on Tuesdays. So determinism is
achieved by writing the answer down. A site that relaunches into a different
market does not silently become a different category and invalidate its own
history; changing it is an explicit act, with the version bump that implies —
the same discipline R5 applies to score rows.

The decision carries `source`, `evidence` and `decidedAt`, so a surprising
category is explainable years later. Reading it back does **not** change
`source`; whether a given call read it is `fromRecord`, a separate field.
Provenance is about the decision, freshness about the lookup, and collapsing them
loses the one a reader wants first.

### 5. The prompts are shown before the scan is bought

`/api/preview` resolves the category and returns the exact prompts a scan would
send, spending no provider quota. The scan runs only on a second, deliberate
press.

Two reasons, both load-bearing. **For the reader:** the category *is* the
measurement, and someone who disagrees with it should find out before the number
is drawn — R8's provenance rule applied one step earlier, to the thing the number
is about. **For the quota:** this is the confirmation step three separate comments
in this repo lament the absence of. A fat-fingered paste now costs one bounded
homepage fetch instead of seventeen requests on five engines.

The preview endpoint has its **own** rate limit against its **own** ledger. It
spends no provider quota, so `checkGate` does not govern it — which is exactly
why it needs a limit of its own: an unthrottled endpoint that fetches an
arbitrary URL on request is an amplifier pointed at whoever the caller names. A
separate ledger, because sharing the scan counter would make looking at your
prompts cost you a scan.

## Consequences

**Good.**

- Real businesses get real prompt banks. `sigzen.com` gets an ERP-implementation
  bank rather than fourteen CRM questions or a generic one.
- The taxonomy grows from usage instead of needing to be exhaustively
  pre-authored, and PHASES 3.2's 200 banks stop being a ceiling.
- The spend path gained a confirmation step it never had.
- Every screen agrees about a domain's category, because there is now one
  decision and every surface reads it.

**Costs, accepted.**

- **A vendor whose title is only its brand name falls through to an authored
  category** rather than a hand-authored one. This is the better failure: a
  business in nobody else's category gets a bank from its own words; a business
  in the *wrong* category gets a competitor set it does not compete with.
- **An authored bank is unreviewed.** It is marked `verified: false` everywhere
  it appears, including on the Grader before the scan is bought.
- **An authored category has no competitor set**, so its scans have no
  head-to-head. Stated on the preview, before the button.
- **The record store is a JSON file**, single-process. Two concurrent
  first-scans of one brand-new domain can both derive it; both derive the same
  answer from the same signals, so the loss is one wasted fetch. When accounts
  exist this becomes a table with the same two columns and the same write-once
  rule (`INSERT ... ON CONFLICT DO NOTHING`).
- **The thresholds are set from six real homepages, not from a labelled set.**
  See below.

## Open, and blocking G3

`MIN_SCORE`, `MIN_DISTINCT`, `MIN_MARGIN` and `MIN_SELF_DESCRIPTION_HITS` were
chosen against six real homepages and one specific wrong answer. G3's ≥95%
criterion is measured against 100 random real domains, and **these numbers have
not been measured against that sample.** They are arguable from examples, which
is not the same thing. Building that sample is the next piece of PHASES 3.1, and
it is what closes G3 rather than this ADR.

The production taxonomy questions ADR-0008 left open stay open. This ADR does not
answer where the vocabulary comes from or what granularity 200 banks implies — it
makes the taxonomy able to grow, which is a different question and a smaller one.


---

# Amendment 1 — the bank author is a swappable provider

**Status:** Accepted · **Date:** 2026-09-01

## Context

Section 3 above named `claude-sonnet-5` in code, per CLAUDE.md §6. Two things
argue against a model chosen in a source file:

- The authoring models worth using here are free tiers, and free tiers get
  rate-limited, deprecated and withdrawn — usually at the least convenient
  moment. The response to that must be an edit to `.env.local`, not a deploy.
- Authoring is the one step in this pipeline whose correctness rests on the model
  staying inside a shape. Which model does that best is an empirical question
  that will have a different answer in six months, and a codebase should not have
  to be edited to record a new answer.

## Decision

`services/grader/src/bank-author.ts`. One `BankAuthorConfig`, built from the
environment by `bankAuthorConfig()`, behind which sit two transports:
`openai-compatible` (default) and `anthropic`.

**Default: `nvidia/nemotron-3-super-120b-a12b:free`, via OpenRouter, falling back
to `minimax/minimax-m3:free`.** OpenRouter rather than Nvidia's API
directly, and it is the *simpler* option here rather than the more capable: the
`vendor/model:free` slugs are OpenRouter's own addressing scheme, one key reaches
both named models and whatever replaces them, and the wire format is the OpenAI
chat-completions shape essentially every host speaks — including Nvidia's own NIM
endpoint, which `BANK_AUTHOR_BASE_URL` reaches with no code change.

Swapping a model is `BANK_AUTHOR_MODEL`. Swapping provider is
`BANK_AUTHOR_PROVIDER`. Both are single env vars, which was the requirement.

The Anthropic path is kept rather than deleted: CLAUDE.md §6 names Sonnet 5 for
customer-facing generation, the SDK is already a dependency, and a seam with one
implementation behind it is not a seam.

### No `response_format`, and the parser carries the weight

Sending `response_format: {type: 'json_object'}` is the textbook way to ask for
JSON and is a trap on a fleet of free models: a host that does not support it for
the chosen model answers 400, which is indistinguishable from "the model is
down". The configured model would then silently never run, the fallback would
answer every request, and nobody would be told that the model they chose was not
the one being used.

So the request asks for JSON in words, and `extractJsonObject` survives what
models actually return — a fenced block, a preamble, a trailing apology — tracking
string literals so a brace inside a prompt cannot close the object early.
Defensive parsing is needed regardless of the flag, so the flag buys nothing and
costs a whole failure mode.

### The fallback chain

One attempt per model, no backoff. A person is waiting on a preview, and a second
attempt at a model that just rate-limited is a second wait for the same answer.
**The fallback model is the retry, and it is a retry that changes something.**

A schema refusal counts as a failure and moves to the fallback: *unreliable* and
*unavailable* are the same event from here, and a model answering confidently in
the wrong shape is the worse of the two.

`authorBank` **never throws**. Every failure — network, timeout, HTTP error,
unparseable output, a shape that does not survive `parseCandidate` — returns
null, which `resolveCategory` reads as "no bank was authored" and answers with
the general bucket. That is byte-for-byte the path taken when no key is
configured at all, so a flaky free model and an unconfigured one reach the
customer as one outcome rather than two.

### ⚠️ The competitor rule survives a looser provider

This is the part that mattered when choosing a provider, and it is the part that
does **not** depend on choosing well.

With the Anthropic tool schema, "no competitors" was *structural*: the schema had
no such field. A free model answering with open JSON can put
`"competitors": ["Razer", "Logitech"]` in the object, and some will — homepages
are full of rivals and being helpful is what these models do.

That changes nothing, because the enforcement was never the schema alone:

1. `parseCandidate` reads exactly `display_name`, `description` and `prompts`,
   and ignores every other key. `GeneratedBank` has nowhere to put a competitor,
   so there is no later step that could be forgotten.
2. `resolve-category.ts` constructs `leaders: []` itself, from nothing.
3. `readGeneratedBanks` **drops** a stored bank that has acquired leaders, so a
   hand-edited file cannot reintroduce them either.

Three independent refusals. Tested by feeding a response carrying `competitors`,
`leaders`, `brands` and `market_leaders` through the shipping author and
asserting that none of those names appears anywhere in the bank or in the file
written to disk.

### Provenance

The model that answered goes on the record — `evidence` reads "authored from
acmegear.com's homepage by nvidia/nemotron-3-super-120b-a12b:free" — and into the
stored bank's `note`. A category authored by a free tier in September and one
authored by Sonnet in December are different artefacts, and a reader looking at a
surprising bank two years from now should be able to see which produced it. Same
discipline as R8's `algo_version` travelling with a metric.

## Consequences

- Swapping a rate-limited free tier is one line in `.env.local`.
- `verified: false` matters more than it did. A weaker model authoring an
  unreviewed bank is exactly what that flag is for, and it is shown on the
  Grader before the scan is bought.
- Determinism is unchanged where it counts. The sampler is not reproducible on a
  shared free endpoint whatever `temperature` says — batching and routing see to
  that — but the answer is written down once and reused forever, so the
  reproducibility the metric contract needs is the **record's**, not the
  sampler's.
### Measured on 2026-09-01, against the real task

`meta-llama/llama-3.3-70b-instruct:free` — the fallback this amendment originally
named — **does not exist**. OpenRouter answers 404: "This model is unavailable for
free." It was recalled, not looked up, and it could never have run. Corrected by
querying `/api/v1/models` and then testing the candidates on the real authoring
task rather than choosing from the list on paper:

| Model | Result |
|---|---|
| `nvidia/nemotron-3-super-120b-a12b:free` | timed out past 40s under load; succeeded in 17s when not |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | timed out past 40s |
| `google/gemma-4-31b-it:free` | 429, "temporarily rate-limited upstream" |
| `z-ai/glm-5.2:free` | 429, same |
| `minimax/minimax-m3:free` | **valid bank in ~8s** |

The first real failure the chain saw in anger was `Upstream error from Nvidia:
Service temporarily overloaded` — a **vendor-side** outage, not a model-side one.
So the fallback is deliberately a different vendor: a same-vendor fallback is the
same outage twice, with the second copy costing another timeout before anyone is
told.

The primary stays Nemotron. That ranking will be wrong within weeks, which is the
entire reason it is an env var and not a constant.

End to end on `sigzen.com`, the domain that motivated this ADR: Nemotron authored
**"ERP Implementation Services"** — the correct market, which no hand-authored
category held — with 17 prompts, `leaders: []`, `verified: false`, and the model
recorded in `evidence`.

### Observed: the schema holds, the prose rules bend

Those 17 prompts name `ERPNext` and `Frappe`. That is the authoring system's
rule 1 ("NEVER name a company, brand, product or vendor") being bent, and
`rejectionReason` did not catch it — it checks the subject's own domain label,
and `sigzen` correctly does not appear.

Arguably correct in this instance: ERPNext is the *platform the market is defined
by*, the way "WordPress hosting" is a real category, and it is neither the subject
nor a competitor of it. But it pointed at a check that was worth building — and it
is now built. See Amendment 2.

- **Still unmeasured:** how reliably any of these models stays inside the shape.
  The refusals above mean an unreliable model degrades to the general bucket
  rather than producing something wrong, so the cost of being wrong about this is
  bounded — but the rate is not known, and a bank whose prompts quietly name a
  rival is not something `rejectionReason` can detect.


---

# Amendment 2 — a fourth refusal: no prompt may name a brand we already track

**Status:** Accepted · **Date:** 2026-09-01

## Context

Amendment 1 recorded a gap that the first live run made concrete. `rejectionReason`
checked whether a generated prompt named **the subject** — and nothing else. A bank
authored for one domain could name somebody *else's* tracked brand and pass every
refusal, because the three refusals that guard `leaders` look at the `leaders`
field, and this arrives through the prompt **text**.

## Decision

A fourth refusal. A generated bank is discarded whole if any of its prompts names
a brand already tracked as a leader anywhere in the taxonomy — all 113 of them,
across every bank, not just the subject's own.

### Two distinct harms, and they are worth separating

**Measurement.** Every prompt a scan sends is `discovery` or `problem-led`
precisely so that it names no brand (`scan.ts` PROPERTY 2). A prompt naming HubSpot
guarantees HubSpot a mention in the answer — and HubSpot's mention rate is a number
this product publishes, as a leader of `crm-software`. So an authored bank could
silently move a *tracked brand's* number by asking about it. Share of voice has to
be unprompted or it is not share of voice, and that holds for every brand in the
answer, not only for the one being graded.

**Honesty.** `/category-bank`'s do-not-invent rule exists so a rival never appears
beside a number nobody measured them against. A generated prompt reading "how does
this compare to Salesforce" reintroduces exactly that, through the prompt text
instead of through `leaders`.

### Matched with the scorer's own matcher

`namesTrackedBrand` calls `findMentions` from `@bliprank/scorer` — the same
function that decides whether a brand counts as mentioned in a collected answer.
The refusal and the measurement therefore share **one** definition of "this text
names that brand", including the whole-token boundaries that stop `Zoho1` matching
`Zoho`, the NFKC folding, the URL masking and the longest-match-wins overlap rule.
A hand-rolled `includes()` would have been a second definition, and two definitions
drift in the direction that lets something through.

### The list is what makes it safe, and its limits are the design

It refuses only brands **already on file**. `ERPNext` and `Frappe` are in no leader
table, so an ERP-implementation bank may name them — correctly, because they are the
platform the market is defined *by* and naming one is not naming a rival. Nothing
here attempts to detect brands in general: that is not a decidable check, and a
heuristic that guessed would refuse good banks for imagined reasons.

A partial guard, deliberately, over the subset that *is* decidable — and it is the
subset that matters, because the brands whose mention rates we publish are exactly
the brands a prompt must not conjure.

## ⚠️ It surfaced a pre-existing scoring defect, and that is the bigger finding

Building this required enumerating every leader alias, which made five collisions
visible:

| Leader | Bare alias | Ordinary English that matches it |
|---|---|---|
| Wave | `Wave` | "we saw a **wave** of interest from buyers" |
| Sage | `Sage` | "**sage** advice from an accountant" |
| Notion | `Notion` | "the **notion** that this is simple" |
| Asana | `Asana` | "an **asana** pose between meetings" |
| Close | `Close` | "how do we speed up our monthly **close**" |

`Close` is the worst: *monthly close* is accounting vocabulary, in a taxonomy that
has an accounting-software category.

**The cost is not primarily in this refusal.** `findMentions` is what sets
`mentioned` in `scoreAnswer`, so a **collected answer** containing "a wave of
interest" already counts as a mention of Wave — inflating a published mention rate
and its Wilson interval. That is true today, independently of anything in this
amendment; enumerating the aliases is simply what made it visible.

The taxonomy's own docblock warns about precisely this failure and names the case
it *did* catch: "an alias must be a form a human would write — `monday.com`, never
a bare `monday`, which collides with the weekday." These five were missed.

**Not fixed here.** Editing leader aliases changes what every historical and future
number means, and the scoring rule set is human-owned (CLAUDE.md §4). It is
reported, pinned by a test so the count cannot drift unnoticed, and left for a
human. The consequence for *this* refusal is a false refusal, which degrades to the
general bucket — safe direction, real cost.

## Consequences

- A generated bank naming a tracked brand degrades to the general bucket, exactly
  as an unreachable model does. Tested end to end, and nothing is written to disk.
- `rejectionReason` takes a third argument, defaulting to `[]`, so a two-argument
  call is still valid and still means "no tracked-brand check" — asserted, so the
  default cannot become a silent no-op nobody notices.
- Five leaders will falsely trigger it until their aliases are tightened.

---

# Amendment 3 — where a generated category's competitors finally come from

**Status:** Accepted · **Date:** 2026-09-02 · **Phase:** P3

## Context

Section 3 above states the rule twice and builds only half of it:

> "Real competitors may only ever arrive later, from brands the engines actually
> named in answers we actually collected."

The refusal half was built and enforced three times over. The **arrival** half was
never designed, so `leaders: []` was not a starting state — it was permanent. A
customer correctly placed in an authored category saw "there is no comparison on
this scan" on every screen, forever, while the answers already bought for them
named six competing products by name. One collected ChatGPT answer for
`ERP solution for jewellery business with retail POS` lists Ornexa, Akrut
Jewellery ERP, Gehna ERP, Aurex ERP, 24KaratSolutions and Jewellers Pro — in a
comparison table, with a ranked shortlist under it.

The evidence was on disk. Nothing could read it.

## Decision

`services/grader/src/promote-competitors.ts`, plus a runner,
`pnpm grader:promote`. It reads the stored answers for a category's own prompts
and proposes competitors, each carrying the answers it was learned from.

### It is deterministic, and the reason is not cost

R1 names competitor detection as deterministic-first. Asking a model "which of
these strings are product names" would cost about $0.0002, so cost decides
nothing here. What decides it is the argument the content classifier already
makes: the competitor set determines `position`, `position` determines the
preview score, and the score is on the sheet. A set that can answer differently
on two runs over one corpus makes the number non-reproducible.

So extraction is markdown shape and arithmetic — bold spans, headings, and the
first column of a comparison table, the three shapes an engine uses to list
products whatever the category is. It is a heuristic, it is labelled one
everywhere it surfaces, and it is not what makes the mechanism safe.

### Two classes of candidate, not one

- **`tracked`** — a brand already in a leader table somewhere in the taxonomy,
  found with `findMentions`: the *same* matcher that decides whether a brand
  counts as mentioned in a scored answer, so the proposal and the measurement
  share one definition of "this text names that brand". It brings a reviewed
  alias set with it, and it inherits Amendment 2's recorded defect — `Close`,
  `Wave`, `Sage`, `Notion` and `Asana` are ordinary English words in the alias
  tables today.
- **`extracted`** — a name nothing tracks yet. No alias set exists, so the alias
  is the name.

### What makes it safe is the bar and the human, not the extractor

Three counts, all of which must clear: **at least 3 distinct answers, at least 2
distinct prompts, at least 2 distinct engines.**

The engine count is the load-bearing one. A single engine inventing a plausible
product name is fluent and repeatable, and will clear an answer count and a
prompt count on its own. Two engines are separate systems over separate indexes.

Measured on the real committed corpus, `erp-software`, 50 collected answers:

| Cleared the bar | Below it |
|---|---|
| Odoo, QuickBooks, ERPNext, Xero, Microsoft Dynamics 365, Salesforce, Shopify, SAP Business One | "My recommendation" (3 answers, 3 prompts, **1 engine**), "Best overall", "My shortlist", "Strong options to evaluate", "Software", "ERP Platform" |

Every name that cleared is a real product. Every phrase that did not is an
engine's own house style, recurring inside one engine. That is the bar working,
and it is also the whole of the evidence for it: these thresholds have not been
measured against a labelled set, exactly as this ADR's own classifier thresholds
have not.

And on `gaming-peripherals-india`, also 50 answers: **nothing clears**, because
the engines name specific SKUs rather than brands and each appears once. An empty
result is the honest one, and the mechanism produces it rather than lowering its
own bar to have something to show.

### `--apply` is a human act, and the default is a dry run

CLAUDE.md §4 puts the scoring rule set on the human side of the line, and a
competitor set is part of it. Nor can any threshold separate "Shopify was named
as a competitor" from "Shopify was named as an integration" — the real corpus
contains the second, in the words *"Connect online platforms like Shopify or
WooCommerce for seamless omni-channel management"*, and it cleared the bar. A
person reading the excerpt sees it immediately.

So the report prints, per candidate: how it was found, the alias that matched,
the three counts, and a quoted excerpt — including everything that fell *below*
the bar, because a silent cut reads as "there was nothing else". Nothing is
written without `--apply`. The dry run spends nothing and reaches no network, so
it is free to run as often as anyone likes, which is why it is the default.

### It is stored beside the bank, not in it

ADR-0009's third refusal is that `readGeneratedBanks` **drops** a generated bank
file that has acquired leaders. That refusal is unchanged and unweakened —
writing promoted leaders into the bank file would have required switching off the
check standing in the way, and "the check is off for the good writes" is not a
check.

Promotion writes `data-live/promoted-competitors/<slug>.json` and the merge
happens on read. Every entry must carry its evidence, re-checked on read exactly
as `leaders` is re-checked on the bank file, so a hand-written entry with no
evidence is dropped. **A leader therefore reaches a chart by exactly one route,
and it is the route that cannot be walked without collected answers behind it.**

### `domains: []`, always

`Leader.domains` is the citation-attribution list, and its own docblock is
emphatic that it is deliberately narrow because a wrong entry credits somebody
else's citation to this brand. A promoted name was learned from prose, and prose
cites nothing; deriving `ornexa.com` from "Ornexa" is precisely the invention
this module exists to refuse, and ADR-0005 already declines to bucket an unknown
citation. A promoted competitor is comparable on mentions and silent on
citations. Forced empty on write *and* on read.

### The bank version moves with the competitor set

`comparisonBasisFor` stamps `slug@version` into every metric's
`comparison_basis`. Adding competitors changes `position`, which changes the
preview score, so a scan run before promotion and one run after are not
measurements of the same thing. The version bump is what makes `compare()` refuse
them instead of reporting the difference as movement — R5's discipline, applied
to the competitor set.

## Consequences

**Good.**

- The rule this ADR wrote down is now the rule the code implements, both halves.
- A competitor on a chart carries the answers it was learned from, which is
  something no competing tool in this category can say about its own.
- Promoted brands join `trackedBrands`, so Amendment 2's fourth refusal covers
  them automatically: no future authored bank may name one in a prompt.

**Costs, accepted.**

- **The extractor is a heuristic and will propose noise.** Bounded by the bar,
  the printed excerpts and the human gate. A wrong promotion is visible in the
  file and reversible by editing it, with the version bump that implies.
- **A promoted `tracked` candidate can be a real string match and a nonsense
  competitor at once**, until the five colliding aliases Amendment 2 reported are
  tightened. Still human-owned, still unfixed here.
- **An existing scan keeps its own basis until the domain is re-scanned.** The
  `/api/scan` result cache keys on the category slug, not the version, so a
  customer measured under `@1` continues to see their `@1` result. Correct under
  R5 — and it means promotion does not retroactively alter a record already
  published. Re-scanning costs a scan, which is the customer's call.
- **Nothing has been promoted.** The mechanism ships dry, and a test asserts that
  `data-live` holds no promotion file — so the first one cannot arrive without a
  human editing that test alongside it.

⚠️ **HUMAN REVIEW REQUIRED — the competitor set for `erp-software`.** The dry run
proposes eight names. Six are unambiguous. `Shopify` reads as an integration
rather than a rival in its own excerpt, and `ERPNext` is the platform
`sigzen.com` implements rather than a competitor of it — the same distinction
Amendment 1 drew when it allowed an ERP bank to name ERPNext. Both are judgement
calls about a market, which is not a call this code is allowed to make.

---

# Amendment 3, addendum — the first promotion, and the distinction the bar cannot make

**Status:** Accepted · **Date:** 2026-09-02

## What was promoted

An operator read the dry run for `erp-software` and approved six of the eight
names that cleared the bar:

**Odoo · QuickBooks · Xero · Microsoft Dynamics 365 · Salesforce · SAP Business One**

`erp-software` moved to `@2`. `gaming-peripherals-india` still has nothing
promoted, because nothing clears the bar there.

## What was refused, and why it matters more than what was promoted

Two names cleared the arithmetic and were wrong about the market:

| Refused | Its own evidence | Why it is not a rival |
|---|---|---|
| `Shopify` | *"Connect online platforms like Shopify or WooCommerce for seamless omni-channel management"* | Named as an **integration** the ERP connects to. |
| `ERPNext` | *"### 1. ERPNext — my first choice"* | The **platform** sigzen.com implements. Amendment 1 already drew this line when it allowed an ERP bank to name ERPNext. |

Both were named by real engines, in real answers, repeatedly, across engines.
Every count was honest. The counts were simply not the question.

## ⚠️ The known limitation: mentioned-as-a-rival vs mentioned-as-an-adjacent-thing

The evidence bar counts **whether** a name was said. It has no representation at
all for **how** it was said, and at least three distinct relationships collapse
into the same three integers:

- **rival** — the thing a buyer would choose instead ("Odoo or SAP Business One")
- **integration** — the thing it connects to ("connect Shopify to your ERP")
- **platform or substrate** — the thing it is built on or implements ("ERPNext
  partner", "WordPress hosting")

A brand in any of those three appears in the same answers, in the same bold
spans and comparison tables, with the same recurrence across engines. No
threshold on answers, prompts or engines separates them, and raising the bar
does not help: `Shopify` cleared on three engines, more than several genuine
rivals did.

**Not being fixed now, deliberately.** The cheap-looking fixes are all worse
than the human gate:

- *An LLM classifying the relationship* breaks R1. The competitor set decides
  `position`, `position` decides the preview score, and a set that can answer
  differently on two runs over one corpus is not reproducible.
- *Cue phrases* ("integrates with", "connect", "built on") are a keyword list
  against free prose, and would refuse a genuine rival any time an answer
  happened to mention integrating with it — which good ERP answers do constantly.
- *Requiring the name to appear in a comparison table* helps for one answer
  shape and fails for the prose shortlists that make up most of the corpus.

The honest shape of a fix, whenever this is revisited at scale, is probably
**positional rather than lexical**: the same first-appearance offsets
`scoreAnswer` already computes, asking whether the candidate sits in the same
enumeration as the other candidates or off in a supporting clause. That is a
deterministic signal over structure we already extract, which is the only kind
of signal allowed on this path. It is a real piece of work and it needs its own
evidence, not a guess.

**Until then the design holds because the gate is a person.** The dry run is
free, prints the matched alias and a quoted excerpt for every candidate, and
writes nothing. A refusal is recorded in the store (`excluded`) rather than
living in the operator's shell history, so the same wrong candidate is not
re-proposed on the next run over the same corpus — and `--exclude` is retroactive,
so a promotion that turns out wrong is removed by naming it, with the version
bump that implies.

**The cost of this limitation scales with categories, not with corpus size.**
One judgement call per category is affordable; it is the thing to watch when the
taxonomy has two hundred of them.
