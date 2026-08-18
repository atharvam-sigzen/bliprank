---
description: Bump the scoring algorithm version with changelog and golden-set diff
argument-hint: <major|minor|patch> "<one-line summary>"
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

Bump the scoring algorithm version: **$1** — "$2"

This is a rule R5 operation. Historical scores are never mutated.

1. Bump the version in `services/scorer/version.ts`.
2. Run the golden set (300–500 hand-labelled answers) against **both** the previous
   and new versions. Report:
   - agreement rate old vs new, overall and per signal
   - every answer where the classification flipped, with the reason
   - whether agreement against the human labels improved or regressed
3. If agreement against human labels **regressed**, stop. Report and do not proceed.
4. Write the public changelog entry to `docs/METHODOLOGY.md` — this page is
   customer-facing and is the differentiator. Plain language, no jargon.
5. Generate the in-app version-boundary notice so charts show a discontinuity
   rather than a smooth line across the change.
6. Produce a backfill plan **with a cost estimate**. Do not execute it.

End with `⚠️ HUMAN REVIEW REQUIRED: scoring algorithm` and invoke `stats-reviewer`.
