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
`meta-llama/llama-3.3-70b-instruct:free` behind it. Anthropic remains a
selectable provider. The reasoning below is unaffected.

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
to `meta-llama/llama-3.3-70b-instruct:free`.** OpenRouter rather than Nvidia's API
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
- **Still unmeasured:** how reliably any of these models stays inside the shape.
  The refusals above mean an unreliable model degrades to the general bucket
  rather than producing something wrong, so the cost of being wrong about this is
  bounded — but the rate is not known, and a bank whose prompts quietly name a
  rival is not something `rejectionReason` can detect.
