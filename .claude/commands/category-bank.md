---
description: Generate a prompt bank and competitor set for a new category
argument-hint: <category-slug> [geo] (e.g. india-d2c-skincare in)
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

Build the measurement bank for category **$1** (geo: **$2**, default global).

1. Generate 60–120 candidate prompts spanning the intent mix: discovery
   ("best X for Y"), comparison ("X vs Y"), problem-led ("how do I..."),
   and brand-verification ("is X any good").
2. **Deduplicate against every existing bank** using the normalised prompt hash.
   Report the overlap percentage — high overlap is good news for the cache and
   should be preserved, not designed away.
3. Identify the 5–8 category leaders. These become the pre-loaded head-to-head set
   that makes the 90-second Grader possible.
4. Estimate collection cost: `prompts × engines × runs × cycles × $0.002 × (1 - expected_cache_hit)`.
   Print the number before writing anything.
5. Write to `packages/db/seed/banks/$1.json` and queue the first cycle **behind an
   approval gate** — do not start spending automatically.

Do not invent competitor names. Derive them from actual collected answers or from
a verifiable source, and mark any that are unverified.
