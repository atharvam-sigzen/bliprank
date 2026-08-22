# ADR-0001 — Engine Adapter abstraction with a second provider stubbed

**Status:** Accepted · **Date:** 2026-08-18 · **Phase:** P0

## Context

All five answer surfaces are reachable through a single OpenWeb Ninja subscription
at $0.002/call. That is roughly a 90% cost advantage over building direct
integrations, and it is what makes statistically honest measurement viable at a $49
price point.

But OpenWeb Ninja describes its ChatGPT, Gemini and Copilot endpoints as
**unofficial**, powered by its own scraping infrastructure. Two consequences:

1. **Technical risk.** Anti-scraping changes or a terms action could disrupt
   collection for three of five surfaces.
2. **Positioning risk.** A platform whose differentiator is methodological
   transparency cannot be vague about provenance.

Note that this is not fringe: reviewers report Peec AI also reads results from AI
tool interfaces rather than relying solely on official APIs, and Peec is at $10M
ARR. The category runs on this. The exposure is asymmetric for us specifically
because we sell integrity.

## Decision

1. All collection goes through an internal `EngineAdapter` interface. Application
   code never calls a provider directly.
2. OpenWeb Ninja is implementation #1. **A second provider is stubbed against the
   same contract before launch** — the abstraction must be proven, not theoretical.
3. `collectionPath` is a required field on every adapter (`official-api` |
   `third-party-grounded`) and is **published** in `docs/METHODOLOGY.md`.
4. The PRD constraint "official APIs only" is replaced with: *every engine surface
   must have a documented, disclosed collection path, and no metric may be
   published without its collection path visible.* That is a stronger constraint
   and one we can actually keep.
5. A weekly cross-path agreement monitor runs a control prompt set through primary
   and alternate paths and publishes the agreement rate.
6. An Enterprise "Verified Sources" tier will offer measurement restricted to
   first-party APIs and licensed SERP data, at lower engine coverage and higher price.

## Consequences

**Positive.** Provider risk is contained to one module. Disclosure becomes a proof
point rather than a liability. The agreement monitor surfaces drift before
customers do. The constraint turns into a premium SKU.

**Negative.** Roughly two weeks of upfront work with no visible product output. The
stub must be maintained. Publishing collection paths invites questions competitors
avoid — which we judge to be a feature.
