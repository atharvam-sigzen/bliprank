---
description: Bump the scoring algorithm version with the complete flip list, the pin tables and the changelog row (R5)
argument-hint: "<one-line summary of the rule change>"
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

Bump the scoring algorithm version for: "$1"

This is a rule R5 operation. Historical scores are never mutated: rows are
re-scored forward and the superseded row is kept. Versions are `det-N`, one
integer, no semver. A rule either changes what an existing answer scores or it
does not; if it does not, it is not a bump (the bar for that is in R5 and
ADR-0012).

Steps 1 to 7 read the store or the repo and call nothing. Step 8 runs the
live path with a provider key present and zero calls expected; read it before
running it. Do the steps in order; the first one only works before the rule is
edited.

1. **Snapshot BEFORE touching a rule.**
   `pnpm grader:version-diff -- --snapshot` scores every stored answer under the
   current code and writes `services/grader/data-live/version-snapshots/<current>.json`,
   with the golden set's agreement per field. If the rule edit is already in the
   tree, `git stash` it, snapshot, `git stash pop`; if it is already committed,
   `git checkout <previous-commit> -- services/scorer/src`, snapshot, then
   `git checkout HEAD -- services/scorer/src`. A snapshot taken under the new
   rules is the new rules against themselves and proves nothing. The snapshot
   file is untracked; the flip list you paste into the changelog is the record.

2. **Bump `SCORING_ALGO_VERSION`** in `services/scorer/src/score.ts` to the next
   `det-N`, in the same commit as the rule change.

3. **Pin tables.** `pnpm test services/scorer` now fails the lookup in
   `algo-version-pin.test.ts` and `source-class-pin.test.ts`. Copy each
   `PINNED[...]` block (and `PINNED_TABLES`) under the new key and change only
   the rows the rule flips. Each changed row is a sentence of the changelog. A
   row you had to change that "$1" does not explain is a second rule change, or
   a bug: stop and say which.

   To see the golden set on its own at any time: `pnpm grader:version-diff -- --golden`
   prints every field's agreement, every disagreement, and the gate verdict.

4. **The flip list.** `pnpm grader:version-diff -- --against <previous>` scores
   every stored answer under the new code and prints every row that differs, by
   field, and the golden agreement old against new. Report all of it, verbatim.
   The list is complete by construction: every stored cycle, every answer,
   every row field a rule can move (mention, count, brands detected, cited and
   where, position, competitors, every citation's domain and class). The golden
   set holds 7 of its 300 target cases,
   so its G2 gate is NOT RUN; its agreement is reported, not gated.

5. **Stop if** any golden field regressed, or any flipped row is not explained
   by "$1". Report and do not proceed.

6. **Changelog row** in `docs/METHODOLOGY.md`: the table under "Changelog", and
   the version stamp in the page header. Plain language, customer-facing: what
   changed, whose number can move and in which direction, the flip counts from
   step 4, and that `compare()` refuses across the boundary.

7. **The version boundary is mechanical**, not generated. `compare()` refuses
   across versions, the workspace record says "scored by different versions",
   and the trend chart breaks its line. `pnpm test apps/public/lib/cycles`
   covers it. Nothing to write.

8. **Re-score forward.** `pnpm grader:rescore -- --all` (dry run) lists every
   cycle and checks every cell against the answer index first; a cycle with one
   miss is refused, not bought. `--apply` then re-derives the free ones through
   the live path, which needs a provider key present and is expected to make
   zero calls; if a call happens anyway the tool says so and leaves the file
   unchanged. Each superseded row is kept as `<file>.<old>.audit.json`
   (`<file>.<old>.2.audit.json` for a second supersession). Expected cost $0.
   Then regenerate the bundled evidence the public app serves:
   `pnpm grader:answers -- --domain pipedrive.com --out apps/public/public/scan-answers.json`.

9. **ADR** when the change is structural: a new citation class, a registry
   wired, a signal added. ADR-0012 and ADR-0015 are the shape.

End with `⚠️ HUMAN REVIEW REQUIRED: scoring algorithm — "$1"; <n> rows flipped
across <k> cycles; golden <fields that moved>` and invoke `stats-reviewer`.
