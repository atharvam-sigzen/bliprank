---
description: Scaffold a new answer-surface adapter against the EngineAdapter contract
argument-hint: <engine-slug> (e.g. perplexity, grok, ai-overviews-uk)
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

Create a new Engine Adapter for: **$1**

Delegate to the `measurement-engineer` subagent. Produce, in one change:

1. `services/collector/adapters/$1/client.ts` — implements `EngineAdapter` from
   `packages/contracts`. Do not modify the contract; if it genuinely does not fit,
   stop and propose an ADR instead.
2. `services/collector/adapters/$1/normalise.ts` — maps the provider response to
   the internal `AnswerBody` shape (`text`, `citations`); `collect()` wraps it into
   the self-describing `RawAnswer`. Every field the provider does not supply must
   be `undisclosed`, never a default value.
3. `services/collector/adapters/$1/__fixtures__/` — at least 6 captured responses
   covering: brand present + linked, brand present unlinked, brand absent,
   multi-competitor, empty/refusal, and a malformed payload.
4. `services/collector/adapters/$1/adapter.test.ts` — contract conformance tests
   that run entirely from fixtures. Zero network calls.
5. A **cross-path agreement check** registered in the drift harness, comparing this
   adapter against the existing primary provider on a shared control prompt set.

Then report: projected calls/month and $/month this adds at current and target
volume, and the rate-limit implication for the collection window.
